/**
 * 配置与数据目录
 *
 * 落在 DSH 可写区里（~/.dsh-next/container-manager/），与插件同寿：
 *   config.json   节点定义与策略
 *   pending.json  待确认队列
 *   audit.jsonl   审计
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeBackupPolicy } from './backup.js'
import { normalizeSnapshotPolicy } from './snapshot-policy.js'
import { CmError, ERR, nowIso, safeJson } from './util.js'

/** DSH 的数据根；DSH_HOME 由宿主进程注入，测试可以用 DSH_CM_DIR 直接指定。 */
export function dataDir() {
  if (process.env.DSH_CM_DIR) return process.env.DSH_CM_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh-next')
  return join(home, 'container-manager')
}

export function paths() {
  const dir = dataDir()
  return {
    dir,
    config: join(dir, 'config.json'),
    pending: join(dir, 'pending.json'),
    audit: join(dir, 'audit.jsonl'),
    // 任务队列、指标历史、备份策略与告警出口：都落在同一个数据目录里，跟插件同寿。
    jobs: join(dir, 'jobs.json'),
    metrics: join(dir, 'metrics.ndjson'),
    backups: join(dir, 'backups.json'),
    alerts: join(dir, 'alerts.json'),
    trash: join(dir, 'trash.json'),
    snapshots: join(dir, 'snapshots.json'),
  }
}

/** 默认节点：本机 Podman 永远在；本机 LXC 只有装了 helper 才 available。 */
export function defaultNodes() {
  return [
    { id: 'local-podman', label: '本机 Podman', kind: 'podman', transport: 'local' },
    {
      id: 'local-lxc',
      label: '本机 LXC',
      kind: 'lxc',
      transport: 'helper',
      socketPath: '/run/dsh-container-manager/lxcd.sock',
    },
  ]
}

/** podman-compose 的 pin 版本；升级前必须跑一遍 scripts/compose-smoke.mjs。 */
export const DEFAULT_COMPOSE_VERSION = '1.6.0'

/**
 * 根目录与 podman-compose 运行时设置。
 *
 * root 留空 = 还没配，面板会引导填；binary 留空 = 用 dataDir/venv 下的默认路径。
 * 这两项都不给默认值，因为「猜一个根目录」比「让用户填」更容易出事。
 */
export function normalizeComposeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const root = typeof source.root === 'string' && source.root.trim() ? source.root.trim().slice(0, 4096) : ''
  const binary = typeof source.binary === 'string' && source.binary.trim() ? source.binary.trim().slice(0, 4096) : ''
  const version = typeof source.version === 'string' && /^[\w.\-]{1,32}$/.test(source.version)
    ? source.version
    : DEFAULT_COMPOSE_VERSION
  const installedAt = typeof source.installedAt === 'string' ? source.installedAt.slice(0, 40) : ''
  const rollbacks = {}
  if (source.rollbacks && typeof source.rollbacks === 'object') {
    for (const [key, value] of Object.entries(source.rollbacks).slice(0, 100)) {
      if (!/^[a-z0-9_.:-]+\/[a-z0-9_.:-]+$/.test(key) || !value || typeof value !== 'object') continue
      if (typeof value.image !== 'string' || !value.image) continue
      rollbacks[key] = { image: value.image.slice(0, 300), imageId: String(value.imageId ?? '').slice(0, 100), at: String(value.at ?? '').slice(0, 40) }
    }
  }
  return { root, binary, version, installedAt, rollbacks }
}

export function normalizeLxcDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const backend = source.backend === 'dir' ? 'dir' : 'loop'
  const diskSize = typeof source.diskSize === 'string' && /^\d+[MG]$/i.test(source.diskSize.trim())
    ? source.diskSize.trim().toUpperCase()
    : '8G'
  return { backend, diskSize }
}

export function defaultConfig() {
  return {
    version: 1,
    nodes: defaultNodes(),
    confirmRequired: true,
    confirmTtlSeconds: 600,
    auditKeepLines: 2000,
    allowLogs: true,
    logTailDefault: 100,
    logTailMax: 2000,
    compose: { root: '', binary: '', version: DEFAULT_COMPOSE_VERSION, installedAt: '', rollbacks: {} },
    // 长任务最多并发两个：再多会把 podman/lxc 自己拖慢，反而不如排队。
    jobsMaxRunning: 2,
    // 30 秒一个点、留 3 天：一行只有宿主那几项，3 天约 2MB，够画 1h/6h/24h 三档。
    metrics: { enabled: true, intervalSeconds: 30, keepDays: 3, maxBytes: 8 * 1024 * 1024 },
    backups: [],
    alerts: { webhooks: [], rules: [], dedupeMinutes: 30 },
    // AI 侧角色：readonly 只读、operator 读写但发起不了危险操作、admin 全放开（仍要人确认）。
    authz: { aiRole: 'operator', deny: [] },
    // 自动备份：默认关。开着但没有 targets 等于没开（面板会直说）。
    backupPolicy: { enabled: false, targets: [], everyHours: 24, keepCount: 5, keepDays: 14, dir: '' },
    snapshotPolicy: { enabled: false, targets: [], everyHours: 24, keepCount: 5 },
    lxcDefaults: { backend: 'loop', diskSize: '8G' },
  }
}

