/**
 * LXC 驱动 —— 通过 root helper 的 unix socket 说话。
 *
 * 为什么不是直接 execFile('lxc-ls')：DSH 进程是 CapEff=0 + NoNewPrivs=1，
 * lxc 全部要 root。helper（dsh-lxcd.service）是唯一有权限的那半边。
 *
 * 本驱动自己不做权限提升，只把 helper 的回答翻成统一形状；
 * helper 不在时 available() 返回明确原因，不抛。
 */

import { request } from 'node:http'

import { CmError, ERR } from '../util.js'

const MAX_BODY = 4 * 1024 * 1024

export const LXC_ACTIONS = ['start', 'stop', 'restart', 'freeze', 'unfreeze', 'destroy']

/**
 * @param {object} node 配置节点（socketPath 必填）
 * @param {{requestImpl?: typeof request}} [options]
 */
export function createLxcDriver(node, options = {}) {
  const socketPath = String(node.socketPath ?? '/run/dsh-container-manager/lxcd.sock')
  const requestImpl = options.requestImpl ?? request

  /**
   * 调一次 helper。
   * @param {string} path
   * @param {object} [body]
   * @param {{method?: string, timeoutMs?: number}} [opts]
   */
  function call(path, body, opts = {}) {
    const method = opts.method ?? 'POST'
    const timeoutMs = opts.timeoutMs ?? 60_000
    const payload = body === undefined ? '' : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve(value)
      }
      let req
      try {
        req = requestImpl({
          socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'x-cm-helper': '1',
          },
        }, (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            raw += chunk
            if (raw.length > MAX_BODY) {
              req.destroy()
              finish(new CmError(ERR.INTERNAL, 'helper 回答太长，已中止。'))
            }
          })
          res.on('end', () => {
            let parsed
            try {
              parsed = raw ? JSON.parse(raw) : null
            } catch {
              finish(new CmError(ERR.INTERNAL, 'helper 的 JSON 解析失败。', raw.slice(0, 200)))
              return
            }
            if (parsed && parsed.ok === true) {
              finish(null, parsed.data ?? null)
              return
            }
            const error = parsed && parsed.error ? parsed.error : {}
            finish(new CmError(
              error.code ?? ERR.INTERNAL,
              error.message ?? `helper 说不清（HTTP ${res.statusCode}）。`,
              error.hint,
            ))
          })
        })
      } catch (error) {
        finish(new CmError(ERR.HELPER_DOWN, `连不上 LXC helper：${error?.message ?? error}`, helperHint()))
        return
      }
      req.on('timeout', () => {
        req.destroy(new Error('helper 超时'))
      })
      req.on('error', (error) => {
        finish(new CmError(
          ERR.HELPER_DOWN,
          `连不上 LXC helper（${socketPath}）：${error?.code ?? error?.message ?? error}`,
          helperHint(),
        ))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  function helperHint() {
    if (typeof options.helperHint === 'function') return options.helperHint()
    return '在插件目录里执行一次：sudo bash helper/install-helper.sh'
  }

  let healthCache = null
  let healthCacheAt = 0

  async function health({ force = false } = {}) {
    const now = Date.now()
    if (!force && healthCache && now - healthCacheAt < 10_000) return healthCache
    try {
      const data = await call('/health', undefined, { method: 'GET', timeoutMs: 8000 })
      healthCache = { ok: true, ...(data ?? {}) }
    } catch (error) {
      healthCache = {
        ok: false,
        code: error?.code ?? ERR.HELPER_DOWN,
        reason: error?.message ?? String(error),
        hint: error?.hint ?? helperHint(),
      }
    }
    healthCacheAt = now
    return healthCache
  }

  function normalizeSummary(raw) {
    const name = String(raw?.name ?? '')
    const ips = Array.isArray(raw?.ips) ? raw.ips.map(String) : []
    return {
      id: name,
      shortId: name,
      name,
      image: String(raw?.template ?? raw?.distro ?? 'lxc'),
      imageId: '',
      state: String(raw?.state ?? '').toLowerCase(),
      status: String(raw?.state ?? ''),
      created: raw?.created ?? null,
      createdText: String(raw?.createdText ?? ''),
      pid: Number.isFinite(Number(raw?.pid)) ? Number(raw.pid) : null,
      exitCode: null,
      pod: null,
      isInfra: false,
      ports: [],
      networks: ips.length > 0 ? [{ name: 'lxc', ip: ips[0] }] : [],
      ips,
      autostart: raw?.autostart ?? null,
      runtime: 'lxc',
    }
  }

  async function listContainers() {
    const data = await call('/lxc/list', {}, { timeoutMs: 30_000 })
    const rows = Array.isArray(data) ? data : Array.isArray(data?.containers) ? data.containers : []
    return rows.map(normalizeSummary)
  }

  async function inspect(name) {
    const data = await call('/lxc/info', { name: String(name) }, { timeoutMs: 30_000 })
    if (!data) throw new CmError(ERR.NOT_FOUND, `找不到容器：${name}`)
    const summary = normalizeSummary(data)
    const nics = Array.isArray(data.nics) ? data.nics : []
    return {
      ...summary,
      state: String(data.state ?? '').toLowerCase(),
      status: String(data.state ?? ''),
      pid: Number.isFinite(Number(data.pid)) ? Number(data.pid) : null,
      memory: data.memory ?? null,
      template: data.template ?? null,
      configPath: data.configPath ?? null,
      autostart: data.autostart ?? null,
      settings: data.settings ?? null,
      networks: nics.map((nic, index) => ({
        name: `eth${index}`,
        ip: Array.isArray(nic.ipv4) ? String(nic.ipv4[0] ?? '') : '',
      })),
      nics,
      runtime: 'lxc',
    }
  }

  async function logs(name, tail = 100) {
    const data = await call('/lxc/logs', { name: String(name), lines: Number(tail) || 100 }, { timeoutMs: 30_000 })
    return { text: String(data?.text ?? ''), truncated: Boolean(data?.truncated) }
  }

  async function act(name, action) {
    const verb = String(action)
    if (!LXC_ACTIONS.includes(verb)) {
      throw new CmError(ERR.BAD_ARGS, `不支持的 LXC 动作：${verb}。可用：${LXC_ACTIONS.join(' / ')}`)
    }
    const data = await call('/lxc/action', { name: String(name), action: verb }, { timeoutMs: 120_000 })
    return { action: verb, ref: String(name), ...(data ?? {}) }
  }

  async function listNetworks() {
    const data = await call('/net/list', {}, { timeoutMs: 20_000 })
    const bridges = Array.isArray(data?.bridges) ? data.bridges : []
    return bridges.map(bridge => ({
      name: String(bridge.name ?? ''),
      id: String(bridge.name ?? ''),
      driver: 'bridge',
      interface: String(bridge.name ?? ''),
      subnet: String(bridge.subnet ?? ''),
      gateway: String(bridge.gateway ?? ''),
      internal: false,
      dnsEnabled: true,
      ipv6: false,
      labels: { source: 'lxc' },
      containers: Array.isArray(bridge.containers)
        ? bridge.containers.map(item => ({ id: String(item?.name ?? ''), name: String(item?.name ?? ''), ips: Array.isArray(item?.ips) ? item.ips.map(String) : [] }))
        : [],
      runtime: 'lxc',
    }))
  }

  async function net(op) {
    const action = String(op?.op ?? '')
    if (action === 'list') return listNetworks()
    if (action === 'inspect') {
      const list = await listNetworks()
      const found = list.find(item => item.name === String(op.name ?? ''))
      if (!found) throw new CmError(ERR.NOT_FOUND, `找不到 LXC 网桥：${op.name}`)
      return found
    }
    if (action === 'create') {
      const data = await call('/net/bridge', {
        name: String(op.name),
        subnet: op.subnet ?? null,
        gateway: op.gateway ?? null,
        nat: op.internal ? false : true,
      }, { timeoutMs: 120_000 })
      return data
    }
    if (action === 'remove') {
      throw new CmError(ERR.BAD_ARGS, '第一版不在面板里删 LXC 网桥（lxc-net 归系统管）；要删请改 /etc/default/lxc-net 后重启 lxc-net。')
    }
    if (action === 'connect' || action === 'disconnect') {
      throw new CmError(ERR.BAD_ARGS, 'LXC 的网络是启动时按 config 配的：请在「网络」页改网卡配置并重启容器，而不是 connect/disconnect。')
    }
    throw new CmError(ERR.BAD_ARGS, `不支持的 LXC 网络操作：${action}`)
  }

  async function getNetwork(name) {
    return call('/lxc/net/get', { name: String(name) }, { timeoutMs: 20_000 })
  }

  async function setNetwork(name, nics, { restart = true } = {}) {
    return call('/lxc/net/set', { name: String(name), nics, restart: restart === true }, { timeoutMs: 180_000 })
  }

  async function setConfig(name, patch) {
    return call('/lxc/config/set', { name: String(name), ...(patch ?? {}) }, { timeoutMs: 60_000 })
  }

  /** CPU 核数 / 内存 / swap：写 config 同时写 cgroup，容器在跑就立即生效。 */
  async function setResources(name, patch) {
    return call('/lxc/resources', { name: String(name), ...(patch ?? {}) }, { timeoutMs: 120_000 })
  }

  async function create(spec) {
    return call('/lxc/create', {
      name: String(spec.name),
      distro: String(spec.distro ?? 'debian'),
      release: String(spec.release ?? 'bookworm'),
      arch: String(spec.arch ?? 'arm64'),
      network: spec.network ?? null,
      memoryMax: spec.memoryMax ? String(spec.memoryMax) : null,
      swapMax: spec.swapMax ? String(spec.swapMax) : null,
      cores: spec.cores ? String(spec.cores) : null,
      // rootfs 落成虚拟磁盘，大小可自定义；数据盘按 -1、-2 编号往下排。
      diskSize: spec.diskSize ? String(spec.diskSize) : '8G',
      ...(Array.isArray(spec.dataDisks) && spec.dataDisks.length > 0
        ? {
          dataDisks: spec.dataDisks.map(item => ({
            size: String(item?.size ?? '8G'),
            mount: String(item?.mount ?? ''),
          })),
        }
        : {}),
    }, { timeoutMs: 600_000 })
  }

  let statsCache = null
  let statsCacheAt = 0

  /**
   * 容器实时占用。helper 要采两次 cgroup 才能算 CPU 百分比，耗时约 250ms，
   * 所以自带 3 秒缓存，别让几个前端请求同时把它打满。
   */
  async function stats({ force = false } = {}) {
    const now = Date.now()
    if (!force && statsCache && now - statsCacheAt < 3_000) return statsCache
    const rows = await call('/lxc/stats', {}, { timeoutMs: 20_000 })
    statsCache = Array.isArray(rows) ? rows : []
    statsCacheAt = Date.now()
    return statsCache
  }

  /** LXC 的系统镜像缓存（<IMAGE_ROOT>/download/... 里那几份 rootfs.tar.xz）。 */
  async function listImages() {
    return call('/lxc/images', {}, { timeoutMs: 30_000 })
  }

  /** 删一条缓存。helper 会自己再校验一遍名字，外面传路径过去也不认。 */
  async function deleteImage(name) {
    return call('/lxc/images/delete', { name: String(name) }, { timeoutMs: 120_000 })
  }

  /** 存储总览：每个容器的虚拟磁盘 + 镜像缓存 + 分区余量。 */
  async function storage() {
    return call('/lxc/storage', {}, { timeoutMs: 30_000 })
  }

  /** 让容器自己把 DHCP 跑起来（挂 br0 这类主网桥时必需）。 */
  async function configureDhcp(name) {
    return call('/lxc/dhcp', { name: String(name) }, { timeoutMs: 180_000 })
  }

  async function netHost() {
    return call('/net/host', {}, { timeoutMs: 20_000 })
  }

  async function ensureModule(name) {
    return call('/net/module', { name: String(name) }, { timeoutMs: 60_000 })
  }

  async function listSnapshots(name) {
    return call('/lxc/snapshot/list', { name: String(name) }, { timeoutMs: 60_000 })
  }

  async function snapshot(name, op, options = {}) {
    return call('/lxc/snapshot', {
      name: String(name),
      op: String(op),
      snapshot: options.snapshot ? String(options.snapshot) : undefined,
      comment: options.comment ? String(options.comment) : undefined,
    }, { timeoutMs: op === 'delete' ? 180_000 : 900_000 })
  }

  async function clone(name, newName) {
    return call('/lxc/clone', { name: String(name), newName: String(newName) }, { timeoutMs: 900_000 })
  }

  async function readMounts(name) {
    return call('/lxc/mounts/get', { name: String(name) }, { timeoutMs: 30_000 })
  }

  async function setMounts(name, mounts) {
    return call('/lxc/mounts/set', { name: String(name), mounts }, { timeoutMs: 60_000 })
  }

  return {    node,
    kind: 'lxc',
    socketPath,
    async available() {
      const status = await health()
      if (status.ok) return { ok: true }
      return { ok: false, code: status.code ?? ERR.HELPER_DOWN, reason: status.reason ?? 'helper 不可用', hint: status.hint }
    },
    health,
    listContainers,
    inspect,
    logs,
    act,
    listNetworks,
    net,
    getNetwork,
    setNetwork,
    setConfig,
    setResources,
    stats,
    listImages,
    deleteImage,
    storage,
    listSnapshots,
    snapshot,
    clone,
    readMounts,
    setMounts,
    create,
    configureDhcp,
    netHost,
    ensureModule,
    helperHint,
  }
}
