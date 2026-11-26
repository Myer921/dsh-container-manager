/**
 * 备份策略与保留（P2）。
 *
 * 只做 LXC：Podman 那边「备份」的正解是 compose 文件 + 具名卷 + 镜像 digest，
 * 把容器 rootfs 打包下来既重又难恢复 —— 不假装能做。
 *
 * 两件事分开：
 *  - planBackups：哪些容器该导了（超过 everyHours 没导就到期）；
 *  - applyRetention：导出目录里哪些该删（留最近 keepCount 份、且不超过 keepDays 天）。
 * 两个都是纯函数，时间由调用方传进来，测试不用等。
 */

export const ARCHIVE_EXT = /\.tar(\.gz|\.xz|\.bz2|\.zst|\.lzma)?$/

/**
 * 导出文件名是 <容器名>-<UTC 时间戳>.tar.gz（helper 生成的）。
 * 容器名里带 '-' 也能解析：只切最后一个连字符之前的部分。
 */
export function parseExportName(fileName) {
  const base = String(fileName ?? '')
  if (!ARCHIVE_EXT.test(base)) return null
  const stem = base.replace(ARCHIVE_EXT, '')
  const cut = stem.lastIndexOf('-')
  if (cut <= 0) return { container: stem, at: null }
  const container = stem.slice(0, cut)
  const stamp = stem.slice(cut + 1)
  // 20261121T153000
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!match) return { container, at: null }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
  const date = new Date(iso)
  return { container, at: Number.isNaN(date.getTime()) ? null : date.toISOString() }
}

export function normalizeBackupPolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const targets = Array.isArray(source.targets)
    ? source.targets
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(item => /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(item))
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 64)
    : []
  const number = (value, min, max, fallback) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }
  return {
    enabled: source.enabled === true,
    targets,
    everyHours: number(source.everyHours, 1, 24 * 30, 24),
    keepCount: number(source.keepCount, 1, 64, 5),
    keepDays: number(source.keepDays, 1, 3650, 14),
    dir: typeof source.dir === 'string' && source.dir.trim().startsWith('/') ? source.dir.trim() : '',
  }
}

/** 按期判断：每个目标上次导出多久了、该不该导。 */
export function planBackups({ policy, files, containers, now = Date.now() } = {}) {
  const picked = normalizeBackupPolicy(policy)
  const all = Array.isArray(files) ? files : []
  const names = new Set((Array.isArray(containers) ? containers : []).map(item => (typeof item === 'string' ? item : item && item.name)).filter(Boolean))
  const due = []
  const fresh = []
  const missing = []
  for (const name of picked.targets) {
    if (!names.has(name)) {
      missing.push(name)
      continue
    }
    let lastAt = null
    for (const file of all) {
      const parsed = parseExportName(file?.name)
      if (!parsed || parsed.container !== name || !parsed.at) continue
      if (!lastAt || parsed.at > lastAt) lastAt = parsed.at
    }
    const ageHours = lastAt ? (now - Date.parse(lastAt)) / 3_600_000 : null
    if (ageHours === null || ageHours >= picked.everyHours) {
      due.push({ name, lastAt, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10 })
    } else {
      fresh.push({ name, lastAt, ageHours: Math.round(ageHours * 10) / 10 })
    }
  }
  return { due, fresh, missing, policy: picked }
}

/** 保留策略：按容器分组，留最近 keepCount 份、且不超过 keepDays 天。 */
export function applyRetention({ files, keepCount = 5, keepDays = 14, now = Date.now(), targets = null } = {}) {
  const groups = new Map()
  const allowed = Array.isArray(targets) ? new Set(targets) : null
  for (const file of Array.isArray(files) ? files : []) {
    const parsed = parseExportName(file?.name)
    if (!parsed) continue
    if (allowed && !allowed.has(parsed.container)) continue
    const at = parsed.at || (file && file.at) || null
    const key = parsed.container
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ...file, container: key, at, bytes: Number(file?.bytes ?? 0) })
  }
  const keep = []
  const remove = []
  const cutoff = now - keepDays * 86_400_000
  for (const [, items] of groups) {
    const sorted = items.slice().sort((left, right) => {
      const leftAt = left.at ? Date.parse(left.at) : 0
      const rightAt = right.at ? Date.parse(right.at) : 0
      return rightAt - leftAt
    })
    sorted.forEach((file, index) => {
      const stamp = file.at ? Date.parse(file.at) : 0
      const tooOld = stamp > 0 && stamp < cutoff
      if (index >= keepCount || tooOld) remove.push(file)
      else keep.push(file)
    })
  }
  return {
    keep,
    remove,
    freedBytes: remove.reduce((sum, file) => sum + file.bytes, 0),
  }
}

