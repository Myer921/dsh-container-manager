/**
 * 指标历史
 *
 * 面板原来只有 20 个点的内存环（约 3 分钟），刷新页面就没了 —— 那不是历史，是心跳。
 * 这里落一份追加式 NDJSON：默认每 30 秒一行，一行里是各节点的宿主负载与容器占用。
 *
 * 为什么不用 SQLite：这个插件的 dependencies 是空的，一个包都不加。NDJSON 够用，
 * 因为查询只有一种形状 ——「某节点最近 N 分钟」，顺序扫一遍内存副本就行。
 * 体积靠两道闸控制：按字节轮转（超了留后半段）、按天数剪枝。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { nowIso, safeJson } from './util.js'

/** 内存里最多留这么多行；再多也查询不了那么细，纯属浪费。 */
const MAX_IN_MEMORY = 60_000
/** 轮转时留后半段，避免刚轮转完就又被剪空。 */
const KEEP_RATIO = 0.5

export function createMetricsStore({
  file,
  intervalSeconds = 30,
  keepDays = 3,
  maxBytes = 8 * 1024 * 1024,
  now = () => Date.now(),
} = {}) {
  mkdirSync(dirname(file), { recursive: true })

  let samples = load()
  let bytes = sizeOf()

  function sizeOf() {
    try {
      return existsSync(file) ? statSync(file).size : 0
    } catch {
      return 0
    }
  }

  function cutoff() {
    return now() - keepDays * 86_400_000
  }

  function parseLines(text) {
    const out = []
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = safeJson(trimmed, null)
      if (!parsed || typeof parsed !== 'object' || !parsed.t) continue
      const at = Date.parse(parsed.t)
      if (!Number.isFinite(at)) continue
      out.push(parsed)
    }
    return out
  }

  function load() {
    if (!existsSync(file)) return []
    try {
      const all = parseLines(readFileSync(file, 'utf8'))
      const floor = cutoff()
      return all.filter(sample => Date.parse(sample.t) >= floor).slice(-MAX_IN_MEMORY)
    } catch {
      return []
    }
  }

  /** 超字节上限就只留后一半重写；顺手把过期行扔掉。 */
  function maybeRotate() {
    if (bytes <= maxBytes) return false
    const floor = cutoff()
    const kept = samples.filter(sample => Date.parse(sample.t) >= floor)
    const half = kept.slice(Math.max(0, Math.ceil(kept.length * (1 - KEEP_RATIO))))
    const text = half.map(sample => JSON.stringify(sample)).join('\n') + (half.length > 0 ? '\n' : '')
    const temporary = file + '.tmp'
    try {
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, file)
      samples = half
      bytes = sizeOf()
      return true
    } catch {
      return false
    }
  }

  return {
    file,
    intervalSeconds,
    keepDays,

    get count() {
      return samples.length
    },

    info() {
      const first = samples[0]
      const last = samples[samples.length - 1]
      return {
        file,
        intervalSeconds,
        keepDays,
        samples: samples.length,
        bytes,
        from: first ? first.t : null,
        to: last ? last.t : null,
      }
    },

    /** 记一条。写盘失败只是少一个点，不能让采样器崩掉。 */
    record(sample) {
      if (!sample || typeof sample !== 'object') return null
      // 时间戳跟着注入的时钟走（测试要能控时），别直接用真实 nowIso。
      const at = sample.t || new Date(now()).toISOString()
      const entry = { ...sample, t: at }
      samples.push(entry)
      if (samples.length > MAX_IN_MEMORY) samples = samples.slice(-MAX_IN_MEMORY)
      try {
        const line = JSON.stringify(entry) + '\n'
        appendFileSync(file, line)
        bytes += Buffer.byteLength(line)
      } catch {
        // 盘满 / 只读：内存里还有这份数据，查询照样能出结果
      }
      maybeRotate()
      return entry
    },

    /**
     * 查某节点最近 N 分钟的宿主负载序列，按桶降采样成不超过 points 个点。
     * 降采样取平均（内存取最大值，尖峰不该被抹平）。
     */
    query({ node = null, minutes = 60, points = 120 } = {}) {
      const span = Math.max(1, Number(minutes) || 60) * 60_000
      const from = now() - span
      const picked = samples.filter((sample) => {
        const at = Date.parse(sample.t)
        if (!Number.isFinite(at) || at < from) return false
        if (!node) return Boolean(sample.host)
        return Boolean(sample.host && sample.host[node])
      })
      const want = Math.max(2, Math.min(600, Number(points) || 120))
      const bucketMs = span / want
      const buckets = new Map()
      for (const sample of picked) {
        const at = Date.parse(sample.t)
        const host = node ? sample.host && sample.host[node] : sample.host && Object.values(sample.host)[0]
        if (!host) continue
        const key = Math.floor((at - from) / bucketMs)
        const bucket = buckets.get(key) || {
          at: 0, count: 0, load: 0, memPercent: 0, memUsed: 0, memTotal: 0, diskPercent: 0, containers: 0,
        }
        bucket.at = Math.max(bucket.at, at)
        bucket.count += 1
        bucket.load += Number(host.load) || 0
        bucket.memPercent += Number(host.memPercent) || 0
        bucket.memUsed = Math.max(bucket.memUsed, Number(host.memUsed) || 0)
        bucket.memTotal = Math.max(bucket.memTotal, Number(host.memTotal) || 0)
        bucket.diskPercent = Math.max(bucket.diskPercent, Number(host.diskPercent) || 0)
        bucket.containers = Math.max(bucket.containers, Number(host.containers) || 0)
        buckets.set(key, bucket)
      }
      const series = [...buckets.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, bucket]) => ({
          t: new Date(bucket.at).toISOString(),
          load: Math.round((bucket.load / bucket.count) * 1000) / 1000,
          memPercent: Math.round((bucket.memPercent / bucket.count) * 10) / 10,
          memUsed: bucket.memUsed,
          memTotal: bucket.memTotal,
          diskPercent: bucket.diskPercent,
          containers: bucket.containers,
        }))
      return {
        node,
        minutes: Math.round(span / 60_000),
        points: series.length,
        intervalSeconds,
        series,
      }
    },
  }
}

