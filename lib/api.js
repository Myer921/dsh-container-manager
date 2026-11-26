/**
 * /api/container-manager —— 面板用的 REST。
 *
 * 认证：先过 Connection 的 Host/Origin 与浏览器凭证（ctx.connection.requestRejection）。
 * 没有 Connection 服务时退到「Host 头必须本机 + 拒绝跨站 Origin」。
 * 写请求额外要求 content-type: application/json 与 x-cm-request: 1（CSRF 双保险）。
 * 确认请求要求 x-cm-principal: panel —— 只有面板会加这个头。
 */

import { TOOL_ACCESS, roleMatrix } from './authz.js'
import { maskUrl } from './alerts.js'
import { normalizeAlerts, normalizeLxcDefaults } from './config.js'
import { normalizeSnapshotPolicy } from './snapshot-policy.js'
import { normalizeBackupPolicy, planBackups } from './backup.js'
import { LXC_ARCHES, LXC_TEMPLATE_SUGGESTIONS } from './create-spec.js'
import { firewallSummary, hostNetwork, readConnection } from './net.js'
import { searchImages } from './registry-search.js'
import { serveStatic } from './static.js'
import { CmError, ERR, asCmError, clampInt, safeJson } from './util.js'

export const PREFIX = '/api/container-manager'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function fail(res, error) {
  const cm = asCmError(error)
  const status = cm.code === ERR.NOT_FOUND ? 404
    : cm.code === ERR.BAD_ARGS ? 400
      : cm.code === ERR.PAYLOAD_TOO_LARGE ? 413
        : cm.code === ERR.NODE_UNAVAILABLE || cm.code === ERR.HELPER_DOWN ? 409
          : cm.code === ERR.CONFIRM_REQUIRED ? 428
            : 500
  sendJson(res, status, { ok: false, error: { code: cm.code, message: cm.message, ...(cm.hint ? { hint: cm.hint } : {}) } })
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      raw += chunk
      if (raw.length > limit) {
        done(reject, new CmError(ERR.PAYLOAD_TOO_LARGE, '请求体超过上限（' + Math.round(limit / 1048576) + 'MB）。'))
        req.resume()
      }
    })
    req.on('end', () => done(resolve, safeJson(raw, {})))
    req.on('error', error => done(reject, error))
  })
}