/** 指标历史：采样间隔与保留期都要有上下限，否则一次误配就能把盘写满。 */
function normalizeMetrics(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: source.enabled !== false,
    intervalSeconds: clampNumber(source.intervalSeconds, 10, 600, 30),
    keepDays: clampNumber(source.keepDays, 1, 90, 7),
    maxBytes: clampNumber(source.maxBytes, 262_144, 268_435_456, 4 * 1024 * 1024),
  }
}

/** 备份策略：对象 / 频率 / 保留份数 / 目标目录。坏条目直接丢，不留半条。 */
function normalizeBackups(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(entry.id) ? entry.id : null
    if (!id || seen.has(id)) continue
    const kind = ['lxc-export', 'volume', 'compose'].includes(entry.kind) ? entry.kind : null
    if (!kind) continue
    const dir = typeof entry.dir === 'string' && entry.dir.trim() ? entry.dir.trim().slice(0, 400) : ''
    if (!dir) continue
    seen.add(id)
    out.push({
      id,
      kind,
      node: typeof entry.node === 'string' ? entry.node.slice(0, 60) : '',
      target: typeof entry.target === 'string' ? entry.target.slice(0, 120) : '',
      dir,
      everyHours: clampNumber(entry.everyHours, 1, 336, 24),
      keep: clampNumber(entry.keep, 1, 90, 7),
      enabled: entry.enabled !== false,
      lastRunAt: typeof entry.lastRunAt === 'string' ? entry.lastRunAt.slice(0, 40) : '',
      lastJobId: typeof entry.lastJobId === 'string' ? entry.lastJobId.slice(0, 40) : '',
    })
  }
  return out
}

/** 告警出口：webhook 地址里可能带 token，读取时只回显掩码。 */
export function normalizeAlerts(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const hooks = Array.isArray(source.webhooks) ? source.webhooks : []
  const webhooks = []
  for (const hook of hooks) {
    if (!hook || typeof hook !== 'object') continue
    const id = typeof hook.id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(hook.id) ? hook.id : null
    const url = typeof hook.url === 'string' ? hook.url.trim() : ''
    if (!id || !/^https?:\/\//.test(url)) continue
    webhooks.push({
      id,
      name: typeof hook.name === 'string' && hook.name.trim() ? hook.name.trim().slice(0, 60) : id,
      url: url.slice(0, 800),
      kind: ['ntfy', 'bark', 'json'].includes(hook.kind) ? hook.kind : 'json',
      enabled: hook.enabled !== false,
    })
  }
  const rules = Array.isArray(source.rules) ? source.rules : []
  const allowed = ['unhealthy', 'restarts', 'disk', 'pending']
  const keptRules = []
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (!allowed.includes(rule.kind)) continue
    keptRules.push({
      id: typeof rule.id === 'string' ? rule.id.slice(0, 40) : rule.kind,
      kind: rule.kind,
      threshold: clampNumber(rule.threshold, 1, 100, rule.kind === 'disk' ? 85 : 3),
      enabled: rule.enabled !== false,
    })
  }
  return { webhooks, rules: keptRules, dedupeMinutes: clampNumber(source.dedupeMinutes, 1, 1440, 30) }
}

/** AI 权限：角色只认三档；deny 是工具名黑名单（写错的条目直接丢掉，不猜）。 */
function normalizeAuthz(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const role = ['readonly', 'operator', 'admin'].includes(source.aiRole) ? source.aiRole : 'operator'
  const deny = Array.isArray(source.deny)
    ? source.deny
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(item => /^[a-z][a-z0-9_]{2,60}$/.test(item))
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 50)
    : []
  return { aiRole: role, deny }
}

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return null
  const kind = raw.kind === 'lxc' ? 'lxc' : raw.kind === 'podman' ? 'podman' : null
  if (!kind) return null
  const transport = raw.transport === 'ssh' ? 'ssh' : raw.transport === 'helper' ? 'helper' : 'local'
  const node = {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : id,
    kind,
    transport,
  }
  if (transport === 'helper') {
    node.socketPath = typeof raw.socketPath === 'string' && raw.socketPath.trim()
      ? raw.socketPath.trim()
      : '/run/dsh-container-manager/lxcd.sock'
  }
  if (transport === 'ssh') {
    if (typeof raw.host !== 'string' || !raw.host.trim() || raw.host.trim().startsWith('-')) return null
    if (typeof raw.user === 'string' && raw.user.trim().startsWith('-')) return null
    node.host = raw.host.trim().slice(0, 253)
    node.user = typeof raw.user === 'string' && raw.user.trim() ? raw.user.trim().slice(0, 64) : undefined
    node.port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : undefined
    node.identityFile = typeof raw.identityFile === 'string' && raw.identityFile.trim()
      ? raw.identityFile.trim()
      : undefined
    // SSH 上的 LXC 第一版不开放；写清而不是静默忽略。
    if (kind === 'lxc') return null
  }
  return node
}

