/**
 * 危险操作预演（dry-run）
 *
 * 待确认抽屉里现在只有一句 summary。人点「确认」的时候其实在赌博：
 * 这个卷还有人用吗？这个容器属于哪个 compose 项目？删掉会不会有人替我重建？
 *
 * 这里把答案在确认之前摆出来。三条约束：
 *  1. 只读：预演绝不改动任何状态，失败也不抛 —— 读不到就写「读不到」，不能因此卡住流程。
 *  2. 不编：探不到的项写成 warn 并说明原因，不用「大概」「应该」填空。
 *  3. 快：只查跟这次操作有关的对象，不做全量扫描。
 */

const TONE = { danger: 'danger', warn: 'warn', info: 'info', ok: 'ok' }

function item(tone, text) {
  return { tone: TONE[tone] ?? 'info', text: String(text) }
}

function mountLines(mounts) {
  return mounts.map(mount => {
    const source = mount.source || mount.Name || '?'
    const destination = mount.destination || mount.Destination || '?'
    const writable = mount.rw === false ? '（只读）' : ''
    const kind = mount.type === 'volume' || mount.Type === 'volume'
      ? '卷'
      : mount.type === 'bind' || mount.Type === 'bind' ? '绑定' : (mount.type || mount.Type || '挂载')
    return kind + ' ' + source + ' → ' + destination + writable
  })
}