export function createApi({
  registry,
  configStore,
  pendings,
  actions,
  audit,
  verify,
  helperHint,
  compose = null,
  jobs = null,
  capabilities = null,
  metrics = null,
  files = null,
  trash = null,
  backup = null,
  snapshots = null,
  alerts = null,
  info = {},
}) {
  /** 审计写不进去不能让操作失败（和 actions 那边同一个原则）。 */
  function noteAudit(entry) {
    try {
      audit.append(entry)
    } catch {
      // 忽略
    }
  }

  function guard(req, res, { write = false } = {}) {
    const verdict = verify(req)
    if (!verdict.ok) {
      sendJson(res, verdict.status ?? 401, { ok: false, error: { code: 'UNAUTHORIZED', message: verdict.reason ?? '请求没通过认证。' } })
      return false
    }
    req.cmPrincipal = verdict.principal ?? null
    if (write) {
      if (!req.cmPrincipal || req.cmPrincipal.kind !== 'owner') {
        sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '写操作只允许应用 owner 执行。', hint: 'AI 请使用对应工具；容器文件写入使用 container_files，危险操作仍要人在面板确认。' } })
        return false
      }
      const type = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!type.includes('application/json')) {
        sendJson(res, 415, { ok: false, error: { code: 'BAD_ARGS', message: '写请求必须是 application/json。' } })
        return false
      }
      if (String(req.headers['x-cm-request'] ?? '') !== '1') {
        sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '缺少 x-cm-request 头。' } })
        return false
      }
    }
    return true
  }

  function principalOf(req) {
    return req.cmPrincipal && req.cmPrincipal.kind === 'owner' ? 'panel' : 'api'
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '不是容器台的接口。' } })
      return
    }
    const rest = url.pathname.slice(PREFIX.length)
    const segments = rest.split('/').filter(Boolean).map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET') return await handleGet(req, res, url, segments)
      if (method === 'POST') return await handlePost(req, res, url, segments)
      if (method === 'DELETE') return await handleDelete(req, res, segments)
      sendJson(res, 405, { ok: false, error: { code: 'BAD_ARGS', message: `不支持 ${method}` } })
    } catch (error) {
      fail(res, error)
    }
  }

  async function handleGet(req, res, url, segments) {
    if (!guard(req, res)) return
    const config = configStore.get()

    if (segments.length === 0 || segments[0] === 'state') {
      const [snapshot] = await Promise.all([registry.snapshot({ force: url.searchParams.get('refresh') === '1' })])
      return sendJson(res, 200, {
        ok: true,
        data: {
          ...snapshot,
          pending: pendings.list({ includeFinished: false }),
          // 顶栏那个「N 个任务」胶囊靠它；没有队列时给 null，前端就不画。
          jobs: jobs ? jobs.summary() : null,
          config: publicConfig(config),
        },
      })
    }
    if (segments[0] === 'nodes' && segments.length === 1) {
      const nodes = await registry.probeAll()
      return sendJson(res, 200, { ok: true, data: nodes.map(entry => publicNode(entry)) })
    }
    if (segments[0] === 'nodes' && segments.length === 3 && segments[2] === 'host') {
      return sendJson(res, 200, { ok: true, data: await registry.hostInfo(segments[1]) })
    }
    // 宿主网络：接口 / 路由 / DNS / NM 连接 / 监听端口，全部只读。
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'host') {
      return sendJson(res, 200, { ok: true, data: await hostNetwork() })
    }
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'firewall') {
      return sendJson(res, 200, { ok: true, data: await firewallSummary() })
    }
    if (segments[0] === 'net' && segments.length === 4 && segments[1] === 'connections' && segments[3] === 'full') {
      return sendJson(res, 200, { ok: true, data: await actions.inspectNetworkConnection({ name: segments[2], principal: principalOf(req) }) })
    }
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'neighbors') {
      return sendJson(res, 200, { ok: true, data: await actions.listNetworkNeighbors({ principal: principalOf(req) }) })
    }
    if (segments[0] === 'net' && segments.length === 3 && segments[1] === 'connections') {
      return sendJson(res, 200, { ok: true, data: await readConnection(segments[2]) })
    }
    // 镜像搜索：用户点「搜」才打一次 Docker Hub，5 秒超时，不通就让他们直接填名字。
    if (segments[0] === 'images' && segments.length === 2 && segments[1] === 'search') {
      const keyword = String(url.searchParams.get('q') ?? '')
      return sendJson(res, 200, { ok: true, data: await searchImages(keyword) })
    }
    // 容器实时占用 + 宿主负载：单次 1~2 秒，和 /state 的 4 秒轮询分开走。
    if (segments[0] === 'stats' && segments.length === 1) {
      const nodeId = String(url.searchParams.get('node') ?? '')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, 'stats 需要一个 node 参数。', '先 GET /nodes 看看有哪些节点。')
      return sendJson(res, 200, {
        ok: true,
        data: await registry.stats(nodeId, { force: url.searchParams.get('refresh') === '1' }),
      })
    }
    if (segments[0] === 'static' && segments.length >= 2) {
      const asset = segments.slice(1).join('/')
      if (serveStatic(res, asset)) return
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个静态资源：' + asset } })
    }
    if (segments[0] === 'compose') {
      return await getCompose(req, res, url, segments)
    }
    if (segments[0] === 'containers') {
      return await getContainers(req, res, url, segments)
    }
    if (segments[0] === 'images' && segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.listImages(nodeId) })
    }
    if (segments[0] === 'volumes' && segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.listVolumes(nodeId) })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'storage') {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      const storage = await registry.lxcStorage(nodeId)
      return sendJson(res, 200, { ok: true, data: { ...storage, policy: configStore.get().lxcDefaults, availableBackends: ['dir', 'loop'] } })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'exports') {
      const nodeId = String(url.searchParams.get('node') ?? 'local-lxc')
      const dir = url.searchParams.get('dir')
      return sendJson(res, 200, {
        ok: true,
        data: await actions.listLxcExports({ node: nodeId, dir: dir || undefined, principal: 'panel' }),
      })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'templates') {
      try {
        return sendJson(res, 200, { ok: true, data: await registry.lxcTemplates('local-lxc') })
      } catch {
        return sendJson(res, 200, { ok: true, data: { suggestions: LXC_TEMPLATE_SUGGESTIONS, arches: LXC_ARCHES, fallback: true } })
      }
    }
    if (segments[0] === 'pods' && segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.listPods(nodeId) })
    }
    if (segments[0] === 'networks') {
      const nodeId = url.searchParams.get('node')
      const snapshot = await registry.snapshot()
      const filtered = nodeId ? snapshot.networks.filter(network => network.nodeId === nodeId) : snapshot.networks
      return sendJson(res, 200, { ok: true, data: filtered })
    }
    if (segments[0] === 'pending') {
      return sendJson(res, 200, { ok: true, data: pendings.list({ includeFinished: true }) })
    }
    if (segments[0] === 'trash' && segments.length === 1) {
      return sendJson(res, 200, { ok: true, data: trash ? trash.list() : [] })
    }
    // 长任务：列表、单条（带尾部输出）、能力探针。
    if (segments[0] === 'jobs' && segments.length === 1) {
      if (!jobs) return sendJson(res, 200, { ok: true, data: { jobs: [], summary: null } })
      const includeFinished = url.searchParams.get('finished') !== '0'
      return sendJson(res, 200, { ok: true, data: { jobs: jobs.list({ includeFinished }), summary: jobs.summary() } })
    }
    if (segments[0] === 'jobs' && segments.length === 2) {
      if (!jobs) throw new CmError(ERR.NOT_FOUND, '这个实例没有任务队列。')
      const job = jobs.get(segments[1])
      if (!job) throw new CmError(ERR.NOT_FOUND, '没有这个任务。')
      return sendJson(res, 200, { ok: true, data: job })
    }
    // 镜像更新检测：本地 digest 与仓库比，比不了就说比不了。
    if (segments[0] === 'image-updates' && segments.length === 1) {
      const node = String(url.searchParams.get('node') ?? 'local-podman')
      const limit = Number(url.searchParams.get('limit') ?? 12)
      return sendJson(res, 200, { ok: true, data: await registry.imageUpdates(node, { limit }) })
    }
    // secrets：只有 Podman 有；列表永远不带明文。
    if (segments[0] === 'secrets' && segments.length === 1) {
      const node = String(url.searchParams.get('node') ?? 'local-podman')
      return sendJson(res, 200, { ok: true, data: await registry.secrets(node) })
    }
    // Quadlet：只读地看 systemd 管的容器文件。
    if (segments[0] === 'quadlets' && segments.length === 1) {
      const node = String(url.searchParams.get('node') ?? 'local-podman')
      return sendJson(res, 200, { ok: true, data: await registry.quadlets(node) })
    }
    // 容器内网络排障：只跑只读命令，面板与 AI 都能用。
    if (segments[0] === 'diagnose' && segments.length === 1) {
      const node = String(url.searchParams.get('node') ?? '')
      const ref = String(url.searchParams.get('ref') ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      return sendJson(res, 200, {
        ok: true,
        data: await registry.diagnose(node, ref, {
          host: url.searchParams.get('host') ?? undefined,
          port: url.searchParams.get('port') ?? undefined,
        }),
      })
    }
    // 容器内文件：列目录与读文件都是只读，面板与 AI 都能用。
    if (segments[0] === 'files' && segments.length === 1) {
      if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
      const node = String(url.searchParams.get('node') ?? '')
      const ref = String(url.searchParams.get('ref') ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      return sendJson(res, 200, {
        ok: true,
        data: await files.list({
          node,
          ref,
          path: url.searchParams.get('path') ?? '/',
        }),
      })
    }
    if (segments[0] === 'files' && segments.length === 2 && segments[1] === 'read') {
      if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
      const node = String(url.searchParams.get('node') ?? '')
      const ref = String(url.searchParams.get('ref') ?? '')
      const path = String(url.searchParams.get('path') ?? '')
      if (!node || !ref || !path) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / path。')
      return sendJson(res, 200, { ok: true, data: await files.read({ node, ref, path }) })
    }
    // 指标历史：某节点最近 N 分钟的宿主负载，服务端先降采样再发。
    if (segments[0] === 'metrics' && segments.length === 2 && segments[1] === 'containers') {
      if (!metrics) throw new CmError(ERR.INTERNAL, '指标历史没接上。')
      const node = String(url.searchParams.get('node') ?? '')
      const ref = String(url.searchParams.get('ref') ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      return sendJson(res, 200, { ok: true, data: metrics.queryContainers({
        node,
        ref,
        minutes: clampInt(url.searchParams.get('minutes'), 1, 60 * 24 * 7, 60),
        points: clampInt(url.searchParams.get('points'), 2, 600, 120),
      }) })
    }
    if (segments[0] === 'metrics' && segments.length === 1) {
      if (!metrics) throw new CmError(ERR.INTERNAL, '指标历史没接上。')
      const nodeId = String(url.searchParams.get('node') ?? '') || null
      const minutes = clampInt(url.searchParams.get('minutes'), 1, 60 * 24 * 7, 60)
      const points = clampInt(url.searchParams.get('points'), 2, 600, 120)
      return sendJson(res, 200, {
        ok: true,
        data: { ...metrics.query({ node: nodeId, minutes, points }), info: metrics.info() },
      })
    }
    // 告警：规则 + 出口（地址掩码）+ 最近发过的（只读）。
    if (segments[0] === 'alerts' && segments.length === 1) {
      const config = configStore.get().alerts
      return sendJson(res, 200, {
        ok: true,
        data: {
          rules: config.rules,
          dedupeMinutes: config.dedupeMinutes,
          hasWebhooks: (config.webhooks || []).some(hook => hook.enabled !== false),
          webhooks: (config.webhooks || []).map(hook => ({
            id: hook.id,
            name: hook.name,
            kind: hook.kind,
            enabled: hook.enabled !== false,
            url: maskUrl(hook.url),
          })),
          recent: alerts ? alerts.recent() : [],
        },
      })
    }
    if (segments[0] === 'snapshots' && segments.length === 2 && segments[1] === 'policy') {
      return sendJson(res, 200, { ok: true, data: { policy: configStore.get().snapshotPolicy, events: snapshots ? snapshots.events() : [] } })
    }
    // 自动备份：策略 + 已有归档 + 这一轮到期的容器（只读）。
    if (segments[0] === 'backup' && segments.length === 1) {
      const policy = configStore.get().backupPolicy
      let listed = { dir: '', files: [] }
      let containers = []
      let need = []
      try {
        const snapshot = await registry.snapshot()
        const lxcNode = (snapshot.nodes || []).find(item => item.kind === 'lxc' && item.available)
        containers = (snapshot.containers || []).filter(item => item.kind === 'lxc').map(item => item.name)
        listed = await registry.listLxcExports(lxcNode ? lxcNode.id : 'local-lxc', { dir: policy.dir || undefined })
        need = planBackups({ policy, files: listed.files, containers })
      } catch (error) {
        return sendJson(res, 200, {
          ok: true,
          data: {
            policy,
            dir: listed.dir || '',
            files: Array.isArray(listed.files) ? listed.files : [],
            due: [],
            events: backup ? backup.events() : [],
            warn: '读不到归档列表：' + (error && error.message ? error.message : String(error)),
          },
        })
      }
      return sendJson(res, 200, {
        ok: true,
        data: {
          policy,
          dir: listed.dir || '',
          files: Array.isArray(listed.files) ? listed.files : [],
          targets: containers,
          due: need.due,
          fresh: need.fresh,
          missing: need.missing,
          events: backup ? backup.events() : [],
        },
      })
    }
    // AI 侧权限：读角色/黑名单 + 能力矩阵，面板画一张表就够。
    if (segments[0] === 'authz' && segments.length === 1) {
      const authz = configStore.get().authz ?? {}
      return sendJson(res, 200, {
        ok: true,
        data: {
          role: authz.aiRole ?? 'operator',
          deny: Array.isArray(authz.deny) ? authz.deny : [],
          matrix: roleMatrix(),
          access: TOOL_ACCESS,
        },
      })
    }
    if (segments[0] === 'capabilities' && segments.length === 1) {
      if (!capabilities) throw new CmError(ERR.INTERNAL, '能力探针没接上。')
      const nodeId = String(url.searchParams.get('node') ?? 'local-podman')
      const node = config.nodes.find(item => item.id === nodeId)
      if (!node) throw new CmError(ERR.NOT_FOUND, '没有这个节点：' + nodeId)
      const refresh = url.searchParams.get('refresh') === '1'
      if (refresh) capabilities.invalidate()
      return sendJson(res, 200, { ok: true, data: await capabilities.probe(node) })
    }
    if (segments[0] === 'audit') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 2000, 100)
      return sendJson(res, 200, { ok: true, data: audit.read(limit) })
    }
    if (segments[0] === 'config') {
      return sendJson(res, 200, { ok: true, data: publicConfig(config) })
    }
    if (segments[0] === 'health') {
      return sendJson(res, 200, { ok: true, data: await health() })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：GET ${url.pathname}` } })
  }

  /** compose 的只读查询：项目列表、单项目详情、YAML 原文、日志、迁移预览、运行时状态。 */
  async function getCompose(req, res, url, segments) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    const rest = segments.slice(1)
    if (rest.length === 1 && rest[0] === 'runtime') {
      return sendJson(res, 200, { ok: true, data: await compose.runtime() })
    }
    if (rest[0] !== 'projects') {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：GET ' + url.pathname } })
      return
    }
    if (rest.length === 1) {
      return sendJson(res, 200, { ok: true, data: await compose.list() })
    }
    const name = String(rest[1] ?? '')
    const tail = rest.slice(2)
    if (tail.length === 0) return sendJson(res, 200, { ok: true, data: await compose.detail(name) })
    if (tail.length === 1 && tail[0] === 'yaml') return sendJson(res, 200, { ok: true, data: compose.yamlText(name) })
    if (tail.length === 1 && tail[0] === 'adopt') return sendJson(res, 200, { ok: true, data: await compose.adoptPreview(name) })
    if (tail.length === 1 && tail[0] === 'logs') {
      const service = url.searchParams.get('service') || ''
      const lines = clampInt(url.searchParams.get('tail'), 1, 2000, 200)
      return sendJson(res, 200, { ok: true, data: await compose.logs(name, { service, tail: lines }) })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：GET ' + url.pathname } })
  }

  async function getContainers(req, res, url, segments) {
    if (segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      const snapshot = await registry.snapshot()
      const filtered = nodeId ? snapshot.containers.filter(container => container.nodeId === nodeId) : snapshot.containers
      return sendJson(res, 200, { ok: true, data: filtered })
    }
    const nodeId = segments[1]
    let rest = segments.slice(2)
    if (rest.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_ARGS', message: '缺少容器名。' } })
      return
    }
    if (rest[rest.length - 1] === 'logs') {
      const ref = rest.slice(0, -1).join('/')
      const config = configStore.get()
      const tail = clampInt(url.searchParams.get('tail'), 1, config.logTailMax, config.logTailDefault)
      const data = await registry.logs(nodeId, ref, tail, { since: url.searchParams.get('since') || undefined })
      return sendJson(res, 200, { ok: true, data: { ref, tail, ...data } })
    }
    if (rest[rest.length - 1] === 'network') {
      const ref = rest.slice(0, -1).join('/')
      const data = await registry.lxcNetwork(nodeId, ref)
      return sendJson(res, 200, { ok: true, data })
    }
    if (rest[rest.length - 1] === 'snapshots') {
      const ref = rest.slice(0, -1).join('/')
      return sendJson(res, 200, { ok: true, data: await registry.listSnapshots(nodeId, ref) })
    }
    if (rest[rest.length - 1] === 'mounts') {
      const ref = rest.slice(0, -1).join('/')
      return sendJson(res, 200, { ok: true, data: await registry.readMounts(nodeId, ref) })
    }
    const ref = rest.join('/')
    return sendJson(res, 200, { ok: true, data: await registry.inspect(nodeId, ref) })
  }

  /** compose 的写操作。down / adopt 会删容器，交给 actions 挂待确认。 */
  async function postCompose(req, res, url, segments, body) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (!guard(req, res, { write: true })) return
    const principal = principalOf(req)
    const rest = segments.slice(1)
    if (rest.length === 2 && rest[0] === 'runtime' && rest[1] === 'install') {
      return sendJson(res, 200, { ok: true, data: await compose.install({ principal }) })
    }
    if (rest[0] !== 'projects') {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：POST ' + url.pathname } })
      return
    }
    const name = String(rest[1] ?? '')
    const tail = rest.slice(2)
    if (tail.length === 1 && tail[0] === 'yaml') {
      const text = String(body?.text ?? '')
      if (!text.trim()) throw new CmError(ERR.BAD_ARGS, '内容是空的，没写。')
      return sendJson(res, 200, { ok: true, data: compose.writeYaml(name, text, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'up') {
      return sendJson(res, 200, { ok: true, data: await compose.up(name, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'restart') {
      return sendJson(res, 200, { ok: true, data: await compose.restart(name, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'down') {
      return sendJson(res, 200, { ok: true, data: await actions.composeDown({ name, principal }) })
    }
    if (tail.length === 1 && tail[0] === 'adopt') {
      return sendJson(res, 200, { ok: true, data: await actions.composeAdopt({ name, principal }) })
    }
    if (tail.length === 3 && tail[0] === 'services' && tail[2] === 'ports') {
      const service = String(tail[1] ?? '')
      const ports = Array.isArray(body?.ports) ? body.ports.map(item => String(item)) : []
      const result = compose.setServicePorts(name, service, ports, { principal })
      // rebuild 只认显式 true：改端口和「立刻重建」是两件事，别偷偷重启人家服务。
      if (body?.rebuild === true) result.rebuild = await compose.up(name, { principal })
      return sendJson(res, 200, { ok: true, data: result })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：POST ' + url.pathname } })
  }

  async function handlePost(req, res, url, segments) {
    const fileWrite = segments[0] === 'files' && ['write', 'mkdir', 'remove'].includes(segments[1] ?? 'write')
    const body = await readBody(req, fileWrite ? 16 * 1024 * 1024 : 1_000_000)

    // 连通性诊断：只读，但要 POST（带参数），照旧过写请求守卫。
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'diagnose') {
      if (!guard(req, res, { write: true })) return
      const result = await actions.diagnoseNetwork({
        target: body?.target,
        count: body?.count,
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // 新建宿主连接：要排在 /:name 之前，不然 create 会被当成连接名。
    if (segments[0] === 'net' && segments.length === 3 && segments[1] === 'connections' && segments[2] === 'create') {
      if (!guard(req, res, { write: true })) return
      return sendJson(res, 200, {
        ok: true,
        data: await actions.createNetworkConnection({ spec: body ?? {}, principal: principalOf(req) }),
      })
    }
    // 改宿主网络连接：一律走 pending，前端还得确认一次。
    if (segments[0] === 'net' && segments[1] === 'connections' && segments.length >= 3) {
      if (!guard(req, res, { write: true })) return
      const name = segments[2]
      const op = segments[3] ?? 'modify'
      if (op === 'state') {
        return sendJson(res, 200, {
          ok: true,
          data: await actions.setNetworkLink({ name, up: body?.up !== false, principal: principalOf(req) }),
        })
      }
      if (op === 'delete') {
        return sendJson(res, 200, {
          ok: true,
          data: await actions.deleteNetworkConnection({ name, principal: principalOf(req) }),
        })
      }
      return sendJson(res, 200, {
        ok: true,
        data: await actions.applyNetworkConnection({
          name,
          patch: body?.patch ?? body ?? {},
          principal: principalOf(req),
        }),
      })
    }

    if (segments[0] === 'nodes' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = configStore.addNode(body)
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: node })
    }
    if (segments[0] === 'nodes' && segments.length === 3 && segments[2] === 'modules') {
      if (!guard(req, res, { write: true })) return
      const name = String(body?.name ?? '')
      if (!/^[a-z0-9][a-z0-9_]{0,31}$/.test(name)) throw new CmError(ERR.BAD_ARGS, '模块名不合法。')
      return sendJson(res, 200, { ok: true, data: await registry.ensureModule(segments[1], name) })
    }
    // 告警：改规则 / 改出口 / 发一条测试。都只有面板能点（出口地址里带 token）。
    if (segments[0] === 'alerts' && segments[1] === 'rules' && segments.length === 2) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') throw new CmError(ERR.BAD_ARGS, '只有面板能改告警规则。')
      const current = configStore.get()
      const saved = configStore.replace({
        ...current,
        alerts: { ...current.alerts, rules: Array.isArray(body?.rules) ? body.rules : current.alerts.rules },
      })
      noteAudit({ principal: 'panel', node: 'config', action: 'alerts.rules', target: 'alerts', detail: saved.alerts.rules })
      return sendJson(res, 200, { ok: true, data: { rules: saved.alerts.rules } })
    }
    if (segments[0] === 'alerts' && segments[1] === 'webhooks' && segments.length === 3) {
      if (!guard(req, res, { write: true })) return
      const op = segments[2]
      if (!['add', 'update', 'delete'].includes(op)) throw new CmError(ERR.BAD_ARGS, '出口操作只支持 add / update / delete。')
      const current = configStore.get()
      const hooks = Array.isArray(current.alerts.webhooks) ? current.alerts.webhooks.slice() : []
      const id = String(body?.id ?? '').trim()
      if (op === 'add') {
        const nextId = id || ('hook-' + Date.now().toString(36))
        const candidate = {
          id: nextId,
          name: String(body?.name ?? nextId),
          url: String(body?.url ?? ''),
          kind: String(body?.kind ?? 'json'),
          enabled: body?.enabled !== false,
        }
        const normalized = normalizeAlerts({ webhooks: [...hooks, candidate] }).webhooks
        if (normalized.length !== hooks.length + 1) throw new CmError(ERR.BAD_ARGS, '出口地址或参数不合法。')
        hooks.splice(0, hooks.length, ...normalized)
      } else {
        const index = hooks.findIndex(hook => hook.id === id)
        if (index < 0) throw new CmError(ERR.NOT_FOUND, '没有这个告警出口：' + id)
        if (op === 'delete') hooks.splice(index, 1)
        else {
          const merged = { ...hooks[index], ...body, id }
          const normalized = normalizeAlerts({ webhooks: hooks.map((hook, i) => i === index ? merged : hook) }).webhooks
          if (normalized.length !== hooks.length) throw new CmError(ERR.BAD_ARGS, '出口地址或参数不合法。')
          hooks.splice(0, hooks.length, ...normalized)
        }
      }
      const saved = configStore.replace({ ...current, alerts: { ...current.alerts, webhooks: hooks } })
      noteAudit({ principal: 'panel', node: 'config', action: 'alerts.webhooks.' + op, target: id || 'alerts', detail: { count: saved.alerts.webhooks.length } })
      return sendJson(res, 200, {
        ok: true,
        data: {
          webhooks: saved.alerts.webhooks.map(hook => ({ id: hook.id, name: hook.name, kind: hook.kind, enabled: hook.enabled, url: maskUrl(hook.url) })),
        },
      })
    }
    if (segments[0] === 'alerts' && segments[1] === 'test' && segments.length === 2) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') throw new CmError(ERR.BAD_ARGS, '只有面板能发测试告警。')
      if (!alerts) throw new CmError(ERR.INTERNAL, '告警器没接上。')
      const result = await alerts.fire([{
        ruleId: 'test',
        kind: 'test',
        target: 'panel',
        title: '容器台测试告警',
        body: '这条是你在面板里点的测试，收到就说明出口通了。',
      }])
      noteAudit({ principal: 'panel', node: 'config', action: 'alerts.test', target: 'alerts', detail: { sent: result.sent.length, failed: result.failed.length } })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'lxc' && segments.length === 3 && segments[1] === 'storage' && segments[2] === 'policy') {
      if (!guard(req, res, { write: true })) return
      const current = configStore.get()
      const saved = configStore.replace({ ...current, lxcDefaults: normalizeLxcDefaults({ ...current.lxcDefaults, ...body }) })
      noteAudit({ principal: 'panel', node: 'config', action: 'lxc.storage.policy', target: 'lxc', result: 'ok', detail: saved.lxcDefaults })
      return sendJson(res, 200, { ok: true, data: saved.lxcDefaults })
    }
    if (segments[0] === 'snapshots' && segments.length === 2 && segments[1] === 'policy') {
      if (!guard(req, res, { write: true })) return
      const current = configStore.get()
      const saved = configStore.replace({ ...current, snapshotPolicy: normalizeSnapshotPolicy({ ...current.snapshotPolicy, ...body }) })
      noteAudit({ principal: 'panel', node: 'config', action: 'snapshots.policy', target: 'lxc', result: 'ok', detail: saved.snapshotPolicy })
      return sendJson(res, 200, { ok: true, data: saved.snapshotPolicy })
    }
    if (segments[0] === 'snapshots' && segments.length === 2 && segments[1] === 'run') {
      if (!guard(req, res, { write: true })) return
      if (!snapshots) throw new CmError(ERR.INTERNAL, '定时快照调度器没接上。')
      const result = await snapshots.tick()
      noteAudit({ principal: 'panel', node: 'config', action: 'snapshots.run', target: 'lxc', result: result.skipped || 'ok', detail: { started: result.started.length, removed: result.removed.length } })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // 自动备份：改策略 / 立刻跑一轮。都只有面板能点（备份要占盘，AI 不该偷偷跑）。
    if (segments[0] === 'backup' && segments[1] === 'policy' && segments.length === 2) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') throw new CmError(ERR.BAD_ARGS, '只有面板能改备份策略。')
      const current = configStore.get()
      const saved = configStore.replace({
        ...current,
        backupPolicy: normalizeBackupPolicy({ ...current.backupPolicy, ...(body && typeof body === 'object' ? body : {}) }),
      })
      noteAudit({ principal: 'panel', node: 'config', action: 'backup.policy', target: 'lxc', detail: saved.backupPolicy })
      return sendJson(res, 200, { ok: true, data: saved.backupPolicy })
    }
    if (segments[0] === 'backup' && segments[1] === 'run' && segments.length === 2) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') throw new CmError(ERR.BAD_ARGS, '只有面板能手动跑备份。')
      if (!backup) throw new CmError(ERR.INTERNAL, '备份调度器没接上。')
      const result = await backup.tick()
      noteAudit({ principal: 'panel', node: 'config', action: 'backup.run', target: 'lxc', detail: { started: result.started, removed: result.removed, skipped: result.skipped ?? null } })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // 改 AI 角色 / deny 名单：只有面板能改（AI 不该给自己提权）。
    if (segments[0] === 'authz' && segments[1] === 'set' && segments.length === 2) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') {
        throw new CmError(ERR.BAD_ARGS, '只有面板能改 AI 权限 —— AI 不能给自己提权。')
      }
      const current = configStore.get()
      const next = {
        ...current.authz,
        ...(body.role !== undefined ? { aiRole: String(body.role) } : {}),
        ...(Array.isArray(body.deny) ? { deny: body.deny.map(item => String(item)) } : {}),
      }
      const saved = configStore.replace({ ...current, authz: next })
      noteAudit({ principal: 'panel', node: 'config', action: 'authz.set', target: 'ai', detail: { role: saved.authz.aiRole, deny: saved.authz.deny } })
      return sendJson(res, 200, { ok: true, data: { role: saved.authz.aiRole, deny: saved.authz.deny } })
    }
    // 单服务滚动：只 pull + 重建这一个服务，别的服务不碰。
    if (segments[0] === 'compose' && segments[1] === 'projects' && segments[3] === 'services' && segments[5] === 'recreate') {
      if (!guard(req, res, { write: true })) return
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 没接上。')
      const projectName = decodeURIComponent(segments[2])
      const serviceName = decodeURIComponent(segments[4])
      const result = await compose.recreateService(projectName, serviceName, { principal: principalOf(req) })
      return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result, error: result.ok ? undefined : { code: 'COMPOSE_ERROR', message: result.message } })
    }
    if (segments[0] === 'compose' && segments[1] === 'projects' && segments[3] === 'services' && segments[5] === 'rollback') {
      if (!guard(req, res, { write: true })) return
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 没接上。')
      const projectName = decodeURIComponent(segments[2])
      const serviceName = decodeURIComponent(segments[4])
      const result = await compose.rollbackService(projectName, serviceName, { principal: 'panel' })
      return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result, error: result.ok ? undefined : { code: 'COMPOSE_ERROR', message: result.message } })
    }
    // secrets：建 / 删。明文只从面板进来 —— AI 那边的工具层被明确拒绝。
    if (segments[0] === 'secrets' && (segments[1] === 'create' || segments[1] === 'delete')) {
      if (!guard(req, res, { write: true })) return
      if (principalOf(req) !== 'panel') {
        sendJson(res, 403, {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '面板之外不碰 secret：新建要把明文交给服务端，删除会断掉引用它的容器。',
            hint: 'AI 请用 container_secret 工具：list 能看名字，删除会挂起等人确认，新建会被拒绝。',
          },
        })
        return
      }
      const node = String(body?.node ?? 'local-podman')
      if (segments[1] === 'create') {
        const name = String(body?.name ?? '')
        const value = String(body?.value ?? '')
        const result = await registry.secretCreate(node, name, value)
        noteAudit({ principal: 'panel', action: 'secret.create', node, target: name, detail: { bytes: value.length } })
        return sendJson(res, 200, { ok: true, data: result })
      }
      const name = String(body?.name ?? '')
      const result = await registry.secretRemove(node, name)
      noteAudit({ principal: 'panel', action: 'secret.delete', node, target: name, detail: {} })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // Quadlet：重新生成与启停 unit 都是可逆的，直接执行（和容器 start/stop 同级）。
    if (segments[0] === 'quadlets' && segments[1] === 'reload') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? 'local-podman')
      const result = await registry.quadletReload(node)
      noteAudit({ principal: principalOf(req), action: 'quadlet.reload', node, target: null, detail: {} })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'quadlets' && segments[1] === 'action') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? 'local-podman')
      const unit = String(body?.unit ?? '')
      const action = String(body?.action ?? '')
      const result = await registry.quadletAction(node, unit, action)
      noteAudit({ principal: principalOf(req), action: 'quadlet.' + action, node, target: unit, detail: {} })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // 容器内文件的写操作：只给面板。AI 要走 container_files 工具 —— 那条会挂 pending。
    if (segments[0] === 'files' && segments.length >= 1 && segments.length <= 2) {
      const op = segments[1] ?? 'write'
      if (!['write', 'mkdir', 'remove'].includes(op)) {
        throw new CmError(ERR.BAD_ARGS, '文件的写操作只有 write / mkdir / remove。')
      }
      if (!guard(req, res, { write: true })) return
      if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
      if (principalOf(req) !== 'panel') {
        sendJson(res, 403, {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '面板之外不能直接写容器内文件。',
            hint: 'AI 请用 container_files 工具：它会挂起，等人确认。',
          },
        })
        return
      }
      const node = String(body?.node ?? '')
      const ref = String(body?.ref ?? '')
      const path = String(body?.path ?? '')
      if (!node || !ref || !path) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / path。')
      if (op === 'write') {
        return sendJson(res, 200, {
          ok: true,
          data: await files.write({ node, ref, path, text: body?.text ?? null, base64: body?.base64 ?? null }),
        })
      }
      if (op === 'mkdir') return sendJson(res, 200, { ok: true, data: await files.mkdir({ node, ref, path }) })
      return sendJson(res, 200, { ok: true, data: await files.remove({ node, ref, path }) })
    }
    // LXC 导出 / 导入：整份 rootfs 打包，走任务队列（立刻返回 jobId）。
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'export') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      return sendJson(res, 200, {
        ok: true,
        data: await actions.lxcExport({
          node,
          name,
          dir: body?.dir ? String(body.dir) : undefined,
          instanceOnly: body?.instanceOnly !== false,
          principal: principalOf(req),
        }),
      })
    }
    if (segments[0] === 'lxc' && segments.length === 3 && segments[1] === 'exports' && segments[2] === 'delete') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      return sendJson(res, 200, {
        ok: true,
        data: await actions.deleteLxcExport({
          node,
          name,
          dir: body?.dir ? String(body.dir) : undefined,
          principal: principalOf(req),
        }),
      })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'import') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const file = String(body?.file ?? '')
      const name = String(body?.name ?? '')
      if (!node || !file || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / file / name。')
      return sendJson(res, 200, {
        ok: true,
        data: await actions.lxcImport({ node, file, name, principal: principalOf(req) }),
      })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'snapshots') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const op = String(body?.op ?? 'create')
      const result = await actions.lxcSnapshot({
        node,
        name,
        op,
        options: { snapshot: body?.snapshot, comment: body?.comment },
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'mounts') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const result = await actions.lxcSetMounts({
        node,
        name,
        mounts: Array.isArray(body?.mounts) ? body.mounts : [],
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'clone') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const result = await actions.lxcClone({
        node,
        name,
        newName: String(body?.newName ?? ''),
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'registry' && segments.length === 2 && segments[1] === 'login') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      const result = await registry.registryLogin(node, body?.registry, body?.username, body?.password)
      noteAudit({ principal: 'panel', node, action: 'registry.login', target: result.registry, result: 'ok', detail: { username: result.username } })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'images') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const reference = String(body?.reference ?? '')
      if (!node || !reference) throw new CmError(ERR.BAD_ARGS, '需要 node / reference。')
      if (segments.length === 2 && segments[1] === 'pull') {
        return sendJson(res, 200, { ok: true, data: await actions.imagePull({ node, reference, principal: principalOf(req) }) })
      }
      if (segments.length === 2 && segments[1] === 'delete') {
        // 两边的「镜像」根本不是一回事：Podman 是 OCI 镜像库，LXC 是本地 rootfs 缓存目录。
        // 按节点类型分流，别硬塞进同一个删除流程。
        if (registry.kindOf(node) === 'lxc') {
          return sendJson(res, 200, { ok: true, data: await actions.lxcImageDelete({ node, name: reference || String(body?.name ?? ''), principal: principalOf(req) }) })
        }
        return sendJson(res, 200, { ok: true, data: await actions.imageDelete({ node, reference, principal: principalOf(req) }) })
      }
      throw new CmError(ERR.NOT_FOUND, '没有这个接口：POST ' + url.pathname)
    }
    if (segments[0] === 'volumes' && segments.length === 2 && ['backup', 'restore'].includes(segments[1])) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      const result = segments[1] === 'backup'
        ? await actions.volumeBackup({ node, name, dir: body?.dir, image: body?.image, principal: principalOf(req) })
        : await actions.volumeRestore({ node, name, file: body?.file, image: body?.image, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'volumes' && segments.length === 2 && segments[1] === 'delete') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      return sendJson(res, 200, { ok: true, data: await actions.volumeDelete({ node, name, principal: principalOf(req) }) })
    }
    if (segments[0] === 'compose') {
      return await postCompose(req, res, url, segments, body)
    }
    if (segments[0] === 'actions') {
      if (!guard(req, res, { write: true })) return
      if (segments.length === 2 && segments[1] === 'confirm') {
        if (principalOf(req) !== 'panel') {
          sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '确认只能在面板里点。' } })
          return
        }
        const token = String(body?.token ?? '')
        if (!token) throw new CmError(ERR.BAD_ARGS, '缺少 token。')
        return sendJson(res, 200, { ok: true, data: await actions.confirm(token, { principal: 'panel' }) })
      }
      if (segments.length === 2 && segments[1] === 'cancel') {
        if (principalOf(req) !== 'panel') {
          sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '取消只能在面板里点。' } })
          return
        }
        const token = String(body?.token ?? '')
        if (!token) throw new CmError(ERR.BAD_ARGS, '缺少 token。')
        return sendJson(res, 200, { ok: true, data: { status: 'cancelled', record: actions.cancel(token, { principal: 'panel' }) } })
      }
      if (segments.length === 1) {
        const node = String(body?.node ?? '')
        const ref = String(body?.ref ?? body?.id ?? '')
        const action = String(body?.action ?? '')
        if (!node || !ref || !action) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / action。')
        const result = await actions.containerAction({ node, ref, action, principal: principalOf(req) })
        return sendJson(res, 200, { ok: true, data: result })
      }
    }
    if (segments[0] === 'trash' && segments.length === 2 && ['restore', 'purge'].includes(segments[1])) {
      if (!guard(req, res, { write: true })) return
      if (!trash) throw new CmError(ERR.NOT_FOUND, '这个实例没有回收站。')
      const id = String(body?.id ?? '')
      const record = trash.list().find(item => item.id === id)
      if (!record) throw new CmError(ERR.NOT_FOUND, '回收站里没有这条记录。')
      if (segments[1] === 'restore') {
        await registry.renameContainer(record.node, record.ref, record.originalName)
        if (record.wasRunning) await registry.act(record.node, record.originalName, 'start')
        trash.remove(id)
        noteAudit({ principal: 'panel', node: record.node, action: 'trash.restore', target: record.originalName, result: 'ok' })
        return sendJson(res, 200, { ok: true, data: { restored: record.originalName } })
      }
      await registry.act(record.node, record.ref, 'delete')
      trash.remove(id)
      noteAudit({ principal: 'panel', node: record.node, action: 'trash.purge', target: record.ref, result: 'ok' })
      return sendJson(res, 200, { ok: true, data: { purged: record.ref } })
    }
    // 取消任务：面板和 AI 都能做 —— 它只会让事情停下来。
    if (segments[0] === 'jobs' && segments.length === 3 && segments[2] === 'cancel') {
      if (!guard(req, res, { write: true })) return
      if (!jobs) throw new CmError(ERR.NOT_FOUND, '这个实例没有任务队列。')
      return sendJson(res, 200, { ok: true, data: jobs.cancel(segments[1], principalOf(req)) })
    }
    if (segments[0] === 'jobs' && segments.length === 3 && segments[2] === 'retry') {
      if (!guard(req, res, { write: true })) return
      if (!jobs) throw new CmError(ERR.NOT_FOUND, '这个实例没有任务队列。')
      return sendJson(res, 200, { ok: true, data: jobs.retry(segments[1], principalOf(req)) })
    }
    if (segments[0] === 'pods' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      const result = await registry.createPod(node, { name, share: body?.share, infra: body?.infra !== false })
      noteAudit({ principal: 'panel', node, action: 'pod.create', target: name, result: 'ok' })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'pods' && segments.length === 2 && segments[1] === 'action') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      const action = String(body?.action ?? '')
      if (!node || !name || !action) throw new CmError(ERR.BAD_ARGS, '需要 node / name / action。')
      const result = action === 'remove'
        ? await actions.podRemove({ node, name, principal: 'panel' })
        : await registry.podAction(node, name, action)
      noteAudit({ principal: 'panel', node, action: 'pod.' + action, target: name, result: result.status === 'pending' ? 'pending' : 'ok' })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'networks' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const op = String(body?.op ?? '')
      if (!node || !op) throw new CmError(ERR.BAD_ARGS, '需要 node / op。')
      const result = await actions.networkOperation({ node, op: { ...body, node, op }, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      // spec 归一化在 actions 层做（按 node.kind 分派），这里只把 body 交下去。
      const result = await actions.createContainer({ node, spec: body, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'rename') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      const result = await actions.renameContainer({ node, ref, name: body?.name, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'commit') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      const result = await actions.commitContainer({ node, ref, image: body?.image ?? body?.target, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'limits') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      const result = await actions.updatePodmanCgroup({
        node,
        ref,
        limits: {
          ...(body?.memory !== undefined ? { memory: body.memory } : {}),
          ...(body?.cpus !== undefined ? { cpus: body.cpus } : {}),
          ...(body?.cpuShares !== undefined ? { cpuShares: body.cpuShares } : {}),
          ...(body?.cpusetCpus !== undefined ? { cpusetCpus: body.cpusetCpus } : {}),
          ...(body?.memoryReservation !== undefined ? { memoryReservation: body.memoryReservation } : {}),
          ...(body?.memorySwap !== undefined ? { memorySwap: body.memorySwap } : {}),
          ...(body?.blkioWeight !== undefined ? { blkioWeight: body.blkioWeight } : {}),
          ...(body?.pidsLimit !== undefined ? { pidsLimit: body.pidsLimit } : {}),
          ...(body?.restart !== undefined ? { restart: body.restart } : {}),
        },
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'recreate') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      const patch = pickRecreatePatch(body)
      if (Object.keys(patch).length === 0) {
        throw new CmError(ERR.BAD_ARGS, '没有要改的项。可改：ports / volumes / env / restart / command / entrypoint / network / hostname / user / workdir / privileged / autoRemove / pidsLimit / capAdd / capDrop / securityOpt，以及 memory 系列资源。')
      }
      const result = await actions.recreatePodmanContainer({ node, ref, patch, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'config') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const patch = {}
      if (body && 'autostart' in body) patch.autostart = body.autostart === true
      if (body && 'memoryMax' in body) patch.memoryMax = body.memoryMax === null ? '' : String(body.memoryMax ?? '')
      if (Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项（autostart / memoryMax）。')
      const result = await actions.setLxcConfig({ node, name, patch, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'resources') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const patch = pickResourcePatch(body)
      if (Object.keys(patch).length === 0) {
        throw new CmError(ERR.BAD_ARGS, '没有要改的项。可改：cores / cpuQuota / cpuWeight / memory / memoryHigh / swap / oomGroup / pids / ioWeight / hostname / autostart / startOrder / startDelay / initCmd / capDrop。')
      }
      const result = await actions.setLxcResources({ node, name, patch, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'network') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      const nics = Array.isArray(body?.nics) ? body.nics : []
      if (nics.length === 0) throw new CmError(ERR.BAD_ARGS, '至少要留一块网卡。')
      const result = await actions.setLxcNetwork({
        node,
        name: ref,
        nics,
        restart: body?.restart !== false,
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'config' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      // 只带 compose 的请求走增量：别为了改个根目录把节点和其余设置一起冲掉。
      const patch = body?.compose
      const keys = body && typeof body === 'object' ? Object.keys(body) : []
      if (patch && typeof patch === 'object' && keys.length === 1) {
        const next = {}
        if (patch.root !== undefined) next.root = String(patch.root)
        if (patch.binary !== undefined) next.binary = String(patch.binary)
        if (Object.keys(next).length > 0) configStore.updateCompose(next)
        let layout = null
        if (compose) {
          try { layout = compose.layout() } catch { layout = null }
        }
        return sendJson(res, 200, { ok: true, data: { ...publicConfig(configStore.get()), layout } })
      }
      const next = configStore.replace(body)
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: publicConfig(next) })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：POST ${url.pathname}` } })
  }

  async function handleDelete(req, res, segments) {
    if (!guard(req, res, { write: true })) return
    if (segments[0] === 'nodes' && segments.length === 2) {
      const removed = configStore.removeNode(segments[1])
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: { removed } })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口。' } })
  }

  async function health() {
    const config = configStore.get()
    const nodes = await registry.probeAll({ force: true })
    const auditHealth = typeof audit.health === 'function' ? audit.health() : { ok: true, lastError: null }
    const metricsInfo = metrics && typeof metrics.info === 'function' ? metrics.info() : null
    const metricsFresh = !config.metrics || config.metrics.enabled === false || !metricsInfo || !metricsInfo.to || Date.now() - Date.parse(metricsInfo.to) < Math.max(180_000, (metricsInfo.intervalSeconds || 30) * 10_000)
    const jobSummary = jobs && typeof jobs.summary === 'function' ? jobs.summary() : null
    const availableNodes = nodes.filter(entry => entry.available).length
    const checks = {
      audit: auditHealth.ok,
      metricsFresh,
      nodeAvailable: availableNodes > 0,
      jobs: !jobSummary || jobSummary.failed === 0,
    }
    return {
      ok: Object.values(checks).every(Boolean),
      checks,
      plugin: info.name ?? 'dsh-container-manager',
      version: info.version ?? null,
      commit: info.commit ?? null,
      installMode: info.installMode ?? 'unknown',
      nodes: nodes.map(entry => publicNode(entry)),
      helperHint: helperHint(),
      config: {
        confirmRequired: config.confirmRequired,
        confirmTtlSeconds: config.confirmTtlSeconds,
        allowLogs: config.allowLogs,
        dataDir: configStore.file.replace(/\/config\.json$/, ''),
      },
      pending: pendings.list({ includeFinished: false }).length,
      jobs: jobSummary,
      auditError: auditHealth.lastError,
      at: new Date().toISOString(),
    }
  }

  return { handle }
}