/** 把 patch/磁盘上的配置与默认值合并；坏节点丢掉但不炸。 */
export function mergeConfig(input) {
  const base = defaultConfig()
  const source = input && typeof input === 'object' ? input : {}
  const nodes = []
  const seen = new Set()
  const rawNodes = Array.isArray(source.nodes) && source.nodes.length > 0 ? source.nodes : base.nodes
  for (const raw of rawNodes) {
    const node = normalizeNode(raw)
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }
  return {
    version: 1,
    nodes: nodes.length > 0 ? nodes : defaultNodes(),
    confirmRequired: source.confirmRequired !== false,
    confirmTtlSeconds: clampNumber(source.confirmTtlSeconds, 30, 86_400, base.confirmTtlSeconds),
    auditKeepLines: clampNumber(source.auditKeepLines, 100, 200_000, base.auditKeepLines),
    allowLogs: source.allowLogs !== false,
    logTailDefault: clampNumber(source.logTailDefault, 1, 2000, base.logTailDefault),
    logTailMax: clampNumber(source.logTailMax, 1, 5000, base.logTailMax),
    compose: normalizeComposeSettings(source.compose),
    jobsMaxRunning: clampNumber(source.jobsMaxRunning, 1, 4, base.jobsMaxRunning),
    metrics: normalizeMetrics(source.metrics),
    backups: normalizeBackups(source.backups),
    alerts: normalizeAlerts(source.alerts),
    authz: normalizeAuthz(source.authz),
    backupPolicy: normalizeBackupPolicy(source.backupPolicy),
    snapshotPolicy: normalizeSnapshotPolicy(source.snapshotPolicy),
    lxcDefaults: normalizeLxcDefaults(source.lxcDefaults),
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** 数据库式的小仓库：读一次、改、原子写回。 */
export function createConfigStore(patchConfig = {}) {
  const file = paths().config
  mkdirSync(paths().dir, { recursive: true })

  let state = load()

  function load() {
    let disk = {}
    if (existsSync(file)) {
      const parsed = safeJson(readFileSync(file, 'utf8'), null)
      if (parsed && typeof parsed === 'object') disk = parsed
    }
    const merged = mergeConfig({
      ...disk,
      ...(patchConfig && typeof patchConfig === 'object' ? patchConfig : {}),
      // 节点列表以磁盘为准（磁盘为空才回落到 patch/默认）
      ...(Array.isArray(disk.nodes) && disk.nodes.length > 0 ? { nodes: disk.nodes } : {}),
    })
    return merged
  }

  function saveFile() {
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }

  function persist() {
    state.savedAt = nowIso()
    saveFile()
  }

  return {
    /** 当前配置（只读引用，别直接改）。 */
    get: () => state,
    file,
    /** 整份替换（仍会过一遍合并与校验）。 */
    replace(next) {
      const merged = mergeConfig(next)
      state = merged
      persist()
      return state
    },
    addNode(raw) {
      const node = normalizeNode(raw)
      if (!node) throw new CmError(ERR.BAD_ARGS, '节点定义不合法：需要 id / kind / transport（ssh 还需要 host）。')
      if (state.nodes.some(existing => existing.id === node.id)) {
        throw new CmError(ERR.BAD_ARGS, `节点 id 已存在：${node.id}`)
      }
      state.nodes = [...state.nodes, node]
      persist()
      return node
    },
    removeNode(id) {
      if (id === 'local-podman') throw new CmError(ERR.BAD_ARGS, '本机 Podman 节点不能删。')
      const before = state.nodes.length
      state.nodes = state.nodes.filter(node => node.id !== id)
      if (state.nodes.length === before) throw new CmError(ERR.NOT_FOUND, `没有这个节点：${id}`)
      persist()
      return true
    },
    node(id) {
      return state.nodes.find(node => node.id === id)
    },
    /** 只改 compose 那一段（根目录 / 运行时路径），其余配置原样保留。 */
    updateCompose(patch) {
      const current = state.compose ?? normalizeComposeSettings({})
      const next = normalizeComposeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
      state.compose = next
      persist()
      return next
    },
  }
}
