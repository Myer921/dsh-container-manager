/**
 * AI 侧的权限闸门（P2：角色与权限）。
 *
 * 三个角色，一条硬道理：**角色只限制 AI 能「发起」什么，永远不给人省掉确认**。
 * 危险操作即使 admin 发起，也照样走待确认 —— 这道闸门管的是「AI 手上有没有这把钥匙」，
 * 不是「人要不要点头」。
 *
 *   readonly  只能读
 *   operator  读写，但危险操作发起不了（默认）
 *   admin     全都能发起（仍然要人确认）
 *
 * 另外支持 deny 黑名单：单独点掉几个工具，不管角色。
 */

export const AI_ROLES = ['readonly', 'operator', 'admin']

export const DEFAULT_ROLE = 'operator'

/**
 * 每个工具自己的性质。'read' | 'write' | 'danger'。
 * 判定原则：**这个工具能不能做出危险事**，能就算 danger —— 不看它默认干啥。
 * （container_action 默认只是重启，但它带 op=delete，所以是 danger。）
 */
export const TOOL_ACCESS = {
  container_nodes: 'read',
  container_list: 'read',
  container_inspect: 'read',
  container_logs: 'read',
  container_stats: 'read',
  container_capabilities: 'read',
  container_diagnose: 'read',
  container_image_list: 'read',
  container_image_update: 'read',
  network_host: 'read',
  compose_projects: 'read',
  compose_inspect: 'read',
  pending_operations: 'read',
  container_audit: 'read',
  container_alert: 'write',
  container_create: 'write',
  container_limits: 'write',
  container_rename: 'write',
  container_resources: 'write',
  container_quadlet: 'write',
  container_jobs: 'write',
  compose_set_ports: 'write',
  lxc_clone: 'write',
  container_action: 'danger',
  container_commit: 'danger',
  container_config: 'danger',
  container_files: 'danger',
  container_image_delete: 'danger',
  container_secret: 'danger',
  lxc_snapshot: 'danger',
  lxc_mounts: 'danger',
  // 导出/导入重但不破坏；删归档走待确认，所以整类算 write 而不是 danger。
  lxc_backup: 'write',
  compose_action: 'danger',
  network_manage: 'danger',
  network_host_apply: 'danger',
}

/** 角色能干到哪一级。 */
const ROLE_LEVEL = { readonly: 0, operator: 1, admin: 2 }
const ACCESS_LEVEL = { read: 0, write: 1, danger: 2 }

export function normalizeRole(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return AI_ROLES.includes(text) ? text : DEFAULT_ROLE
}

/**
 * 给一次调用下判决。
 * @param {{ role?: string, access?: string, tool?: string, deny?: string[] }} input
 * @returns {{ allow: boolean, access: string, role: string, reason: string|null }}
 */
export function decideAuthz({ role, access, tool, deny = [] }) {
  const picked = normalizeRole(role)
  const kind = ACCESS_LEVEL[access] === undefined ? 'danger' : access
  const blocked = (deny || []).map(item => String(item)).filter(Boolean)
  if (tool && blocked.includes(String(tool))) {
    return { allow: false, access: kind, role: picked, reason: '工具 ' + tool + ' 在 deny 名单里（配置里去掉才能用）。' }
  }
  if (ROLE_LEVEL[picked] < ACCESS_LEVEL[kind]) {
    const need = kind === 'danger' ? 'danger（危险操作仍要人确认）' : kind
    return {
      allow: false,
      access: kind,
      role: picked,
      reason: '当前 AI 角色是 ' + picked + '，这个工具要 ' + need +
        '。要放开就把配置里的 authz.aiRole 改成 ' +
        (kind === 'danger' ? 'admin' : 'operator') + '。',
    }
  }
  return { allow: true, access: kind, role: picked, reason: null }
}

/** 角色的一句话说明，面板和 README 共用。 */
export function describeRole(role) {
  const picked = normalizeRole(role)
  if (picked === 'readonly') return '只能读：不能建、不能删、不能改任何东西。'
  if (picked === 'operator') return '能建能改，但危险操作（删容器、改网络、改网卡）发不起来。'
  return '什么都能发起 —— 危险操作照样要你在面板里点一下才真的做。'
}

/** 角色的能力矩阵，给面板画表用。 */
export function roleMatrix() {
  return AI_ROLES.map(role => ({
    role,
    read: true,
    write: ROLE_LEVEL[role] >= 1,
    danger: ROLE_LEVEL[role] >= 2,
    text: describeRole(role),
  }))
}
