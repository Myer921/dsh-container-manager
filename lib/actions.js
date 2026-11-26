/**
 * 业务动作层
 *
 * REST 与 AI 工具共用这一份：危险动作先落 pending，安全动作直接跑。
 * 确认入口只给面板用（见 api.js 的 principal 校验），工具拿不到确认通道。
 */

import { normalizeCreate } from './create-spec.js'
import {
  applyConnectionPatch,
  connectionAddArgs,
  connectionPatchArgs,
  createConnection,
  deleteConnection,
  describeConnectionPatch,
  describeConnectionSpec,
  diagnose as diagnoseHost,
  readConnectionFull,
  readNeighbors,
  readWireguardPeers,
  setConnectionState,
} from './net.js'
import { CmError, ERR, asCmError } from './util.js'

// destroy 是 LXC 那边的「删除」，两套生态的说法都要算危险。
const DANGEROUS_ACTIONS = new Set(['delete', 'destroy'])
const DANGEROUS_NET_OPS = new Set(['create', 'remove', 'connect', 'disconnect'])

// 两套运行时的动词对不上：Podman 用 delete/pause/unpause，LXC 用 destroy/freeze/unfreeze。
// 上层（面板和 AI）统一说 delete/pause/unpause，这里按节点类型翻译。
const LXC_VERB_ALIAS = { delete: 'destroy', pause: 'freeze', unpause: 'unfreeze' }
const PODMAN_VERB_ALIAS = { destroy: 'delete', freeze: 'pause', unfreeze: 'unpause' }

