/**
 * 节点注册表
 *
 * 一个节点 = 一台机器上的一个运行时（本机 Podman / 本机 LXC / 以后 SSH 上的 Podman）。
 * 驱动负责「怎么连」，这里负责「有哪些节点、谁可用、把结果摊平」。
 */

import { CmError, ERR, asCmError } from './util.js'
import { createPodmanDriver } from './drivers/podman.js'
import { createLxcDriver } from './drivers/lxc.js'
import { stats as collectStats } from './stats.js'

const PROBE_CACHE_MS = 5000

export function createNodeRegistry(configStore, options = {}) {
  /** @type {Map<string, {node: any, driver: any}>} */
  const cache = new Map()
  /** @type {Map<string, {at: number, value: any}>} */
  const probes = new Map()

  function nodes() {
    return configStore.get().nodes
  }

  function find(id) {
    const node = nodes().find(item => item.id === id)
    if (!node) throw new CmError(ERR.NODE_UNAVAILABLE, `没有这个节点：${id}`, '先 GET /nodes 看看有哪些节点。')
    return node
  }

  function driverFor(node) {
    const cached = cache.get(node.id)
    const key = JSON.stringify(node)
    if (cached && cached.key === key) return cached.driver
    let driver
    if (node.kind === 'podman') driver = createPodmanDriver(node, options.podman ?? {})
    else if (node.kind === 'lxc') driver = createLxcDriver(node, { helperHint: options.helperHint, ...(options.lxc ?? {}) })
    else throw new CmError(ERR.BAD_ARGS, `节点 ${node.id} 的 kind 不认识：${node.kind}`)
    cache.set(node.id, { key, driver })
    return driver
  }

  async function probe(node, { force = false } = {}) {
    const now = Date.now()
    const cached = probes.get(node.id)
    if (!force && cached && now - cached.at < PROBE_CACHE_MS) {
      return { ...cached.value, node: { ...node } }
    }
    let value
    try {
      const driver = driverFor(node)
      const availability = await driver.available()
      value = availability.ok
        ? { available: true, code: null, reason: null, hint: null, detail: await describe(node) }
        : {
          available: false,
          code: availability.code ?? ERR.NODE_UNAVAILABLE,
          reason: availability.reason ?? '不可用',
          hint: availability.hint ?? null,
          detail: null,
        }
    } catch (error) {
      const cm = asCmError(error, ERR.NODE_UNAVAILABLE)
      value = { available: false, code: cm.code, reason: cm.message, hint: cm.hint ?? null, detail: null }
    }
    probes.set(node.id, { at: now, value })
    return { ...value, node: { ...node } }
  }

  async function describe(node) {
    const driver = driverFor(node)
    if (node.kind === 'podman') {
      const info = await driver.info()
      if (!info.ok) return null
      return {
        version: info.version,
        rootless: info.rootless,
        networkBackend: info.networkBackend,
        kernel: info.kernel,
        cgroupVersion: info.cgroupVersion,
      }
    }
    if (node.kind === 'lxc') {
      const health = await driver.health()
      return health.ok ? { lxc: health.lxc, version: health.version, macvlan: health.macvlan, lxcbr0: health.lxcbr0 } : null
    }
    return null
  }

  function clearProbe(id) {
    if (id) probes.delete(id)
    else probes.clear()
  }

  /** 所有节点的探测结果（并发的）。 */
  async function probeAll(options2 = {}) {
    return Promise.all(nodes().map(node => probe(node, options2)))
  }

  /**
   * 前端要的一份快照：节点 + 容器 + 网络 + 出错信息。
   * 单个节点坏掉不影响其它节点。
   */
  async function snapshot({ force = false } = {}) {
    const probed = await probeAll({ force })
    const containers = []
    const networks = []
    const errors = []

    await Promise.all(probed.map(async (entry) => {
      if (!entry.available) return
      const driver = driverFor(entry.node)
      const [containerResult, networkResult] = await Promise.allSettled([
        driver.listContainers(),
        driver.listNetworks(),
      ])
      if (containerResult.status === 'fulfilled') {
        for (const container of containerResult.value) {
          containers.push({ ...container, nodeId: entry.node.id, nodeLabel: entry.node.label })
        }
      } else {
        errors.push({ nodeId: entry.node.id, scope: 'containers', message: asCmError(containerResult.reason).message })
      }
      if (networkResult.status === 'fulfilled') {
        for (const network of networkResult.value) {
          networks.push({ ...network, nodeId: entry.node.id })
        }
      } else {
        errors.push({ nodeId: entry.node.id, scope: 'networks', message: asCmError(networkResult.reason).message })
      }
    }))

    return {
      nodes: probed.map(entry => ({
        id: entry.node.id,
        label: entry.node.label,
        kind: entry.node.kind,
        transport: entry.node.transport,
        available: entry.available,
        code: entry.code,
        reason: entry.reason,
        hint: entry.hint,
        detail: entry.detail ?? null,
        hintText: nodeHint(entry),
      })),
      containers,
      networks,
      errors,
      at: new Date().toISOString(),
    }
  }

  function nodeHint(entry) {
    if (entry.available) return null
    if (entry.node.kind === 'lxc' && entry.code === ERR.HELPER_DOWN) {
      return typeof options.helperHint === 'function' ? options.helperHint() : 'sudo bash helper/install-helper.sh'
    }
    if (entry.node.kind === 'podman' && entry.code === ERR.MISSING_BINARY) return '装 podman 或确认 PATH。'
    return entry.hint ?? null
  }

  async function inspect(nodeId, ref) {
    const node = find(nodeId)
    const driver = driverFor(node)
    return driver.inspect(ref)
  }

  async function logs(nodeId, ref, tail) {
    const node = find(nodeId)
    const config = configStore.get()
    if (!config.allowLogs) throw new CmError(ERR.BAD_ARGS, '日志读取被配置关掉了（allowLogs=false）。')
    const driver = driverFor(node)
    return driver.logs(ref, tail)
  }

  async function act(nodeId, ref, action) {
    const node = find(nodeId)
    const driver = driverFor(node)
    const result = await driver.act(ref, action)
    clearProbe(nodeId)
    return result
  }

  async function createContainer(nodeId, spec) {
    const node = find(nodeId)
    const driver = driverFor(node)
    if (typeof driver.create !== 'function') {
      throw new CmError(ERR.BAD_ARGS, `${node.kind} 节点不支持创建容器。`)
    }
    const raw = await driver.create(spec)
    clearProbe(nodeId)
    if (node.kind === 'lxc') {
      // LXC 的「启动项」是写进 config 的，不是 lxc-create 的参数，所以建完再改；
      // 改动发生在创建流程里，和用户勾选的参数一致，不单独挂 pending。
      const patch = {}
      if (spec.memoryMax) patch.memoryMax = spec.memoryMax
      if (spec.swapMax) patch.swapMax = spec.swapMax
      if (spec.cores) patch.cores = spec.cores
      if (spec.autostart) patch.autostart = true
      let settings = null
      if (Object.keys(patch).length > 0) {
        try {
          settings = (await driver.setConfig(spec.name, patch))?.settings ?? null
        } catch (error) {
          // 容器已经建好了，配置写失败要如实带出来，不能当成功。
          throw new CmError(
            (typeof error?.code === 'string' && error.code) || ERR.INTERNAL,
            `容器 ${spec.name} 已创建，但启动项写入失败：${error?.message ?? error}`,
            `手工改 /var/lib/lxc/${spec.name}/config，或先删掉这个容器重来。`,
          )
        }
      }
      const warnings = []
      if (spec.start) {
        try {
          await driver.act(spec.name, 'start')
        } catch (error) {
          throw new CmError(
            (typeof error?.code === 'string' && error.code) || ERR.INTERNAL,
            `容器 ${spec.name} 已创建，但启动失败：${error?.message ?? error}`,
            `用 lxc-start -n ${spec.name} -F 看前台日志。`,
          )
        }
        // 挂的不是 lxc-net 的 NAT 桥时，容器内没有 DHCP 客户端会自己跑，补一步。
        // 配静态地址的容器不需要。
        const link = spec.network && spec.network.link ? String(spec.network.link) : ''
        const wantsDhcp = link && link !== 'lxcbr0' && !(spec.network && spec.network.ipv4 && spec.network.ipv4.address)
        if (wantsDhcp && typeof driver.configureDhcp === 'function') {
          try {
            const result = await driver.configureDhcp(spec.name)
            if (result && result.configured === false && result.reason) warnings.push('DHCP：' + result.reason)
          } catch (error) {
            // 容器已经建好也起来了，这只是网络没配好，不该把创建判成失败。
            warnings.push('DHCP 没配成功：' + (error?.message ?? error) + '。进容器手动跑一次 udhcpc -i eth0。')
          }
        }
      }
      const detail = await driver.inspect(spec.name).catch(() => null)
      return {
        nodeId,
        kind: 'lxc',
        name: spec.name,
        id: detail?.id ?? null,
        state: detail?.state ?? raw?.state ?? (spec.start ? 'running' : 'stopped'),
        distro: spec.distro,
        release: spec.release,
        arch: spec.arch,
        settings,
        warnings,
        detail,
      }
    }
    const detail = raw?.detail ?? null
    return {
      nodeId,
      kind: 'podman',
      name: detail?.name ?? spec.name ?? raw?.id ?? '',
      id: raw?.id ?? detail?.id ?? '',
      state: detail?.state ?? 'created',
      warnings: raw?.warnings ?? [],
      uts: raw?.uts ?? null,
      detail,
    }
  }

  async function updatePodmanCgroup(nodeId, ref, limits) {
    const node = find(nodeId)
    if (node.kind !== 'podman') throw new CmError(ERR.BAD_ARGS, '资源限制只支持 Podman 节点。')
    const driver = driverFor(node)
    if (typeof driver.updateCgroup !== 'function') throw new CmError(ERR.BAD_ARGS, '这个驱动不支持改 cgroup 限制。')
    const result = await driver.updateCgroup(ref, limits)
    clearProbe(nodeId)
    return result
  }

  async function setLxcConfig(nodeId, name, patch) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '启动项编辑只支持 LXC 节点。')
    const driver = driverFor(node)
    if (typeof driver.setConfig !== 'function') throw new CmError(ERR.HELPER_DOWN, '当前 helper 版本不支持改配置。', '重跑 sudo bash helper/install-helper.sh 升级 helper。')
    const result = await driver.setConfig(name, patch)
    clearProbe(nodeId)
    return result
  }

  /** 改 LXC 的 CPU 核数 / 内存 / swap：写 config 持久化，在跑就同时写 cgroup 立即生效。 */
  async function setLxcResources(nodeId, name, patch) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '资源调整只支持 LXC 节点。')
    const driver = driverFor(node)
    if (typeof driver.setResources !== 'function') {
      throw new CmError(ERR.HELPER_DOWN, '当前 helper 版本不支持改资源。', '重跑 sudo bash helper/install-helper.sh 升级 helper。')
    }
    const result = await driver.setResources(name, patch)
    clearProbe(nodeId)
    return result
  }

  /** 这个节点是 podman 还是 lxc —— 上层按它分流，别自己再去找。 */
  function kindOf(nodeId) {
    return find(nodeId).kind
  }

  /**
   * 镜像列表。两种节点返回的形状不一样，故意不强行统一：
   * Podman 是本地镜像库（数组），LXC 是系统镜像缓存（{ images, count, total, root }）。
   * 前端按 kind 分开渲染，比塞进同一个壳里塞一堆 if 清楚。
   */
  async function listImages(nodeId) {
    const node = find(nodeId)
    const driver = driverFor(node)
    if (typeof driver.listImages !== 'function') return node.kind === 'podman' ? [] : { images: [], count: 0, total: 0 }
    return driver.listImages()
  }

  async function deleteLxcImage(nodeId, name) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '只有 LXC 节点有系统镜像缓存。')
    const driver = driverFor(node)
    if (typeof driver.deleteImage !== 'function') {
      throw new CmError(ERR.HELPER_DOWN, '当前 helper 版本不支持删镜像缓存。', '重跑 sudo bash helper/install-helper.sh 升级 helper。')
    }
    const result = await driver.deleteImage(name)
    clearProbe(nodeId)
    return result
  }

  async function lxcStorage(nodeId) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '只有 LXC 节点有存储统计。')
    const driver = driverFor(node)
    if (typeof driver.storage !== 'function') {
      throw new CmError(ERR.HELPER_DOWN, '当前 helper 版本不支持存储统计。', '重跑 sudo bash helper/install-helper.sh 升级 helper。')
    }
    return driver.storage()
  }

  async function networkOp(nodeId, op) {
    const node = find(nodeId)
    const driver = driverFor(node)
    const result = await driver.net(op)
    if (['create', 'remove', 'connect', 'disconnect'].includes(String(op?.op))) clearProbe(nodeId)
    return result
  }

  async function lxcNetwork(nodeId, name) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '这个节点不是 LXC。')
    const driver = driverFor(node)
    return driver.getNetwork(name)
  }

  async function lxcNetworkSet(nodeId, name, nics, options2 = {}) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '这个节点不是 LXC。')
    const driver = driverFor(node)
    const result = await driver.setNetwork(name, nics, options2)
    clearProbe(nodeId)
    return result
  }

  async function hostInfo(nodeId) {
    const node = find(nodeId)
    if (node.kind === 'lxc') {
      const driver = driverFor(node)
      const [host, health] = await Promise.all([driver.netHost(), driver.health({ force: true })])
      return { host, health }
    }
    const driver = driverFor(node)
    return { info: await driver.info({ force: true }) }
  }

  async function ensureModule(nodeId, name) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '只有 LXC helper 能代劳 modprobe。')
    const driver = driverFor(node)
    return driver.ensureModule(name)
  }

  /**
   * 只汇总某一类运行时的容器。
   * compose 页只要 podman —— 不该因为 LXC helper 慢或没装就把整页拖成空白。
   * 单个节点失败只丢那一个节点，不吞成「一个容器都没有」的静默错误。
   */
  async function containersOfKind(kind) {
    const bundle = []
    const failures = []
    for (const node of nodes()) {
      if (node.kind !== kind) continue
      try {
        const list = await driverFor(node).listContainers()
        for (const container of list) bundle.push({ ...container, nodeId: node.id })
      } catch (error) {
        failures.push({ nodeId: node.id, reason: asCmError(error).message })
      }
    }
    return { containers: bundle, failures }
  }

  function firstOfKind(kind) {
    return nodes().find(node => node.kind === kind) ?? null
  }

  /** 镜像与卷是 Podman 的概念；LXC 节点上来问就直接说清楚。 */
  function podmanDriver(nodeId) {
    const node = find(nodeId)
    if (node.kind !== 'podman') throw new CmError(ERR.BAD_ARGS, '镜像与卷只对 Podman 节点有意义。')
    return driverFor(node)
  }

  async function listVolumes(nodeId) {
    return podmanDriver(nodeId).listVolumes()
  }

  async function pullImage(nodeId, reference) {
    const result = await podmanDriver(nodeId).pullImage(reference)
    clearProbe(nodeId)
    return result
  }

  async function deleteImage(nodeId, reference) {
    const result = await podmanDriver(nodeId).deleteImage(reference)
    clearProbe(nodeId)
    return result
  }

  async function deleteVolume(nodeId, name) {
    const result = await podmanDriver(nodeId).deleteVolume(name)
    clearProbe(nodeId)
    return result
  }

  /** 快照 / 克隆 / 挂载点是 LXC 独有的（Podman 那边靠 compose 文件与卷）。 */
  function lxcDriver(nodeId) {
    const node = find(nodeId)
    if (node.kind !== 'lxc') throw new CmError(ERR.BAD_ARGS, '快照、克隆、挂载点只对 LXC 容器有意义。')
    return driverFor(node)
  }

  async function listSnapshots(nodeId, name) {
    return lxcDriver(nodeId).listSnapshots(name)
  }

  async function lxcSnapshot(nodeId, name, op, options) {
    const result = await lxcDriver(nodeId).snapshot(name, op, options)
    clearProbe(nodeId)
    return result
  }

  async function cloneLxc(nodeId, name, newName) {
    const result = await lxcDriver(nodeId).clone(name, newName)
    clearProbe(nodeId)
    return result
  }

  async function readMounts(nodeId, name) {
    return lxcDriver(nodeId).readMounts(name)
  }

  async function setMounts(nodeId, name, mounts) {
    const result = await lxcDriver(nodeId).setMounts(name, mounts)
    clearProbe(nodeId)
    return result
  }

  return {
    nodes,
    find,
    driverFor,
    containersOfKind,
    firstOfKind,
    probe,
    probeAll,
    snapshot,
    inspect,
    logs,
    act,
    createContainer,
    updatePodmanCgroup,
    setLxcConfig,
    setLxcResources,
    kindOf,
    listImages,
    deleteLxcImage,
    lxcStorage,
    listVolumes,
    pullImage,
    deleteImage,
    deleteVolume,
    listSnapshots,
    lxcSnapshot,
    cloneLxc,
    readMounts,
    setMounts,
    networkOp,
    lxcNetwork,
    lxcNetworkSet,
    hostInfo,
    async renameContainer(nodeId, ref, newName) {
      const node = find(nodeId)
      if (node.kind !== 'podman') {
        throw new CmError(ERR.BAD_ARGS, '重命名只对 Podman 容器有意义（LXC 要克隆再删，太危险）。')
      }
      return await driverFor(node).rename(ref, newName)
    },
    async commitContainer(nodeId, ref, image) {
      const node = find(nodeId)
      if (node.kind !== 'podman') {
        throw new CmError(ERR.BAD_ARGS, 'LXC 的容器要存成模板，走克隆；commit 只有 Podman 有。')
      }
      return await driverFor(node).commit(ref, image)
    },
    async stats(nodeId, options = {}) {
      const node = find(nodeId)
      const driver = driverFor(node)
      return await collectStats({ driver, transport: node.transport, force: options.force === true })
    },
    ensureModule,
    clearProbe,
  }
}
