/**
 * AI 工具可解释执行（P2）。
 *
 * 每次工具调用都留一条能读懂的话：「这个调用到底想干嘛、会动到谁、能不能撤回」。
 * 模型那边也会看到这段说明，人这边在「活动」页看到同一句 —— 同一份事实，两处一致。
 *
 * 原则：说明只写**能确定**的东西。参数里没给的就写「未指定」，不替模型补意图。
 * 撤回性也照实：启动/停止/只读都能撤回，删除类的撤回性取决于有没有备份，那就写「不可撤回」。
 */

const REVERSIBLE = 'reversible'
const NEEDS_CONFIRM = 'needs-confirm'
const RISKY = 'risky'

/** 每个工具的说明模板。target 是需要从参数里取的那个键。 */
const TEMPLATES = {
  container_nodes: { target: null, reversible: REVERSIBLE, say: () => '看有哪些节点可用' },
  container_list: { target: null, reversible: REVERSIBLE, say: args => '列容器' + (args.node ? '（' + args.node + '）' : '') },
  container_inspect: { target: 'ref', reversible: REVERSIBLE, say: args => '看 ' + args.ref + ' 的详情' },
  container_logs: { target: 'ref', reversible: REVERSIBLE, say: args => '读 ' + args.ref + ' 的日志' },
  container_stats: { target: null, reversible: REVERSIBLE, say: args => '读实时占用' + (args.node ? '（' + args.node + '）' : '') },
  container_capabilities: { target: null, reversible: REVERSIBLE, say: args => '体检 ' + (args.node || '默认节点') },
  container_diagnose: { target: 'ref', reversible: REVERSIBLE, say: args => '给 ' + args.ref + ' 做容器内网络诊断' },
  container_image_list: { target: null, reversible: REVERSIBLE, say: args => '列镜像' + (args.node ? '（' + args.node + '）' : '') },
  container_image_update: { target: null, reversible: REVERSIBLE, say: args => '查镜像有没有新版' },
  container_alert: { target: null, reversible: REVERSIBLE, say: args => (args.op === 'test' ? '发一条测试告警' : '读告警规则与出口') },
  network_host: { target: null, reversible: REVERSIBLE, say: args => '看宿主网络（' + (args.op || '?') + '）' },
  compose_projects: { target: null, reversible: REVERSIBLE, say: () => '列 compose 项目' },
  compose_inspect: { target: 'project', reversible: REVERSIBLE, say: args => '看项目 ' + args.project },
  pending_operations: { target: null, reversible: REVERSIBLE, say: () => '查待确认队列（只查，不能确认）' },
  container_audit: { target: null, reversible: REVERSIBLE, say: () => '读活动/审计记录' },
  container_create: { target: 'spec', reversible: REVERSIBLE, say: args => '新建容器 ' + (args.name || (args.spec && args.spec.name) || '（名字未指定）') },
  container_limits: { target: 'ref', reversible: REVERSIBLE, say: args => '改 ' + args.ref + ' 的资源上限' },
  container_rename: { target: 'ref', reversible: REVERSIBLE, say: args => '把 ' + args.ref + ' 改名成 ' + (args.name || '?') },
  container_resources: { target: 'name', reversible: REVERSIBLE, say: args => '改 LXC ' + args.name + ' 的资源 / 启动项' },
  container_quadlet: { target: 'unit', reversible: REVERSIBLE, say: args => 'Quadlet：' + (args.op || '?') + (args.unit ? ' ' + args.unit : '') },
  container_jobs: { target: 'id', reversible: REVERSIBLE, say: args => (args.op === 'cancel' ? '取消任务 ' + (args.id || '?') : '看任务队列') },
  compose_set_ports: { target: 'project', reversible: REVERSIBLE, say: args => '改项目 ' + args.project + ' 里 ' + (args.service || '?') + ' 的端口' },
  lxc_clone: { target: 'name', reversible: REVERSIBLE, say: args => '克隆 ' + args.name + ' 成 ' + (args.newName || '?') },
  container_action: { target: 'ref', reversible: args => (args.action === 'delete' ? RISKY : REVERSIBLE), say: args => (args.action || '?') + ' ' + args.ref },
  container_commit: { target: 'ref', reversible: NEEDS_CONFIRM, say: args => '把 ' + args.ref + ' 存成镜像 ' + (args.image || '?') },
  container_config: { target: 'name', reversible: NEEDS_CONFIRM, say: args => '改 LXC ' + args.name + ' 的启动项' },
  container_files: { target: 'path', reversible: RISKY, say: args => '容器文件：' + (args.op || '?') + ' ' + (args.path || '?') },
  container_image_delete: { target: 'name', reversible: RISKY, say: args => '删镜像 ' + (args.name || '?') },
  container_secret: { target: 'name', reversible: RISKY, say: args => '密钥：' + (args.op || '?') + ' ' + (args.name || '（新建总会被拒）') },
  lxc_snapshot: { target: 'name', reversible: args => (args.op === 'list' ? REVERSIBLE : RISKY), say: args => 'LXC 快照：' + (args.op || '?') + ' ' + (args.name || '?') },
  lxc_mounts: { target: 'name', reversible: args => (args.op === 'list' ? REVERSIBLE : NEEDS_CONFIRM), say: args => 'LXC 挂载点：' + (args.op || '?') + ' ' + (args.name || '?') },
  lxc_backup: { target: 'name', reversible: args => (args.op === 'list' || args.op === 'policy' ? REVERSIBLE : NEEDS_CONFIRM), say: args => 'LXC 备份：' + (args.op || '?') + (args.name ? ' ' + args.name : '') },
  compose_action: { target: 'project', reversible: args => (args.op === 'logs' ? REVERSIBLE : NEEDS_CONFIRM), say: args => 'compose ' + (args.op || '?') + (args.project ? ' ' + args.project : '') + (args.service ? ' / ' + args.service : '') },
  network_manage: { target: 'name', reversible: args => (args.op === 'list' || args.op === 'inspect' ? REVERSIBLE : NEEDS_CONFIRM), say: args => '容器网络 ' + (args.op || '?') + (args.name ? ' ' + args.name : '') },
  network_host_apply: { target: 'name', reversible: NEEDS_CONFIRM, say: args => '改宿主网络 ' + (args.op || '?') + ' ' + (args.name || '?') },
}