// helper 认哪些资源字段，这里就只转发哪些。
// 拼错一个键不会被悄悄忽略，而是直接挡在路由外面。
const RESOURCE_FIELDS = [
  'cores', 'cpuQuota', 'cpuWeight',
  'memory', 'memoryHigh', 'swap', 'oomGroup',
  'pids', 'ioWeight',
  'hostname', 'autostart', 'startOrder', 'startDelay', 'initCmd', 'capDrop',
]

/**
 * 重建式改配置的字段白名单。别直接透传 body —— 里面还有 node / principal 之类的东西，
 * 而且没在上面的字段一律不该进 podman run。
 */
const RECREATE_FIELDS = [
  'ports', 'volumes', 'env', 'restart', 'command', 'entrypoint', 'network',
  'hostname', 'user', 'workdir', 'privileged', 'autoRemove', 'pidsLimit',
  'capAdd', 'capDrop', 'securityOpt',
  'memory', 'memoryReservation', 'memorySwap', 'cpus', 'cpuShares', 'cpusetCpus', 'blkioWeight',
]

function pickRecreatePatch(body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const field of RECREATE_FIELDS) {
    if (!(field in body)) continue
    patch[field] = body[field]
  }
  return patch
}

function pickResourcePatch(body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const field of RESOURCE_FIELDS) {
    if (!(field in body)) continue
    const raw = body[field]
    if (field === 'autostart' || field === 'oomGroup') patch[field] = Boolean(raw)
    else patch[field] = raw === null ? '' : String(raw)
  }
  return patch
}

function publicNode(entry) {
  return {
    id: entry.node.id,
    label: entry.node.label,
    kind: entry.node.kind,
    transport: entry.node.transport,
    available: entry.available,
    code: entry.code,
    reason: entry.reason,
    hint: entry.hint,
    hintText: entry.hintText ?? null,
    detail: entry.detail ?? null,
  }
}

function publicConfig(config) {
  return {
    version: config.version,
    nodes: config.nodes,
    confirmRequired: config.confirmRequired,
    confirmTtlSeconds: config.confirmTtlSeconds,
    allowLogs: config.allowLogs,
    logTailDefault: config.logTailDefault,
    logTailMax: config.logTailMax,
    compose: config.compose ?? null,
  }
}