export function createActions({
  registry,
  configStore,
  pendings,
  audit,
  compose = null,
  planner = null,
  jobs = null,
  files = null,
  trash = null,
}) {
  let snapshotRunner = null
  function setSnapshotRunner(runner) {
    snapshotRunner = typeof runner === 'function' ? runner : null
  }

  function log(entry) {
    try {
      audit.append(entry)
    } catch {
      // 审计写不进去不能让操作失败
    }
  }

  function compact(value) {
    if (value === null || value === undefined) return null
    const text = JSON.stringify(value)
    if (text.length <= 4000) return value
    return { truncated: true, preview: text.slice(0, 2000) }
  }

  function confirmRequired() {
    return configStore.get().confirmRequired !== false
  }

  function requireAiAdmin(principal) {
    if (principal !== 'ai') return
    const role = configStore.get().authz?.aiRole ?? 'operator'
    if (role !== 'admin') throw new CmError(ERR.BAD_ARGS, '这个操作需要 admin 角色，并仍然要人在面板确认。')
  }

  function nodeKind(nodeId) {
    const node = configStore.get().nodes.find(item => item.id === nodeId)
    return node?.kind ?? null
  }

  function normalizeVerb(nodeId, action) {
    const verb = String(action)
    const alias = nodeKind(nodeId) === 'lxc' ? LXC_VERB_ALIAS : PODMAN_VERB_ALIAS
    return alias[verb] ?? verb
  }

  /**
   * 长操作统一切口：有队列就入队、立刻返回任务号；没接队列（单元测试）就同步跑。
   * 克隆 / 快照 / 提交都可能跑几分钟，挂在 HTTP 请求里等就是让人看超时。
   */
  function longOp({ kind, node, target, label, principal, run }) {
    if (!jobs) return run({ log: () => {}, report: () => {}, signal: null })
    const job = jobs.enqueue({ kind, node, target, label, principal, cancellable: true, run })
    log({
      principal: principal ?? 'ai',
      action: kind,
      node,
      target,
      result: 'queued',
      detail: { jobId: job.id },
    })
    return {
      status: 'job',
      job: { id: job.id, kind, label, status: job.status },
      message: label + ' 已入队（任务 ' + job.id + '）。进度与输出在「任务」里看。',
    }
  }

  /** 确认之前先把「会发生什么」摆出来；预演读不到也不算失败。 */
  async function beginPending({ node, kind, target, action, args, summary, principal }) {
    let plan = null
    if (planner) {
      plan = await planner.describe({ node, kind, target, action, args })
    }
    const record = pendings.begin({ node, kind, target, action, args, summary, principal, plan })
    log({
      principal: principal ?? 'ai',
      action: 'pending.begin',
      node,
      target,
      kind,
      token: record.token,
      summary,
      result: 'pending',
    })
    return { status: 'pending', ...record, message: summary }
  }

  function describeNetworkArgs(node, args) {
    const op = String(args?.op ?? '')
    const name = String(args?.name ?? '')
    if (op === 'create') {
      const extras = [args?.driver, args?.subnet, args?.gateway].filter(Boolean).join(' / ')
      return `在 ${node} 创建网络 ${name}${extras ? `（${extras}）` : ''}。`
    }
    if (op === 'remove') return `在 ${node} 删除网络 ${name}。`
    if (op === 'connect') return `把容器 ${args?.container} 接入 ${node} 的网络 ${name}。`
    if (op === 'disconnect') return `把容器 ${args?.container} 移出 ${node} 的网络 ${name}。`
    return `${node} 网络操作 ${op}。`
  }

  /** 统一执行器：pending 记录长什么样，这里就怎么执行。 */
  async function perform(record) {
    if (record.kind === 'container.create') {
      return createContainer({ node: record.node, spec: record.args?.spec ?? {}, principal: record.principal ?? 'panel', confirmed: true })
    }
    if (record.kind === 'container.action') {
      const verb = record.action ?? record.args?.action
      if (verb === 'delete' || verb === 'destroy') return trashContainer({ node: record.node, ref: record.target, principal: record.principal })
      return registry.act(record.node, record.target, verb)
    }
    if (record.kind === 'pod.remove') {
      return registry.podAction(record.node, record.target, 'remove')
    }
    if (record.kind === 'network.operation') {
      return registry.networkOp(record.node, record.args)
    }
    if (record.kind === 'lxc.network') {
      return registry.lxcNetworkSet(record.node, record.target, record.args?.nics ?? [], {
        restart: record.args?.restart !== false,
      })
    }
    if (record.kind === 'lxc.config') {
      return registry.setLxcConfig(record.node, record.target, record.args ?? {})
    }
    if (record.kind === 'lxc.resources') {
      return setLxcResources({ node: record.node, name: record.target, patch: record.args ?? {}, principal: record.principal ?? 'panel', confirmed: true })
    }
    if (record.kind === 'compose.up') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.up(record.target, { principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'compose.recreate-service') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.recreateService(record.target, record.args?.service, { principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'compose.rollback-service') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.rollbackService(record.target, record.args?.service, { principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'compose.install-runtime') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.install({ principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'compose.down') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.runDown(record.target, { principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'compose.adopt') {
      if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
      return compose.runAdopt(record.target, { principal: record.principal ?? 'panel' })
    }
    if (record.kind === 'net.connection') {
      return applyConnectionPatch({ name: record.target, patch: record.args?.patch ?? {} })
    }
    if (record.kind === 'net.link') {
      return setConnectionState({ name: record.target, up: record.args?.up !== false })
    }
    if (record.kind === 'net.create') {
      return createConnection(record.args?.spec ?? {})
    }
    if (record.kind === 'net.delete') {
      return deleteConnection(record.target)
    }
    if (record.kind === 'container.commit') {
      const image = record.args?.image ?? record.args?.target
      return longOp({
        kind: 'container.commit',
        node: record.node,
        target: record.target,
        label: '提交镜像 ' + record.target + ' → ' + image,
        principal: record.principal,
        run: ctx => registry.commitContainer(record.node, record.target, image, { signal: ctx.signal }),
      })
    }
    if (record.kind === 'image.delete') {
      return registry.deleteImage(record.node, record.args?.reference ?? record.target)
    }
    if (record.kind === 'lxc.image.delete') {
      return registry.deleteLxcImage(record.node, record.args?.name ?? record.target)
    }
    if (record.kind === 'volume.delete') {
      return registry.deleteVolume(record.node, record.args?.name ?? record.target)
    }
    if (record.kind === 'volume.restore') {
      return volumeRestore({ node: record.node, file: record.args?.file, name: record.args?.name, image: record.args?.image, principal: record.principal ?? 'panel', confirmed: true })
    }
    if (record.kind === 'snapshot.policy.run') {
      if (!snapshotRunner) throw new CmError(ERR.INTERNAL, '定时快照调度器没接上。')
      return snapshotRunner()
    }
    if (record.kind === 'lxc.snapshot') {
      return longOp({
        kind: 'lxc.snapshot.' + String(record.args?.op ?? ''),
        node: record.node,
        target: record.target,
        label: 'LXC 快照 ' + String(record.args?.op ?? '') + '：' + record.target,
        principal: record.principal,
        run: ctx => registry.lxcSnapshot(record.node, record.target, record.args?.op, { ...(record.args ?? {}), signal: ctx.signal, cancelKey: ctx.id }),
      })
    }
    if (record.kind === 'lxc.mounts') {
      return registry.setMounts(record.node, record.target, record.args?.mounts ?? [])
    }
    if (record.kind === 'secret.delete') {
      return registry.secretRemove(record.node, record.args?.name ?? record.target)
    }
    if (record.kind === 'files.write') {
      return files.write({
        node: record.node,
        ref: record.args?.ref,
        path: record.args?.path,
        text: record.args?.text ?? null,
        base64: record.args?.base64 ?? null,
      })
    }
    if (record.kind === 'files.mkdir') {
      return files.mkdir({ node: record.node, ref: record.args?.ref, path: record.args?.path })
    }
    if (record.kind === 'files.remove') {
      return files.remove({ node: record.node, ref: record.args?.ref, path: record.args?.path })
    }
    if (record.kind === 'lxc.import') {
      return lxcImport({ node: record.node, file: record.args?.file, name: record.args?.name, principal: record.principal ?? 'panel', confirmed: true })
    }
    if (record.kind === 'lxc.export.delete') {
      return registry.deleteLxcExport(record.node, record.target, { dir: record.args?.dir ?? undefined })
    }
    if (record.kind === 'podman.recreate') {
      return registry.recreatePodmanContainer(record.node, record.target, record.args?.patch ?? {})
    }
    throw new CmError(ERR.BAD_ARGS, `不认识的待确认类型：${record.kind}`)
  }

  async function trashContainer({ node, ref, principal = 'panel' }) {
    if (nodeKind(node) === 'podman' && trash) {
      const detail = await registry.inspect(node, ref)
      const wasRunning = Boolean(detail.running)
      if (wasRunning) await registry.act(node, ref, 'stop')
      const trashName = 'cm-trash-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      try {
        await registry.renameContainer(node, ref, trashName)
      } catch (error) {
        if (wasRunning) await registry.act(node, ref, 'start').catch(() => {})
        throw error
      }
      const record = trash.add({ node, ref: trashName, originalName: String(ref), kind: 'podman', wasRunning, principal })
      log({ principal, action: 'container.trash', node, target: String(ref), result: 'ok', detail: { trashId: record.id, trashName } })
      return { status: 'trashed', trashId: record.id, ref: trashName, originalName: String(ref) }
    }
    const result = await registry.act(node, ref, nodeKind(node) === 'lxc' ? 'destroy' : 'delete')
    log({ principal, action: 'container.delete', node, target: String(ref), result: 'ok' })
    return result
  }

  async function containerAction({ node, ref, action, principal = 'ai' }) {
    const verb = normalizeVerb(node, action)
    if (DANGEROUS_ACTIONS.has(verb) && confirmRequired()) {
      return beginPending({
        node,
        kind: 'container.action',
        target: String(ref),
        action: verb,
        args: { action: verb },
        principal,
        summary: `删除容器 ${ref}（不可撤销，数据卷不会自动清）。`,
      })
    }
    const result = await registry.act(node, ref, verb)
    log({ principal, action: `container.${verb}`, node, target: String(ref), result: 'ok' })
    return { status: 'done', action: verb, ref: String(ref), result: compact(result) }
  }

  /**
   * 改 Podman 容器那些「只能在 run 那一刻定死」的参数：端口、挂载、环境变量、
   * 重启策略、命令、网络、用户、hostname、pids、capabilities。
   *
   * podman 没有「改容器配置文件」这回事，这条路是重建：先建一个新的、起来之后换名字、
   * 最后删旧的。它会换掉容器 ID，容器内没落在挂载点里的数据会丢 —— 所以走 pending。
   */
  async function recreatePodmanContainer({ node, ref, patch, principal = 'ai' }) {
    if (!ref) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    if (!patch || Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
    if (nodeKind(node) !== 'podman') {
      throw new CmError(ERR.BAD_ARGS, 'LXC 改这些走「配置」页的网卡 / 资源 / 挂载，不用重建。')
    }
    const touched = describeRecreatePatch(patch)
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'podman.recreate',
        target: String(ref),
        action: 'recreate',
        args: { patch },
        principal,
        summary: `重建 Podman 容器 ${ref} 来改：${touched}。会换容器 ID，容器内没挂在卷上的数据会丢。`,
      })
    }
    const result = await registry.recreatePodmanContainer(node, ref, patch)
    log({ principal, action: 'container.recreate', node, target: String(ref), result: 'ok', detail: touched })
    return { status: 'done', ...result }
  }

  function describeRecreatePatch(patch = {}) {
    const parts = []
    if (patch.ports !== undefined) parts.push(`端口 ${(patch.ports ?? []).length} 条`)
    if (patch.volumes !== undefined) parts.push(`挂载 ${(patch.volumes ?? []).length} 条`)
    if (patch.env !== undefined) parts.push(`环境变量 ${Object.keys(patch.env ?? {}).length} 个`)
    if (patch.restart !== undefined) parts.push(`重启策略 ${patch.restart || '默认'}`)
    if (patch.command !== undefined) parts.push('启动命令')
    if (patch.entrypoint !== undefined) parts.push('entrypoint')
    if (patch.network !== undefined) parts.push(`网络 ${patch.network || '默认'}`)
    if (patch.hostname !== undefined) parts.push(`主机名 ${patch.hostname || '默认'}`)
    if (patch.user !== undefined) parts.push(`运行用户 ${patch.user || '镜像默认'}`)
    if (patch.workdir !== undefined) parts.push(`工作目录 ${patch.workdir || '镜像默认'}`)
    if (patch.privileged !== undefined) parts.push(patch.privileged ? '特权模式开' : '特权模式关')
    if (patch.pidsLimit !== undefined) parts.push(`PID 上限 ${patch.pidsLimit || '不限'}`)
    if (patch.capAdd !== undefined) parts.push(`新增 capabilities ${(patch.capAdd ?? []).join(' ') || '无'}`)
    if (patch.capDrop !== undefined) parts.push(`丢弃 capabilities ${(patch.capDrop ?? []).join(' ') || '无'}`)
    if (patch.autoRemove !== undefined) parts.push(patch.autoRemove ? '退出后自动删除' : '退出后保留')
    for (const key of ['memory', 'memoryReservation', 'memorySwap', 'cpus', 'cpuShares', 'cpusetCpus', 'blkioWeight']) {
      if (patch[key] !== undefined) parts.push(`${key} ${patch[key] === '' || patch[key] === null ? '不限' : patch[key]}`)
    }
    return parts.join('，') || '无改动'
  }

  /**
   * 创建容器：直接执行，不挂 pending。
   * 理由：它不删数据、参数在面板上看得见；真正不可撤销的是删除和改配置，那些继续挂起。
   * 校验走 create-spec.js，和 AI 工具同一份。
   */
  async function createContainer({ node, spec, principal = 'ai', confirmed = false }) {
    const kind = nodeKind(node)
    if (!kind) throw new CmError(ERR.BAD_ARGS, `没有这个节点：${node}`)
    const defaults = kind === 'lxc' ? configStore.get().lxcDefaults : null
    const normalized = normalizeCreate(kind, defaults ? { ...defaults, ...(spec ?? {}) } : (spec ?? {}))
    if (normalized.requiresConfirm && !confirmed) {
      requireAiAdmin(principal)
      return beginPending({
        node,
        kind: 'container.create',
        target: String(normalized.name ?? '(自动命名)'),
        action: 'create',
        args: { spec: normalized },
        principal,
        summary: '创建容器 ' + (normalized.name || normalized.image || normalized.distro || '') + '：包含宿主挂载、自定义命令或 host UTS，需要确认。',
      })
    }
    const created = await registry.createContainer(node, normalized)
    log({
      principal,
      action: 'container.create',
      node,
      target: String(created.name ?? ''),
      result: 'ok',
      detail: kind === 'podman'
        ? { kind, image: normalized.image, name: normalized.name ?? null, ports: normalized.ports.length }
        : { kind, image: `${normalized.distro}/${normalized.release}`, arch: normalized.arch, start: normalized.start },
    })
    return { status: 'done', created }
  }

  /** 改名：不删数据、改错了再改回来即可，直接执行。 */
  async function renameContainer({ node, ref, name, principal = 'ai' }) {
    if (!ref) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    const next = String(name ?? '').trim()
    if (!next) throw new CmError(ERR.BAD_ARGS, '新名字不能为空。')
    if (next === String(ref)) throw new CmError(ERR.BAD_ARGS, '新旧名字一样，不用改。')
    const result = await registry.renameContainer(node, ref, next)
    log({ principal, action: 'container.rename', node, target: String(ref), result: 'ok', detail: { to: next } })
    return { status: 'done', ...result }
  }

  /** 提交成镜像：整层复制、占磁盘、删不掉痕迹，走 pending。 */
  async function commitContainer({ node, ref, image, principal = 'ai' }) {
    if (!ref) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    const target = String(image ?? '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '要给个镜像名，比如 local/名字:日期。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'container.commit',
        target: String(ref),
        args: { image: target },
        principal,
        summary: `把容器 ${ref} 提交成镜像 ${target}（整层复制，占磁盘空间）。`,
      })
    }
    return longOp({
      kind: 'container.commit',
      node,
      target: String(ref),
      label: '提交镜像 ' + ref + ' → ' + target,
      principal,
      run: ctx => registry.commitContainer(node, ref, target, { signal: ctx.signal }),
    })
  }

  /** 改 Podman 的 cgroup 限制：可以直接执行，改错了再改回来即可。 */
  async function updatePodmanCgroup({ node, ref, limits, principal = 'ai' }) {
    if (!ref) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    const result = await registry.updatePodmanCgroup(node, ref, limits ?? {})
    log({ principal, action: 'container.limits', node, target: String(ref), result: 'ok', detail: compact(result.applied ?? limits) })
    return { status: 'done', ref: String(ref), applied: result.applied ?? limits ?? {}, detail: compact(result.detail) }
  }

  function describeSettings(patch = {}) {
    const parts = []
    if ('autostart' in patch) parts.push(`开机自启 ${patch.autostart ? '开' : '关'}`)
    if ('memoryMax' in patch) parts.push(patch.memoryMax ? `内存上限 ${patch.memoryMax}` : '内存上限改为不限')
    return parts.join('，') || '无改动'
  }

  /** 资源调整的摘要文案。 */
  function describeResources(patch = {}) {
    const parts = []
    if ('cores' in patch) parts.push(patch.cores ? `CPU 绑 ${patch.cores} 核` : 'CPU 不绑核')
    if ('cpuQuota' in patch) parts.push(patch.cpuQuota ? `CPU 配额 ${patch.cpuQuota} 核` : 'CPU 配额不限')
    if ('cpuWeight' in patch) parts.push(patch.cpuWeight ? `CPU 权重 ${patch.cpuWeight}` : 'CPU 权重回默认')
    if ('memory' in patch) parts.push(patch.memory ? `内存上限 ${patch.memory}` : '内存改为不限')
    if ('memoryHigh' in patch) parts.push(patch.memoryHigh ? `内存软限 ${patch.memoryHigh}` : '内存软限不限')
    if ('swap' in patch) parts.push(patch.swap ? `swap 上限 ${patch.swap}` : 'swap 改为不限')
    if ('oomGroup' in patch) parts.push(patch.oomGroup ? 'OOM 整组终止' : 'OOM 只杀单进程')
    if ('pids' in patch) parts.push(patch.pids ? `PID 上限 ${patch.pids}` : 'PID 不限')
    if ('ioWeight' in patch) parts.push(patch.ioWeight ? `IO 权重 ${patch.ioWeight}` : 'IO 权重回默认')
    if ('hostname' in patch) parts.push(patch.hostname ? `主机名 ${patch.hostname}` : '主机名恢复默认')
    if ('autostart' in patch) parts.push(patch.autostart ? '开机自启开' : '开机自启关')
    if ('startOrder' in patch) parts.push(`启动顺序 ${patch.startOrder || '默认'}`)
    if ('startDelay' in patch) parts.push(`启动延迟 ${patch.startDelay || 0} 秒`)
    if ('initCmd' in patch) parts.push(patch.initCmd ? `init 命令 ${patch.initCmd}` : 'init 命令回默认')
    if ('capDrop' in patch) parts.push(patch.capDrop ? `丢弃 capabilities: ${patch.capDrop}` : '不丢弃 capabilities')
    return parts.join('，') || '无改动'
  }

  /**
   * 改容器配置：可逆、不碰数据，所以直接执行，不走 pending。
   * 资源类的会同时写 cgroup，容器在跑时立即生效；
   * capabilities / init / 启动顺序这些只有下次启动才读，返回里用 restartRequired 说明。
   */
  async function setLxcResources({ node, name, patch, principal = 'ai', confirmed = false }) {
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    if (!patch || Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
    const securityFields = ['capDrop', 'initCmd', 'autostart', 'startOrder', 'startDelay']
    if (!confirmed && securityFields.some(key => key in patch)) {
      requireAiAdmin(principal)
      return beginPending({
        node,
        kind: 'lxc.resources',
        target: String(name),
        action: 'set',
        args: { ...patch },
        principal,
        summary: '修改 LXC ' + name + ' 的安全/启动配置（' + describeResources(patch) + '），需要确认。',
      })
    }
    const result = await registry.setLxcResources(node, name, patch)
    log({ action: 'lxc.resources', node, target: String(name), patch, principal, live: result?.live ?? false })
    return { status: 'done', summary: describeResources(patch), ...result }
  }

  /** 改 LXC 的 config：动的是 root 的文件，照旧挂 pending。 */
  async function setLxcConfig({ node, name, patch, principal = 'ai' }) {
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    if (!patch || Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'lxc.config',
        target: String(name),
        action: 'set',
        args: { ...patch },
        principal,
        summary: `改 LXC 容器 ${name} 的启动项（${describeSettings(patch)}）。`,
      })
    }
    const result = await registry.setLxcConfig(node, name, patch)
    log({ principal, action: 'lxc.config.set', node, target: String(name), result: 'ok', detail: compact(patch) })
    return { status: 'done', result: compact(result) }
  }

  async function podRemove({ node, name, principal = 'ai' }) {
    const pod = String(name ?? '').trim()
    if (!pod) throw new CmError(ERR.BAD_ARGS, '需要 Pod 名。')
    if (confirmRequired()) {
      return beginPending({
        node, kind: 'pod.remove', target: pod, action: 'remove', args: { name: pod }, principal,
        summary: '删除 Podman Pod ' + pod + ' 及其 infra 容器，需要确认。',
      })
    }
    return registry.podAction(node, pod, 'remove')
  }

  async function networkOperation({ node, op, principal = 'ai' }) {
    const verb = String(op?.op ?? '')
    if (DANGEROUS_NET_OPS.has(verb) && confirmRequired()) {
      const name = String(op?.name ?? '')
      return beginPending({
        node,
        kind: 'network.operation',
        target: name,
        action: verb,
        args: { ...op },
        principal,
        summary: describeNetworkArgs(node, op),
      })
    }
    const result = await registry.networkOp(node, op)
    log({ principal, action: `network.${verb}`, node, target: String(op?.name ?? ''), result: 'ok' })
    return { status: 'done', op: verb, result: compact(result) }
  }

  async function setLxcNetwork({ node, name, nics, restart = true, principal = 'ai' }) {
    if (confirmRequired()) {
      const kinds = Array.isArray(nics) ? nics.map(nic => nic?.type ?? '?').join(' / ') : '?'
      return beginPending({
        node,
        kind: 'lxc.network',
        target: String(name),
        action: 'set',
        args: { nics, restart: restart !== false },
        principal,
        summary: `改 LXC 容器 ${name} 的网卡配置（${kinds}）${restart !== false ? '并重启容器' : ''}。`,
      })
    }
    const result = await registry.lxcNetworkSet(node, name, nics, { restart: restart !== false })
    log({ principal, action: 'lxc.network.set', node, target: String(name), result: 'ok' })
    return { status: 'done', result: compact(result) }
  }

  /** 快照的三种操作都会动 rootfs，一律挂起。 */
  async function lxcSnapshot({ node, name, op, options = {}, principal = 'ai', internal = false }) {
    const verb = String(op || '')
    if (!['create', 'restore', 'delete'].includes(verb)) {
      throw new CmError(ERR.BAD_ARGS, '快照操作只支持 create / restore / delete。')
    }
    const summary = verb === 'create'
      ? '给 LXC 容器 ' + name + ' 建快照。ext4 上会整份复制 rootfs，占空间也慢。'
      : verb === 'restore'
        ? '把 LXC 容器 ' + name + ' 回滚到快照 ' + (options.snapshot || '?') + '。当前 rootfs 会被覆盖，容器会停。'
        : '删除 LXC 容器 ' + name + ' 的快照 ' + (options.snapshot || '?') + '。'
    if (confirmRequired() && !internal) {
      return beginPending({
        node,
        kind: 'lxc.snapshot',
        target: String(name),
        action: verb,
        args: { op: verb, snapshot: options.snapshot ?? null, comment: options.comment ?? null },
        principal,
        summary,
      })
    }
    return longOp({
      kind: 'lxc.snapshot.' + verb,
      node,
      target: String(name),
      label: 'LXC 快照 ' + verb + '：' + name,
      principal,
      run: ctx => registry.lxcSnapshot(node, name, verb, { ...options, signal: ctx.signal, cancelKey: ctx.id }),
    })
  }

  async function snapshotPolicyRun({ principal = 'ai' }) {
    if (!snapshotRunner) throw new CmError(ERR.INTERNAL, '定时快照调度器没接上。')
    if (confirmRequired()) {
      return beginPending({
        node: 'lxc', kind: 'snapshot.policy.run', target: 'policy', action: 'run', args: {}, principal,
        summary: '按定时快照策略立刻跑一轮，ext4 上会整份复制 rootfs，需要确认。',
      })
    }
    return snapshotRunner()
  }

  /**
   * 导出 LXC 容器：整份 rootfs 打包，几分钟起步 —— 走任务队列，不等在请求里。
   * 它只读容器、只写一个新的归档文件，所以不需要人确认；但删归档需要。
   */
  async function lxcExport({ node, name, dir, instanceOnly = true, principal = 'ai' }) {
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要容器名。')
    return longOp({
      kind: 'lxc.export',
      node,
      target: String(name),
      label: '导出 ' + name + ' → ' + (dir || '默认目录'),
      principal,
      run: ctx => registry.exportLxc(node, name, { dir, instanceOnly, signal: ctx.signal, cancelKey: ctx.id }),
    })
  }

  async function listLxcExports({ node, dir, principal = 'ai' }) {
    return registry.listLxcExports(node, { dir })
  }

  /** 删归档：这是删备份，照样要人点一下。 */
  async function deleteLxcExport({ node, name, dir, principal = 'ai', internal = false }) {
    const target = String(name || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要归档名。')
    if (confirmRequired() && !internal) {
      return beginPending({
        node,
        kind: 'lxc.export.delete',
        target,
        action: 'delete',
        args: { name: target, dir: dir ?? null },
        principal,
        summary: '删除导出归档 ' + target + '。这份备份会消失，容器本身不动。',
      })
    }
    const result = await registry.deleteLxcExport(node, target, { dir })
    log({ principal, action: 'lxc.export.delete', node, target, result: 'ok' })
    return { status: 'done', ...result }
  }

  /** 导入归档：从一份 .tar.gz 建容器，慢，走队列。 */
  async function lxcImport({ node, file, name, principal = 'ai', confirmed = false }) {
    if (!file) throw new CmError(ERR.BAD_ARGS, '需要归档路径。')
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要新容器名。')
    if (!confirmed) {
      requireAiAdmin(principal)
      return beginPending({
        node,
        kind: 'lxc.import',
        target: String(name),
        action: 'import',
        args: { file: String(file), name: String(name) },
        principal,
        summary: '从归档 ' + file + ' 导入 LXC 容器 ' + name + '，需要确认归档安全性。',
      })
    }
    return longOp({
      kind: 'lxc.import',
      node,
      target: String(name),
      label: '导入 ' + name + ' ← ' + file,
      principal,
      run: ctx => registry.importLxc(node, file, name, { signal: ctx.signal, cancelKey: ctx.id }),
    })
  }

  /* ───────────────────── secrets（Podman 的密钥库） ───────────────────── */

  /**
   * 删 secret 挂起 —— 它可能被好几个容器引用，删完重建容器就拿不到值了。
   * 建 secret 一律拒绝：那要求明文经过模型，等于把密钥写进会话记录。
   */
  async function secretRemove({ node, name, principal = 'ai' }) {
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'secret.delete',
        target: String(name),
        action: 'delete',
        args: { name: String(name) },
        principal,
        summary: '删掉 Podman secret ' + name + '。用到它的容器下次重建就拿不到值了。',
      })
    }
    const result = await registry.secretRemove(node, name)
    log({ principal, action: 'secret.delete', node, target: String(name), detail: {} })
    return { status: 'done', ...result }
  }

  async function secretCreate() {
    throw new CmError(ERR.BAD_ARGS,
      '新建 secret 必须由人在面板里输入明文。',
      '密钥不该经过模型和会话记录：到 Podman 页的「密钥」里直接填名字和值。')
  }

  /* ───────────────────── 容器内文件（AI 侧） ───────────────────── */

  // AI 写容器里的文件一律挂起：这是「改别人机器里的东西」，跟改配置同级。
  // 内容进 pending.json，所以这里把上限压到 256KB —— 大文件本来也不该由模型来写。
  const AI_FILE_LIMIT = 256 * 1024

  async function filesWrite({ node, ref, path, text = null, base64 = null, principal = 'ai' }) {
    if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
    const target = String(path ?? '')
    const bytes = base64 != null
      ? Buffer.from(String(base64), 'base64').length
      : Buffer.byteLength(String(text ?? ''), 'utf8')
    if (bytes > AI_FILE_LIMIT) {
      throw new CmError(ERR.BAD_ARGS,
        `AI 一次最多写 ${AI_FILE_LIMIT / 1024}KB（这次 ${Math.round(bytes / 1024)}KB）。`,
        '大文件请由人在面板的「文件」里改，或者用终端。')
    }
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'files.write',
        target: String(ref),
        action: 'write',
        args: { ref: String(ref), path: target, text, base64 },
        principal,
        summary: '改容器 ' + ref + ' 里的文件 ' + target + '（' + Math.round(bytes / 1024) + 'KB）。' +
          '原来的内容会被覆盖，删了就找不回来。',
      })
    }
    const result = await files.write({ node, ref, path: target, text, base64 })
    log({ principal, action: 'files.write', node, target: String(ref), detail: { path: target, bytes } })
    return { status: 'done', ...result }
  }

  async function filesMkdir({ node, ref, path, principal = 'ai' }) {
    if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'files.mkdir',
        target: String(ref),
        action: 'mkdir',
        args: { ref: String(ref), path: String(path ?? '') },
        principal,
        summary: '在容器 ' + ref + ' 里建目录 ' + path + '（父目录不存在就一起建）。',
      })
    }
    const result = await files.mkdir({ node, ref, path })
    log({ principal, action: 'files.mkdir', node, target: String(ref), detail: { path } })
    return { status: 'done', ...result }
  }

  async function filesRemove({ node, ref, path, principal = 'ai' }) {
    if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'files.remove',
        target: String(ref),
        action: 'remove',
        args: { ref: String(ref), path: String(path ?? '') },
        principal,
        summary: '删容器 ' + ref + ' 里的 ' + path + '（目录会连同内容一起删）。',
      })
    }
    const result = await files.remove({ node, ref, path })
    log({ principal, action: 'files.remove', node, target: String(ref), detail: { path } })
    return { status: 'done', ...result }
  }

  /** 改挂载点会写宿主上的 LXC config，挂起。 */
  async function lxcSetMounts({ node, name, mounts, principal = 'ai' }) {
    if (!Array.isArray(mounts)) throw new CmError(ERR.BAD_ARGS, 'mounts 得是数组。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'lxc.mounts',
        target: String(name),
        action: 'set',
        args: { mounts },
        principal,
        summary: '改 LXC 容器 ' + name + ' 的挂载点（' + mounts.length + ' 条）。会写宿主上的 config，重启后生效。',
      })
    }
    const result = await registry.setMounts(node, name, mounts)
    log({ principal, action: 'lxc.mounts.set', node, target: String(name), result: 'ok' })
    return { status: 'done', ...result }
  }

  /** 克隆只是复制，不动源容器，直接执行。 */
  async function lxcClone({ node, name, newName, principal = 'ai' }) {
    const target = String(newName || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要新容器名。')
    return longOp({
      kind: 'lxc.clone',
      node,
      target,
      label: '克隆 LXC ' + name + ' → ' + target,
      principal,
      run: ctx => registry.cloneLxc(node, name, target, { signal: ctx.signal, cancelKey: ctx.id }),
    })
  }

  /** 拉镜像不动现有的东西，直接执行。 */
  async function imagePull({ node, reference, principal = 'ai' }) {
    const name = String(reference || '').trim()
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要镜像名。')
    const result = await registry.pullImage(node, name)
    log({ principal, action: 'image.pull', node, target: name, result: 'ok' })
    return { status: 'done', ...result }
  }

  async function imageDelete({ node, reference, principal = 'ai' }) {
    const name = String(reference || '').trim()
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要镜像名。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'image.delete',
        target: name,
        action: 'delete',
        args: { reference: name },
        principal,
        summary: '删除镜像 ' + name + '。还有容器（含已停止的）在用它时会失败。',
      })
    }
    const result = await registry.deleteImage(node, name)
    log({ principal, action: 'image.delete', node, target: name, result: 'ok' })
    return { status: 'done', ...result }
  }

  /**
   * 删 LXC 的系统镜像缓存。删了下次建这个发行版要重新下载，所以照旧挂起。
   * 和 imageDelete 分开写：那边删的是 OCI 镜像（有容器引用检查），这边是缓存目录。
   */
  async function lxcImageDelete({ node, name, principal = 'ai' }) {
    const target = String(name || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要镜像名，例如 debian/trixie/arm64。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'lxc.image.delete',
        target,
        action: 'delete',
        args: { name: target },
        principal,
        summary: '删除 LXC 系统镜像缓存 ' + target + '。删掉之后，建这个发行版的容器要重新下载一遍。',
      })
    }
    const result = await registry.deleteLxcImage(node, target)
    log({ principal, action: 'lxc.image.delete', node, target, result: 'ok' })
    return { status: 'done', ...result }
  }

  async function volumeBackup({ node, name, dir, image, principal = 'panel' }) {
    const target = String(name || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要卷名。')
    return longOp({
      kind: 'volume.backup', node, target, label: '备份卷 ' + target, principal,
      run: ctx => registry.backupVolume(node, target, dir, image, { signal: ctx.signal }),
    })
  }

  async function volumeRestore({ node, file, name, image, principal = 'panel', confirmed = false }) {
    const target = String(name || '').trim()
    if (!target || !file) throw new CmError(ERR.BAD_ARGS, '需要卷名与归档路径。')
    if (!confirmed && confirmRequired()) {
      return beginPending({
        node, kind: 'volume.restore', target, action: 'restore', args: { file: String(file), name: target, image }, principal,
        summary: '把归档 ' + file + ' 恢复到卷 ' + target + '，会覆盖卷内现有数据，需要确认。',
      })
    }
    return longOp({
      kind: 'volume.restore', node, target, label: '恢复卷 ' + target, principal,
      run: ctx => registry.restoreVolume(node, file, target, image, { signal: ctx.signal }),
    })
  }

  /** 删卷 = 删数据，一律挂起。 */
  async function volumeDelete({ node, name, principal = 'ai' }) {
    const target = String(name || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要卷名。')
    if (confirmRequired()) {
      return beginPending({
        node,
        kind: 'volume.delete',
        target,
        action: 'delete',
        args: { name: target },
        principal,
        summary: '删除卷 ' + target + '。卷里的数据会一起没，删了找不回来。',
      })
    }
    const result = await registry.deleteVolume(node, target)
    log({ principal, action: 'volume.delete', node, target, result: 'ok' })
    return { status: 'done', ...result }
  }

  /**
   * 停掉整个项目 —— 会真的删容器，走待确认。
   * 摘要里写出有几个服务在跑，是因为「down」在两套生态里都能被理解成「只是停一下」。
   */
  async function composeUp({ name, principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (principal === 'ai' && confirmRequired()) {
      return beginPending({
        node: 'compose', kind: 'compose.up', target: String(name), action: 'up', args: { name }, principal,
        summary: '启动或更新 compose 项目 ' + name + '，可能重建发生变化的容器，需要确认。',
      })
    }
    return compose.up(String(name), { principal })
  }

  async function composeRecreateService({ name, service, principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (principal === 'ai' && confirmRequired()) {
      return beginPending({
        node: 'compose', kind: 'compose.recreate-service', target: String(name), action: 'recreate-service', args: { name, service }, principal,
        summary: '拉取并重建 compose 项目 ' + name + ' 的服务 ' + service + '，需要确认。',
      })
    }
    return compose.recreateService(String(name), String(service), { principal })
  }

  async function composeRollbackService({ name, service, principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (principal === 'ai' && confirmRequired()) {
      return beginPending({
        node: 'compose', kind: 'compose.rollback-service', target: String(name), action: 'rollback-service', args: { name, service }, principal,
        summary: '回滚 compose 项目 ' + name + ' 的服务 ' + service + ' 到旧镜像，需要确认。',
      })
    }
    return compose.rollbackService(String(name), String(service), { principal })
  }

  async function composeInstallRuntime({ principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (principal === 'ai' && confirmRequired()) {
      return beginPending({
        node: 'compose', kind: 'compose.install-runtime', target: 'venv', action: 'install-runtime', args: {}, principal,
        summary: '安装 podman-compose 运行时（需要联网），需要确认。',
      })
    }
    return compose.install({ principal })
  }

  async function composeDown({ name, principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (!confirmRequired()) {
      return { status: 'done', ...(await compose.runDown(name, { principal })) }
    }
    let running = 0
    let total = 0
    try {
      const status = await compose.detail(name)
      running = status.counts.running
      total = status.counts.total
    } catch {
      // 连状态都读不出来，就按最保守的说法描述
    }
    return beginPending({
      node: 'compose',
      kind: 'compose.down',
      target: String(name),
      action: 'down',
      args: { name },
      principal,
      summary: '停止并移除项目 ' + name + ' 的全部容器（' + running + '/' + total + ' 个在运行）。bind mount 的宿主数据保留，容器本身会被删掉。',
    })
  }

  /** 把手工起的容器换成 compose 管 —— 会删旧容器，走待确认。 */
  async function composeAdopt({ name, principal = 'ai' }) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    const preview = await compose.adoptPreview(name)
    if (!confirmRequired()) {
      return { status: 'done', ...(await compose.runAdopt(name, { principal })) }
    }
    const willStop = preview.willStop
    const summary = willStop.length === 0
      ? '用 compose 重建项目 ' + name + '（没有需要替换的旧容器）。'
      : '用 compose 接管项目 ' + name + '：先删除旧容器 ' + willStop.map(item => item.container).join('、') + '，再按 compose 重建。'
    return beginPending({
      node: 'compose',
      kind: 'compose.adopt',
      target: String(name),
      action: 'adopt',
      args: { name },
      principal,
      summary,
    })
  }

  /** 面板确认：take 是原子的，重复点不会执行两次。 */
  async function confirm(token, { principal = 'panel' } = {}) {
    const record = pendings.take(token)
    try {
      if (planner) {
        const freshPlan = await planner.describe({
          node: record.node,
          kind: record.kind,
          target: record.target,
          action: record.action,
          args: record.args,
        })
        if (freshPlan && Array.isArray(freshPlan.blockers) && freshPlan.blockers.length > 0) {
          throw new CmError(ERR.CONFIRM_REQUIRED, '执行前检查发现新的阻塞：' + freshPlan.blockers.join('；'))
        }
      }
      const result = await perform(record)
      const finished = pendings.finish(token, { ok: true, result: compact(result) })
      log({
        principal,
        action: `confirm.${record.kind}`,
        node: record.node,
        target: record.target,
        token,
        summary: record.summary,
        result: 'ok',
      })
      return { status: 'done', record: finished, result: compact(result) }
    } catch (error) {
      const cm = asCmError(error)
      pendings.finish(token, { ok: false, error: cm.message })
      log({
        principal,
        action: `confirm.${record.kind}`,
        node: record.node,
        target: record.target,
        token,
        result: 'failed',
        error: cm.message,
      })
      throw error
    }
  }

  function cancel(token, { principal = 'panel' } = {}) {
    const record = pendings.cancel(token, principal)
    log({ principal, action: 'pending.cancel', node: record.node, target: record.target, token, result: 'cancelled' })
    return record
  }

  /* ───────────────────────── 宿主网络 ───────────────────────── */

  /**
   * 改宿主网络连接（IP / 网关 / DNS / MTU / 自动连接）。
   * 改完要重启连接，网络会短暂中断 —— 所以一律走 pending，并先备份原生配置。
   */
  async function applyNetworkConnection({ name, patch, principal = 'ai' }) {
    const id = String(name ?? '').trim()
    if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
    if (connectionPatchArgs(patch ?? {}).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
    if (confirmRequired()) {
      return beginPending({
        node: 'host',
        kind: 'net.connection',
        target: id,
        args: { patch },
        principal,
        summary: '改宿主网络连接 ' + id + '：' + describeConnectionPatch(patch) +
          '。改完会重启这条连接，网络会短暂中断（远程连着的会断一下）。',
      })
    }
    const result = await applyConnectionPatch({ name: id, patch })
    log({ principal, action: 'net.connection', node: 'host', target: id, result: 'ok', detail: compact(patch) })
    return { status: 'done', ...result }
  }

  /** 启用 / 停用一条连接。停主网卡等于自己把自己踢下线，同样走 pending。 */
  async function setNetworkLink({ name, up, principal = 'ai' }) {
    const id = String(name ?? '').trim()
    if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
    const wantUp = up !== false
    if (confirmRequired()) {
      return beginPending({
        node: 'host',
        kind: 'net.link',
        target: id,
        args: { up: wantUp },
        principal,
        summary: (wantUp ? '启用' : '停用') + '宿主网络连接 ' + id + '。' +
          (wantUp ? '' : '停用主网卡会让这台机断网。'),
      })
    }
    const result = await setConnectionState({ name: id, up: wantUp })
    log({ principal, action: 'net.link', node: 'host', target: id, result: 'ok', detail: { up: wantUp } })
    return { status: 'done', ...result }
  }

  /** 连通性诊断：只读，直接执行。 */
  async function diagnoseNetwork({ target, count, principal = 'ai' }) {
    const result = await diagnoseHost(target, { count })
    log({
      principal,
      action: 'net.diagnose',
      node: 'host',
      target: String(target ?? ''),
      result: result.ok ? 'ok' : 'fail',
    })
    return result
  }

  /** 新建宿主连接：建完会立刻激活，可能撞 IP，所以走 pending。 */
  async function createNetworkConnection({ spec, principal = 'ai' }) {
    connectionAddArgs(spec ?? {})
    if (confirmRequired()) {
      return beginPending({
        node: 'host',
        kind: 'net.create',
        target: String(spec?.name ?? ''),
        args: { spec },
        principal,
        summary: '新建宿主网络连接：' + describeConnectionSpec(spec) + '。建完会立刻激活。',
      })
    }
    const result = await createConnection(spec)
    log({ principal, action: 'net.create', node: 'host', target: result.name, result: 'ok' })
    return { status: 'done', ...result }
  }

  /** 删连接：配置会没，先备份。 */
  async function deleteNetworkConnection({ name, principal = 'ai' }) {
    const id = String(name ?? '').trim()
    if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
    if (confirmRequired()) {
      return beginPending({
        node: 'host',
        kind: 'net.delete',
        target: id,
        args: {},
        principal,
        summary: '删除宿主网络连接 ' + id + '。会先备份配置文件；如果它正开着，网会断。',
      })
    }
    const result = await deleteConnection(id)
    log({ principal, action: 'net.delete', node: 'host', target: id, result: 'ok' })
    return { status: 'done', ...result }
  }

  /** 读一条连接的完整配置。 */
  async function inspectNetworkConnection({ name, principal = 'ai' }) {
    const connection = await readConnectionFull(name)
    if (!connection.privateKey) {
      // WireGuard 的对端只有 wg 自己有，顺手带上
    }
    if (connection.type === 'wireguard') {
      const peers = await readWireguardPeers(connection.interfaceName || name)
      connection.wireguard.peers = peers.peers
      connection.wireguard.peerError = peers.ok ? '' : peers.reason
    }
    log({ principal, action: 'net.inspect', node: 'host', target: String(name ?? ''), result: 'ok' })
    return connection
  }

  /** 宿主邻居表（ARP / NDP）。 */
  async function listNetworkNeighbors({ principal = 'ai' }) {
    const neighbors = await readNeighbors()
    log({ principal, action: 'net.neighbors', node: 'host', target: '', result: 'ok' })
    return neighbors
  }

  return {
    containerAction,
    createContainer,
    renameContainer,
    commitContainer,
    applyNetworkConnection,
    setNetworkLink,
    diagnoseNetwork,
    createNetworkConnection,
    deleteNetworkConnection,
    inspectNetworkConnection,
    listNetworkNeighbors,
    composeUp,
    composeRecreateService,
    composeRollbackService,
    composeInstallRuntime,
    composeDown,
    composeAdopt,
    imagePull,
    imageDelete,
    lxcImageDelete,
    volumeBackup,
    volumeRestore,
    volumeDelete,
    lxcSnapshot,
    snapshotPolicyRun,
    setSnapshotRunner,
    lxcSetMounts,
    lxcClone,
    lxcExport,
    listLxcExports,
    deleteLxcExport,
    lxcImport,
    filesWrite,
    filesMkdir,
    filesRemove,
    secretRemove,
    secretCreate,
    updatePodmanCgroup,
    recreatePodmanContainer,
    setLxcConfig,
    setLxcResources,
    podRemove,
    networkOperation,
    setLxcNetwork,
    confirm,
    cancel,
    perform,
    pendingList: options => pendings.list(options),
    pendingGet: token => pendings.get(token),
  }
}