const REVERSIBLE_TEXT = {
  [REVERSIBLE]: '可撤回',
  [NEEDS_CONFIRM]: '要你在面板确认',
  [RISKY]: '不可撤回',
}

/** 参数只留摘要：不要把那 8MB base64 或整份环境变量塞进审计。 */
export function summarizeArgs(args, limit = 160) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    let shown
    if (typeof value === 'string') shown = value.length > 60 ? value.slice(0, 57) + '…' : value
    else if (typeof value === 'number' || typeof value === 'boolean') shown = String(value)
    else if (Array.isArray(value)) shown = '[' + value.length + ' 项]'
    else shown = '{…}'
    parts.push(key + '=' + shown)
    if (parts.join(' ').length > limit) break
  }
  return parts.join(' ').slice(0, limit)
}

/**
 * 给一次调用写一句人话。
 * @returns {{ intent: string, target: string, reversible: string, reversibleText: string, access: string|null }}
 */
export function describeToolCall(name, args = {}, access = null) {
  const tool = String(name || '')
  const template = TEMPLATES[tool]
  const target = template && template.target ? String(args[template.target] ?? '') : ''
  if (!template) {
    return {
      intent: '调用了 ' + tool + (target ? '（' + target + '）' : ''),
      target,
      reversible: NEEDS_CONFIRM,
      reversibleText: REVERSIBLE_TEXT[NEEDS_CONFIRM],
      access,
    }
  }
  let reversible
  try {
    reversible = typeof template.reversible === 'function' ? template.reversible(args) : template.reversible
  } catch {
    reversible = NEEDS_CONFIRM
  }
  let intent
  try {
    intent = template.say(args || {})
  } catch {
    intent = tool
  }
  return {
    intent: String(intent),
    target,
    reversible,
    reversibleText: REVERSIBLE_TEXT[reversible] || REVERSIBLE_TEXT[NEEDS_CONFIRM],
    access,
  }
}

/** 已知工具的说明模板名，测试用：注册的工具必须都有说明。 */
export function explainedTools() {
  return Object.keys(TEMPLATES)
}
