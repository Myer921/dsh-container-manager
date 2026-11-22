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
  return { root, binary, version, installedAt }
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
    compose: { root: '', binary: '', version: DEFAULT_COMPOSE_VERSION, installedAt: '' },
  }
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
    if (typeof raw.host !== 'string' || !raw.host.trim()) return null
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
