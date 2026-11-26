const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export function normalizeSnapshotPolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const number = (value, min, max, fallback) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }
  const targets = Array.isArray(source.targets)
    ? source.targets.map(item => String(item ?? '').trim()).filter(item => TARGET_RE.test(item)).filter((item, index, list) => list.indexOf(item) === index).slice(0, 64)
    : []
  return {
    enabled: source.enabled === true,
    targets,
    everyHours: number(source.everyHours, 1, 24 * 30, 24),
    keepCount: number(source.keepCount, 1, 64, 5),
  }
}

export function planSnapshots({ policy, state, containers, now = Date.now() } = {}) {
  const picked = normalizeSnapshotPolicy(policy)
  const names = new Set((Array.isArray(containers) ? containers : []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean))
  const due = []
  const fresh = []
  const missing = []
  for (const name of picked.targets) {
    if (!names.has(name)) { missing.push(name); continue }
    const known = state?.containers?.[name]
    const latest = Array.isArray(known) && known.length > 0
      ? known.reduce((best, item) => !best || Date.parse(item.createdAt) > Date.parse(best.createdAt) ? item : best, null)
      : null
    const ageHours = latest ? (now - Date.parse(latest.createdAt)) / 3_600_000 : null
    if (ageHours === null || ageHours >= picked.everyHours) due.push({ name, latest, ageHours })
    else fresh.push({ name, latest, ageHours })
  }
  return { due, fresh, missing, policy: picked }
}

export function retainSnapshots({ state, targets, keepCount = 5 } = {}) {
  const allowed = new Set(Array.isArray(targets) ? targets : [])
  const remove = []
  for (const [name, items] of Object.entries(state?.containers || {})) {
    if (!allowed.has(name) || !Array.isArray(items)) continue
    const sorted = items.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    for (const item of sorted.slice(keepCount)) remove.push({ container: name, snapshot: item.name })
  }
  return remove
}

export function createSnapshotScheduler({
  getPolicy, listContainers, listSnapshots, createSnapshot, deleteSnapshot,
  getJob = null, waitJob = null, loadState = () => ({}), saveState = () => {},
  now = () => Date.now(), log = () => {},
}) {
  let running = false
  const events = []
  function note(level, text) {
    const event = { at: new Date(now()).toISOString(), level, text }
    events.push(event)
    if (events.length > 40) events.shift()
    try { log(event) } catch { /* 日志失败不影响调度 */ }
  }

  async function defaultWaitJob(id) {
    if (!getJob) throw new Error('快照任务没有状态查询器。')
    const deadline = Date.now() + 2 * 60 * 60_000
    while (Date.now() < deadline) {
      const job = getJob(id)
      if (!job) throw new Error('快照任务不存在：' + id)
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('快照任务等待超时：' + id)
  }

  async function tick() {
    const policy = normalizeSnapshotPolicy(getPolicy())
    if (!policy.enabled) return { skipped: 'disabled', started: [], removed: [], events }
    if (policy.targets.length === 0) return { skipped: 'no-targets', started: [], removed: [], events }
    if (running) return { skipped: 'busy', started: [], removed: [], events }
    running = true
    const started = []
    const removed = []
    try {
      const state = loadState() || {}
      state.containers ||= {}
      const containers = await listContainers()
      const available = new Set((Array.isArray(containers) ? containers : []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean))
      for (const name of policy.targets) {
        if (!available.has(name) || !Array.isArray(state.containers[name])) continue
        try {
          const actual = await listSnapshots(name)
          const names = new Set((actual.snapshots || []).map(snapshot => snapshot.name))
          state.containers[name] = state.containers[name].filter(snapshot => names.has(snapshot.name))
        } catch (error) {
          note('warn', '核对 ' + name + ' 的快照列表失败：' + (error?.message || error))
        }
      }
      const plan = planSnapshots({ policy, state, containers, now: now() })
      if (plan.missing.length) note('warn', '这些定时快照目标不是 LXC 容器：' + plan.missing.join('、'))
      let failed = false
      const failedTargets = new Set()
      for (const item of plan.due) {
        try {
          note('info', '开始为 ' + item.name + ' 建定时快照')
          const before = await listSnapshots(item.name)
          const beforeNames = new Set((before.snapshots || []).map(snapshot => snapshot.name))
          const result = await createSnapshot(item.name)
          if (result?.status === 'job' && result.job?.id) {
            const final = await (waitJob || defaultWaitJob)(result.job.id)
            if (!final || final.status !== 'done') throw new Error(final?.error || ('任务终态：' + final?.status))
          }
          const after = await listSnapshots(item.name)
          const created = (after.snapshots || []).find(snapshot => !beforeNames.has(snapshot.name))
          if (!created) throw new Error('命令结束但快照列表没有新增。')
          const record = { name: created.name, createdAt: new Date(now()).toISOString(), comment: created.detail || '' }
          state.containers[item.name] = [...(state.containers[item.name] || []), record]
          started.push({ name: item.name, snapshot: created.name })
        } catch (error) {
          failed = true
          failedTargets.add(item.name)
          note('bad', '定时快照 ' + item.name + ' 失败：' + (error?.message || error))
        }
      }
      const retentionTargets = policy.targets.filter(name => !failedTargets.has(name))
      for (const item of retainSnapshots({ state, targets: retentionTargets, keepCount: policy.keepCount })) {
        try {
          await deleteSnapshot(item.container, item.snapshot)
          state.containers[item.container] = (state.containers[item.container] || []).filter(snapshot => snapshot.name !== item.snapshot)
          removed.push(item)
        } catch (error) {
          note('warn', '删除旧快照 ' + item.container + '/' + item.snapshot + ' 失败：' + (error?.message || error))
        }
      }
      saveState(state)
      if (started.length) note('ok', '定时快照完成 ' + started.length + ' 个容器')
      if (failed) note('warn', '本轮有快照失败，未删除该目标的旧快照。')
      return { skipped: null, started, removed, events }
    } finally {
      running = false
    }
  }

  return { tick, events: () => events.slice() }
}