/**
 * 采样器：插件挂载时起，卸载时停。
 *
 * 每个节点一次 registry.stats()（podman stats 自带 3 秒缓存，不会打满），
 * 只取画图用得到的几个数。采不到就跳过这个节点，不写一条假数据进去。
 */
export function createSampler({
  metrics,
  registry,
  intervalSeconds = null,
  log = () => {},
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = timer => clearInterval(timer),
} = {}) {
  if (!metrics || !registry) throw new Error('createSampler 需要 metrics 与 registry。')
  const period = Math.max(10, Number(intervalSeconds || metrics.intervalSeconds) || 30) * 1000
  let timer = null
  let sampling = false

  async function tick() {
    if (sampling) return null
    sampling = true
    try {
      const host = {}
      for (const node of registry.nodes()) {
        try {
          const value = await registry.stats(node.id)
          if (!value || !value.ok) continue
          const load = value.host && value.host.ok ? value.host.load : null
          const memory = value.host && value.host.ok ? value.host.memory : null
          const rootDisk = value.host && value.host.ok
            ? (value.host.disks || []).find(disk => disk.mount === '/') || null
            : null
          const containers = Array.isArray(value.containers) ? value.containers : []
          host[node.id] = {
            load: load ? load.one : null,
            memPercent: memory ? memory.percent : null,
            memUsed: memory ? memory.used : null,
            memTotal: memory ? memory.total : null,
            diskPercent: rootDisk ? rootDisk.percent : null,
            containers: containers.length,
            // 刻意不存每个容器的曲线：面板只用宿主这一条，存了就是白占盘。
            // 要容器历史的时候再加字段，别现在先写一份没人读的。
          }
        } catch (error) {
          // 节点不可用是常态（helper 没装、podman 卡住），不该在日志里刷屏
          log('采样跳过 ' + node.id + '：' + (error && error.message ? error.message : String(error)))
        }
      }
      if (Object.keys(host).length === 0) return null
      return metrics.record({ host })
    } finally {
      sampling = false
    }
  }

  return {
    intervalSeconds: period / 1000,
    tick,
    start() {
      if (timer) return
      timer = setTimer(() => { void tick() }, period)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}