export function createPlanner({ registry, compose = null } = {}) {
  function driverOf(node) {
    if (!registry) return null
    try {
      return registry.driverFor(registry.find(node))
    } catch {
      return null
    }
  }

  async function safe(fn, fallback = null) {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }

  /** 容器删除：停不停、挂什么、属于谁、会不会有人替你重建。 */
  async function describeContainerDelete(node, target, verb) {
    const items = []
    const detail = await safe(() => registry.inspect(node, target))
    if (!detail) {
      items.push(item('warn', '读不到容器详情（可能已经不存在，或节点一时连不上）。删除仍会照常尝试。'))
      return { items, blockers: [] }
    }
    items.push(item('danger', verb === 'destroy'
      ? '销毁容器 ' + target + '：rootfs 与配置一起删掉，找不回来。'
      : '删除容器 ' + target + '：容器本身没了，镜像不删。'))
    if (detail.running) items.push(item('warn', '它现在在运行，会先发停止信号；十秒内没退就强杀。'))
    const mounts = Array.isArray(detail.mounts) ? detail.mounts : []
    if (mounts.length > 0) {
      items.push(item('info', '挂载 ' + mounts.length + ' 处：'))
      for (const line of mountLines(mounts)) items.push(item('info', '· ' + line))
      const volumes = mounts.filter(mount => (mount.type || mount.Type) === 'volume')
      if (volumes.length > 0) {
        items.push(item('ok', '卷本身会保留：' + volumes.map(mount => mount.source || mount.Name).join('、')
          + '（要清数据得另外删卷）'))
      }
    }
    const networks = Array.isArray(detail.networks) ? detail.networks : []
    const networkNames = networks
      .map(entry => (typeof entry === 'string' ? entry : entry && entry.name))
      .filter(Boolean)
    if (networkNames.length > 0) items.push(item('info', '会从这些网络里摘掉：' + networkNames.join('、')))
    const ports = Array.isArray(detail.ports) ? detail.ports.filter(port => port.hostPort) : []
    if (ports.length > 0) {
      items.push(item('info', '腾出宿主端口：'
        + ports.map(port => port.hostPort + '/' + (port.protocol || 'tcp')).join('、')))
    }
    const labels = detail.labels && typeof detail.labels === 'object' ? detail.labels : {}
    const project = labels['com.docker.compose.project'] || labels['io.podman.compose.project']
    if (project) {
      items.push(item('warn', '这个容器属于 compose 项目 ' + project
        + '。删掉之后下次 compose up 会照 compose 文件重建一个同名容器 —— 现在删它不等于把它从项目里去掉。'))
    }
    if (detail.image) items.push(item('ok', '镜像 ' + detail.image + ' 不会被动。'))
    return { items, blockers: [] }
  }

  async function describeImageDelete(node, reference) {
    const items = []
    const driver = driverOf(node)
    const usage = driver && typeof driver.imageUsage === 'function'
      ? await safe(() => driver.imageUsage(reference), null)
      : null
    items.push(item('danger', '删除镜像 ' + reference + '：本地这份没了，要再拉一次。'))
    if (usage === null) {
      items.push(item('warn', '没能确认还有没有容器在用这个镜像；如果它在用，删的时候会被拦下来。'))
    } else if (usage.length > 0) {
      items.push(item('warn', '这些容器还在用它：' + usage.join('、') + '（Podman 会因此拒绝删除，除非强制）。'))
    } else {
      items.push(item('ok', '没有容器在使用这个镜像。'))
    }
    return { items, blockers: [] }
  }

  async function describeVolumeDelete(node, name) {
    const items = []
    const driver = driverOf(node)
    const usage = driver && typeof driver.volumeUsage === 'function'
      ? await safe(() => driver.volumeUsage(name), null)
      : null
    items.push(item('danger', '删除卷 ' + name + '：卷里的数据一起没，找不回来。'))
    const blockers = []
    if (usage === null) {
      items.push(item('warn', '没能确认这个卷还有没有容器挂着；有的话删卷会被拒绝。'))
    } else if (usage.length > 0) {
      blockers.push('卷 ' + name + ' 仍被 ' + usage.join('、') + ' 使用')
      items.push(item('warn', '有容器还在挂它：' + usage.join('、') + '。要先停掉或改挂载，否则 Podman 不会让你删。'))
    } else {
      items.push(item('ok', '当前没有容器挂这个卷。'))
    }
    return { items, blockers }
  }

  async function describeSnapshot(node, name, args) {
    const op = String(args.op || '')
    const items = []
    if (op === 'create') {
      items.push(item('info', '给 ' + name + ' 打一份快照' + (args.snapshot ? '（' + args.snapshot + '）' : '') + '。'))
      items.push(item('warn', 'ext4 + loop 上的快照是整份复制：占同样大的空间，也慢。btrfs/zfs 上才是秒级。'))
    } else if (op === 'restore') {
      items.push(item('danger', '把 ' + name + ' 回滚到快照 ' + (args.snapshot || '?') + '：快照之后的改动全部丢失。'))
      items.push(item('warn', '回滚通常需要先停机，容器会中断一下。'))
    } else if (op === 'delete') {
      items.push(item('info', '只删快照 ' + (args.snapshot || '?') + ' 这份记录，容器本身不动。'))
    }
    return { items, blockers: [] }
  }

  async function describeMounts(node, name, nextMounts) {
    const items = []
    const current = await safe(() => registry.readMounts(node, name), null)
    if (!current) {
      items.push(item('warn', '读不到当前挂载点，下面只能列「提交后会是这些」。'))
    }
    const text = mount => (mount.host || mount.Host || '?') + ' → ' + (mount.target || mount.Target || '?')
    const before = new Set((current && Array.isArray(current.mounts) ? current.mounts : []).map(text))
    const after = new Set((Array.isArray(nextMounts) ? nextMounts : []).map(text))
    let changed = false
    for (const entry of after) {
      if (!before.has(entry)) {
        items.push(item('info', '新增挂载 ' + entry))
        changed = true
      }
    }
    for (const entry of before) {
      if (!after.has(entry)) {
        items.push(item('warn', '移除挂载 ' + entry))
        changed = true
      }
    }
    if (!changed) items.push(item('ok', '挂载点没有变化。'))
    if (changed) items.push(item('info', '改挂载点要重写容器配置，容器需要重启才生效。'))
    return { items, blockers: [] }
  }

  async function describeComposeDown(name) {
    const items = []
    if (!compose) return { items: [item('warn', 'compose 子系统没接上，无法预演。')], blockers: [] }
    const detail = await safe(() => compose.detail(name))
    if (!detail) return { items: [item('warn', '读不到项目 ' + name + ' 的状态。')], blockers: [] }
    const counts = detail.counts || {}
    items.push(item('danger', '停止并移除项目 ' + name + ' 的容器：'
      + (counts.running ?? 0) + ' 个在跑，共 ' + (counts.total ?? 0) + ' 个。'))
    const services = Array.isArray(detail.services)
      ? detail.services.map(service => service.name || service.service).filter(Boolean)
      : []
    if (services.length > 0) items.push(item('info', '涉及服务：' + services.join('、')))
    items.push(item('ok', 'bind mount 出来的宿主数据、命名卷、网络都不会被删。'))
    return { items, blockers: [] }
  }

  async function describeNetworkRemove(node, name) {
    const items = []
    items.push(item('danger', '删除网络 ' + name + '。'))
    const driver = driverOf(node)
    const containers = driver ? await safe(() => driver.listContainers(), []) : []
    const attached = (Array.isArray(containers) ? containers : [])
      .filter(container => Array.isArray(container.networks) && container.networks.includes(name))
      .map(container => container.name)
    const blockers = []
    if (!driver) {
      items.push(item('warn', '节点连不上，没法确认网络里还挂着哪些容器。'))
    } else if (attached.length > 0) {
      blockers.push('网络 ' + name + ' 里还有 ' + attached.join('、'))
      items.push(item('warn', '这些容器还接着它：' + attached.join('、') + '。网络里有容器时删除会被拒绝。'))
    } else {
      items.push(item('ok', '没有容器接在这个网络上。'))
    }
    return { items, blockers }
  }

  async function describeCommit(node, target, args) {
    const image = String(args.image || args.target || '')
    const items = [
      item('warn', '把容器 ' + target + ' 当前的文件系统提交成镜像 ' + image
        + '：整层复制，容器越大越慢，也越占盘。'),
      item('info', '提交的是「这一刻」的状态，容器里正在写的文件可能不一致；有条件的话先停容器。'),
    ]
    const driver = driverOf(node)
    const images = driver ? await safe(() => driver.listImages(), null) : null
    const list = Array.isArray(images) ? images : (images && Array.isArray(images.images) ? images.images : null)
    if (list) {
      const clash = list.find(entry => {
        const reference = String(entry.reference || entry.name || (Array.isArray(entry.RepoTags) ? entry.RepoTags.join(',') : ''))
        return reference === image
      })
      if (clash) items.push(item('danger', '已经有一个同名镜像 tag，提交会把它覆盖掉。'))
    }
    return { items, blockers: [] }
  }

  return {
    /**
     * 给一条待确认生成预演。永远不抛：读不到就写读不到。
     * @returns {Promise<{items: Array<{tone:string,text:string}>, blockers: string[]}|null>}
     */
    async describe(input) {
      const node = input && input.node ? String(input.node) : ''
      const kind = input && input.kind ? String(input.kind) : ''
      const target = input && input.target != null ? String(input.target) : ''
      const args = (input && input.args) || {}
      const verb = String((input && input.action) || args.action || '').toLowerCase()
      try {
        if (kind === 'container.action' && (verb === 'delete' || verb === 'destroy')) {
          return await describeContainerDelete(node, target, verb)
        }
        if (kind === 'image.delete') return await describeImageDelete(node, String(args.reference || target))
        if (kind === 'volume.delete') return await describeVolumeDelete(node, String(args.name || target))
        if (kind === 'lxc.snapshot') return await describeSnapshot(node, target, args)
        if (kind === 'lxc.mounts') return await describeMounts(node, target, args.mounts || [])
        if (kind === 'compose.down') return await describeComposeDown(String(args.name || target))
        if (kind === 'network.operation' && String(args.op || '') === 'remove') {
          return await describeNetworkRemove(node, String(args.name || target))
        }
        if (kind === 'container.commit') return await describeCommit(node, target, args)
        return null
      } catch (error) {
        return {
          items: [item('warn', '预演没跑起来：' + (error && error.message ? error.message : String(error)))],
          blockers: [],
        }
      }
    },
  }
}
