/**
 * 资源占用：容器实时 CPU / 内存 + 宿主负载、内存、磁盘。
 *
 * 为什么不并进 /state 的 4 秒轮询：`podman stats --no-stream` 单次要 1~2 秒，
 * 跟着主循环跑会把整个面板拖慢。这里单独一个 /stats，前端 10 秒取一次，
 * 页面切走就停。解析函数都是纯函数，单测直接喂字符串。
 */

import { readFile } from 'node:fs/promises'

import { execFileAsync } from './util.js'

/** `/proc/loadavg` → 1/5/15 分钟负载 + 就绪进程数。 */
export function parseLoadavg(text) {
  const parts = String(text ?? '').trim().split(/\s+/)
  const num = (index) => {
    const value = Number(parts[index])
    return Number.isFinite(value) ? value : 0
  }
  const procs = String(parts[3] ?? '').split('/')
  return {
    one: num(0),
    five: num(1),
    fifteen: num(2),
    running: Number(procs[0]) || 0,
    total: Number(procs[1]) || 0,
  }
}

/** `/proc/meminfo` → 总量 / 可用 / 已用 / 百分比 / swap。 */
export function parseMeminfo(text) {
  const fields = {}
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line.trim())
    if (match) fields[match[1]] = Number(match[2]) * 1024
  }
  const total = fields.MemTotal || 0
  const available = fields.MemAvailable || fields.MemFree || 0
  const used = Math.max(0, total - available)
  return {
    total,
    available,
    used,
    percent: total ? Math.round((used / total) * 1000) / 10 : 0,
    swapTotal: fields.SwapTotal || 0,
    swapFree: fields.SwapFree || 0,
  }
}

/** `df -P -k` 输出 → 每个挂载点的总量 / 已用 / 百分比。 */
export function parseDf(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(trimmed)
    if (!match) continue
    rows.push({
      device: match[1],
      mount: match[6].trim(),
      total: Number(match[2]) * 1024,
      used: Number(match[3]) * 1024,
      available: Number(match[4]) * 1024,
      percent: Number(match[5]),
    })
  }
  return rows
}

/**
 * 宿主负载。只在跑 DSH 的这台机上读得到 /proc 和 df ——
 * SSH 远端节点读的是本机数据，所以那边直接返回不可用，不糊。
 */
export async function hostLoad(options = {}) {
  const readFileImpl = options.readFile ?? readFile
  const exec = options.exec ?? execFileAsync
  try {
    const [loadText, memText, dfResult] = await Promise.all([
      readFileImpl('/proc/loadavg', 'utf8'),
      readFileImpl('/proc/meminfo', 'utf8'),
      exec('df', ['-P', '-k', '/'], { timeoutMs: 8_000 }),
    ])
    return {
      ok: true,
      load: parseLoadavg(loadText),
      memory: parseMeminfo(memText),
      disks: dfResult && dfResult.code === 0 ? parseDf(dfResult.stdout) : [],
    }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}

/**
 * 某个节点的容器占用。驱动没实现 stats 时如实说，不给假数字。
 * @param {object} driver
 * @param {{force?: boolean, transport?: string}} [options]
 */
export async function nodeStats(driver, options = {}) {
  if (!driver || typeof driver.stats !== 'function') {
    return {
      ok: false,
      reason: '这个节点的驱动没有实现实时占用。',
      containers: [],
    }
  }
  try {
    const containers = await driver.stats({ force: options.force === true })
    return { ok: true, containers: Array.isArray(containers) ? containers : [] }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error), containers: [] }
  }
}

/** 一次取齐：容器占用 + 宿主负载（远端节点不带宿主负载）。 */
export async function stats({ driver, transport, force = false, readFileImpl, exec }) {
  const hostOptions = {}
  if (readFileImpl) hostOptions.readFile = readFileImpl
  if (exec) hostOptions.exec = exec
  const [containers, host] = await Promise.all([
    nodeStats(driver, { force }),
    // 只有 ssh 才是真正的远端；helper 那个节点跑在本机上，/proc 照样读得到。
    transport === 'ssh' ? Promise.resolve({ ok: false, reason: '远端宿主负载还没接（SSH 节点只给容器占用）。' }) : hostLoad(hostOptions),
  ])
  return {
    at: new Date().toISOString(),
    ...containers,
    host,
  }
}