/**
 * 自动备份的执行器。真正的动作都靠注入：listFiles / exportNow / removeFile，
 * 这样没有 LXC 也能测，而且每次只跑一个导出（不并发拷 rootfs）。
 */
export function createBackupScheduler({
  getPolicy, listFiles, exportNow, removeFile, listContainers,
  getJob = null, waitJob = null, canExport = async () => true, now = () => Date.now(), log = () => {},
}) {
  let running = false
  const inFlight = new Map()
  const events = []
  function note(level, text) {
    const event = { at: new Date(now()).toISOString(), level, text }
    events.push(event)
    while (events.length > 40) events.shift()
    try { log(event) } catch { /* 记日志失败不影响备份 */ }
  }

  async function defaultWaitJob(id) {
    if (!getJob) throw new Error('备份任务没有可用的状态查询器。')
    const deadline = Date.now() + 2 * 60 * 60_000
    while (Date.now() < deadline) {
      const job = getJob(id)
      if (!job) throw new Error('备份任务不存在：' + id)
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('备份任务等待超时：' + id)
  }

  async function tick() {
    const policy = normalizeBackupPolicy(getPolicy())
    if (!policy.enabled) return { skipped: 'disabled', started: [], removed: [], events }
    if (policy.targets.length === 0) return { skipped: 'no-targets', started: [], removed: [], events }
    if (!(await canExport())) return { skipped: 'export-unavailable', started: [], removed: [], events }
    if (running) return { skipped: 'busy', started: [], removed: [], events }
    running = true
    const started = []
    const removed = []
    let exportFailed = false
    try {
      const files = await listFiles()
      let containers = []
      try {
        containers = await listContainers()
      } catch (error) {
        note('warn', '读不到容器清单，这一轮只做保留：' + (error && error.message ? error.message : error))
      }
      const plan = planBackups({ policy, files, containers, now: now() })
      if (plan.missing.length > 0) note('warn', '这些目标不是 LXC 容器，跳过了：' + plan.missing.join('、'))
      for (const item of plan.due) {
        if (inFlight.has(item.name)) {
          note('info', item.name + ' 已有导出任务在跑，本轮跳过。')
          continue
        }
        try {
          note('info', '开始导出 ' + item.name)
          const result = await exportNow(item.name)
          if (result && result.status === 'job' && result.job?.id) {
            const id = result.job.id
            inFlight.set(item.name, id)
            const final = await (waitJob || defaultWaitJob)(id)
            inFlight.delete(item.name)
            if (!final || final.status !== 'done') throw new Error(final?.error || ('任务终态：' + (final?.status || 'unknown')))
          }
          started.push(item.name)
        } catch (error) {
          exportFailed = true
          note('bad', '导出 ' + item.name + ' 失败：' + (error && error.message ? error.message : error))
        }
      }
      const after = started.length > 0 ? await listFiles() : files
      if (!exportFailed) {
        const retention = applyRetention({
          files: after,
          keepCount: policy.keepCount,
          keepDays: policy.keepDays,
          now: now(),
          targets: policy.targets,
        })
        for (const file of retention.remove) {
          try {
            const result = await removeFile(file.name)
            if (result && result.status === 'pending') note('warn', '旧备份 ' + file.name + ' 的删除已挂起，尚未移除。')
            else removed.push(file.name)
          } catch (error) {
            note('warn', '删旧备份 ' + file.name + ' 失败：' + (error && error.message ? error.message : error))
          }
        }
      } else {
        note('warn', '本轮有导出失败，保留旧备份不执行清理。')
      }
      if (started.length > 0) note('ok', '导出了 ' + started.length + ' 个容器')
      if (removed.length > 0) note('info', '按保留策略删了 ' + removed.length + ' 份旧归档')
      return { skipped: null, started, removed, events }
    } finally {
      running = false
    }
  }

  return { tick, events: () => events.slice() }
}
