/**
 * 告警出口（P2）：把「什么情况下该通知人」和「通知发到哪」分开。
 *
 * 规则只有四种，都只看面板已经拿得到的事实：
 *   unhealthy  容器健康检查是 unhealthy
 *   restarts   容器重启次数 >= 阈值
 *   disk       宿主根分区占用 >= 阈值（%）
 *   pending    待确认队列里有超过 N 分钟没人处理的危险操作
 *
 * 出口三种：json（自己 POST 一份结构化体）、ntfy、bark。
 *
 * 几条真话：
 *  - 同样的告警在 dedupeMinutes 内只发一次，不然一次盘满能刷出上百条；
 *  - 发送失败不重试到死：这一轮记下来就够，下一轮到了会再试；
 *  - url 里常带 token，回显一律掩码，绝不整条打到面板或日志里。
 */

const MAX_TITLE = 120
const MAX_BODY = 800

function clampText(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/** webhook 地址里可能带 token：只留协议 + 主机 + 尾部几位，够认出来是哪条就行。 */
export function maskUrl(url) {
  const raw = String(url ?? '')
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    const tail = parsed.pathname.length > 8
      ? '…' + parsed.pathname.slice(-4)
      : parsed.pathname
    return parsed.protocol + '//' + parsed.host + tail
  } catch {
    return raw.slice(0, 12) + '…'
  }
}

/** 按规则算这一轮该报什么。纯函数：时间、数据全从参数进来。 */
export function evaluateAlerts({ rules, host, containers, pending, now = Date.now() } = {}) {
  const events = []
  const list = Array.isArray(rules) ? rules.filter(rule => rule && rule.enabled !== false) : []
  const nodes = host && typeof host === 'object' ? host : {}
  const items = Array.isArray(containers) ? containers : []

  for (const rule of list) {
    if (rule.kind === 'unhealthy') {
      for (const container of items) {
        const status = container && container.health && container.health.status
        if (status !== 'unhealthy') continue
        const streak = container.health && container.health.failingStreak
        events.push({
          ruleId: rule.id || rule.kind,
          kind: rule.kind,
          target: container.name,
          title: '容器不健康：' + container.name,
          body: container.name + ' 的健康检查是 unhealthy' + (streak ? '（连续失败 ' + streak + ' 次）' : '') +
            '，节点 ' + (container.nodeId || container.node || '?') + '。',
        })
      }
      continue
    }
    if (rule.kind === 'restarts') {
      for (const container of items) {
        const count = Number(container && container.restarts)
        if (!Number.isFinite(count) || count < rule.threshold) continue
        events.push({
          ruleId: rule.id || rule.kind,
          kind: rule.kind,
          target: container.name,
          title: '容器在反复重启：' + container.name,
          body: container.name + ' 重启了 ' + count + ' 次（阈值 ' + rule.threshold + '）。',
        })
      }
      continue
    }
    if (rule.kind === 'disk') {
      for (const [nodeId, sample] of Object.entries(nodes)) {
        const percent = Number(sample && sample.diskPercent)
        if (!Number.isFinite(percent) || percent < rule.threshold) continue
        events.push({
          ruleId: rule.id || rule.kind,
          kind: rule.kind,
          target: nodeId,
          title: '宿主盘快满了：' + nodeId,
          body: nodeId + ' 的 / 用了 ' + percent + '%（阈值 ' + rule.threshold + '%）。',
        })
      }
      continue
    }
    if (rule.kind === 'pending') {
      const queue = Array.isArray(pending) ? pending : []
      if (queue.length === 0) continue
      const old = queue.filter(item => {
        const at = Date.parse(item && (item.createdAt || item.at) || '')
        if (!Number.isFinite(at)) return false
        return (now - at) / 60_000 >= rule.threshold
      })
      if (old.length === 0) continue
      events.push({
        ruleId: rule.id || rule.kind,
        kind: rule.kind,
        target: 'pending',
        title: '有 ' + old.length + ' 条危险操作在等你确认',
        body: '最久的已经等了 ' + Math.round((now - Date.parse(old[0].createdAt || old[0].at)) / 60_000) +
          ' 分钟：' + old.slice(0, 3).map(item => String(item.summary || item.kind || '?')).join('；'),
      })
    }
  }
  return events
}

/** 把一条事件拼成某个出口要的请求。不认识的出口当 json 处理。 */
export function buildPayload(hook, event, at = new Date().toISOString()) {
  const kind = hook && hook.kind ? hook.kind : 'json'
  const title = clampText(event && event.title, MAX_TITLE)
  const body = clampText(event && event.body, MAX_BODY)
  if (kind === 'ntfy') {
    return {
      url: String(hook.url),
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        title,
        priority: 'high',
        tags: 'whale,warning',
      },
      body: body + '\n（' + at + '）',
    }
  }
  if (kind === 'bark') {
    const base = String(hook.url).replace(/\/+$/, '')
    return {
      url: base + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body),
      method: 'GET',
      headers: {},
      body: null,
    }
  }
  return {
    url: String(hook.url),
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title, body, kind: event && event.kind, target: event && event.target, at }),
  }
}

/**
 * 发告警：过 dedupe，逐个出口发。post 注入（默认 fetch），测试不用起服务。
 */
export function createAlerter({ getConfig, post, now = () => Date.now(), log = () => {}, dedupeMinutes = null } = {}) {
  const fired = new Map()
  const history = []

  function windowMs() {
    const config = getConfig() || {}
    const minutes = dedupeMinutes ?? (Number(config.dedupeMinutes) || 30)
    return Math.max(1, minutes) * 60_000
  }

  async function fire(events, context) {
    const config = getConfig() || {}
    const hooks = (Array.isArray(config.webhooks) ? config.webhooks : []).filter(hook => hook && hook.enabled !== false && hook.url)
    const sent = []
    const suppressed = []
    const failed = []
    if (hooks.length === 0) return { sent, suppressed, failed, reason: '没有配 webhook，告警只在面板里留着。' }

    const stamp = now()
    for (const event of Array.isArray(events) ? events : []) {
      const key = (event.ruleId || event.kind) + ':' + (event.target || '')
      const last = fired.get(key)
      if (last && stamp - last < windowMs()) {
        suppressed.push({ key, lastAt: new Date(last).toISOString() })
        continue
      }
      fired.set(key, stamp)
      for (const hook of hooks) {
        const request = buildPayload(hook, event, new Date(stamp).toISOString())
        try {
          await post(request)
          sent.push({ key, hook: hook.id || maskUrl(hook.url) })
        } catch (error) {
          failed.push({ key, hook: hook.id || maskUrl(hook.url), message: error && error.message ? error.message : String(error) })
          log('告警发送失败：' + (error && error.message ? error.message : String(error)))
        }
      }
      history.push({ at: new Date(stamp).toISOString(), ...event, context: context || null })
      while (history.length > 50) history.shift()
    }
    return { sent, suppressed, failed }
  }

  async function evaluate(context = {}) {
    const config = getConfig() || {}
    const events = evaluateAlerts({
      rules: config.rules,
      host: context.host,
      containers: context.containers,
      pending: context.pending,
      now: now(),
    })
    if (events.length === 0) return { events, sent: [], suppressed: [], failed: [] }
    const result = await fire(events, { nodes: Object.keys(context.host || {}) })
    return { events, ...result }
  }

  return { evaluate, fire, recent: () => history.slice() }
}
