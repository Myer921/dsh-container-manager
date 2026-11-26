import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPayload, createAlerter, evaluateAlerts, maskUrl } from '../lib/alerts.js'

const NOW = Date.parse('2026-11-24T12:00:00Z')

test('unhealthy 规则按容器报，带连续失败次数', () => {
  const events = evaluateAlerts({
    rules: [{ id: 'uh', kind: 'unhealthy', threshold: 1 }],
    containers: [
      { name: 'unlock', nodeId: 'local-lxc', health: { status: 'unhealthy', failingStreak: 4 } },
      { name: 'fwchat', nodeId: 'local-lxc', health: { status: 'healthy' } },
      { name: 'plain', nodeId: 'local-podman', health: null },
    ],
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].target, 'unlock')
  assert.match(events[0].body, /连续失败 4 次/)
})

test('restarts 规则只报超过阈值的；字段缺失不误报', () => {
  const events = evaluateAlerts({
    rules: [{ id: 'r', kind: 'restarts', threshold: 3 }],
    containers: [
      { name: 'a', restarts: 5 },
      { name: 'b', restarts: 2 },
      { name: 'c' },
      { name: 'd', restarts: 'x' },
    ],
    now: NOW,
  })
  assert.deepEqual(events.map(event => event.target), ['a'])
})

test('disk 规则按节点报；拿不到占用就不报', () => {
  const events = evaluateAlerts({
    rules: [{ id: 'd', kind: 'disk', threshold: 85 }],
    host: { 'local-podman': { diskPercent: 91 }, 'local-lxc': { diskPercent: null } },
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].target, 'local-podman')
  assert.match(events[0].body, /91%/)
})

test('pending 规则只看等太久的，不吵刚挂起的', () => {
  const events = evaluateAlerts({
    rules: [{ id: 'p', kind: 'pending', threshold: 10 }],
    pending: [
      { status: 'pending', summary: '删容器 unlock', createdAt: '2026-11-24T11:40:00Z' },
      { status: 'pending', summary: '刚点的', createdAt: '2026-11-24T11:59:00Z' },
      { status: 'done', summary: '已完成的', createdAt: '2026-11-24T11:00:00Z' },
    ],
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.match(events[0].title, /1 条/)
  assert.match(events[0].body, /删容器 unlock/)
})

test('规矩是关掉的规则不算', () => {
  const events = evaluateAlerts({
    rules: [{ id: 'd', kind: 'disk', threshold: 1, enabled: false }],
    host: { n: { diskPercent: 99 } },
    now: NOW,
  })
  assert.deepEqual(events, [])
})

test('三种出口的请求形状：json 是 POST JSON、ntfy 走头、bark 走路径', () => {
  const event = { kind: 'disk', target: 'n1', title: '宿主盘快满了', body: '用了 91%' }
  const json = buildPayload({ id: 'h1', kind: 'json', url: 'https://example.org/hook' }, event, '2026-11-24T12:00:00Z')
  assert.equal(json.method, 'POST')
  assert.match(json.headers['content-type'], /application\/json/)
  assert.equal(JSON.parse(json.body).target, 'n1')

  const ntfy = buildPayload({ id: 'h2', kind: 'ntfy', url: 'https://ntfy.sh/topic' }, event, '2026-11-24T12:00:00Z')
  assert.equal(ntfy.method, 'POST')
  assert.equal(ntfy.headers.title, '宿主盘快满了')
  assert.match(ntfy.body, /91%/)

  const bark = buildPayload({ id: 'h3', kind: 'bark', url: 'https://api.day.app/key/' }, event, '2026-11-24T12:00:00Z')
  assert.equal(bark.method, 'GET')
  assert.match(bark.url, /^https:\/\/api\.day\.app\/key\//)
  assert.equal(bark.body, null)
})

test('标题和正文会被截断，不把整段日志塞进通知', () => {
  const built = buildPayload({ kind: 'json', url: 'https://example.org/h' }, { title: 'x'.repeat(400), body: 'y'.repeat(4000) })
  const parsed = JSON.parse(built.body)
  assert.ok(parsed.title.length <= 120)
  assert.ok(parsed.body.length <= 800)
})

test('webhook 地址掩码：留下主机和尾几位，藏住 token', () => {
  const masked = maskUrl('https://ntfy.sh/secret-topic-abcdef')
  assert.ok(!masked.includes('secret-topic-abcdef'))
  assert.match(masked, /ntfy\.sh/)
  assert.equal(maskUrl(''), '')
  assert.match(maskUrl('not a url'), /…/)
})

test('发告警：同一件事在去重窗口内只发一次', async () => {
  const posts = []
  let clock = NOW
  const alerter = createAlerter({
    getConfig: () => ({
      dedupeMinutes: 30,
      webhooks: [{ id: 'h', url: 'https://example.org/hook', kind: 'json', enabled: true }],
      rules: [{ id: 'd', kind: 'disk', threshold: 80 }],
    }),
    post: async request => { posts.push(request) },
    now: () => clock,
  })
  const first = await alerter.evaluate({ host: { n1: { diskPercent: 90 } } })
  assert.equal(first.sent.length, 1)
  assert.equal(posts.length, 1)
  clock = NOW + 60_000
  const second = await alerter.evaluate({ host: { n1: { diskPercent: 92 } } })
  assert.equal(second.sent.length, 0)
  assert.equal(second.suppressed.length, 1)
  assert.equal(posts.length, 1)
  clock = NOW + 31 * 60_000
  const third = await alerter.evaluate({ host: { n1: { diskPercent: 93 } } })
  assert.equal(third.sent.length, 1)
  assert.equal(posts.length, 2)
})

test('没有配 webhook 时留个原因，不当成发成功', async () => {
  const alerter = createAlerter({
    getConfig: () => ({ webhooks: [], rules: [{ id: 'd', kind: 'disk', threshold: 1 }] }),
    post: async () => { throw new Error('不该被调') },
    now: () => NOW,
  })
  const result = await alerter.evaluate({ host: { n: { diskPercent: 99 } } })
  assert.equal(result.sent.length, 0)
  assert.match(result.reason, /没有配 webhook/)
})

test('发送失败记下来继续走，不打断后面的出口', async () => {
  const alerter = createAlerter({
    getConfig: () => ({
      webhooks: [
        { id: 'bad', url: 'https://example.org/bad', kind: 'json', enabled: true },
        { id: 'good', url: 'https://example.org/good', kind: 'json', enabled: true },
      ],
      rules: [{ id: 'd', kind: 'disk', threshold: 1 }],
    }),
    post: async request => {
      if (request.url.includes('bad')) throw new Error('连接超时')
    },
    now: () => NOW,
  })
  const result = await alerter.evaluate({ host: { n: { diskPercent: 99 } } })
  assert.equal(result.failed.length, 1)
  assert.equal(result.sent.length, 1)
  assert.equal(result.sent[0].hook, 'good')
})

test('没有事件时什么都不发', async () => {
  const alerter = createAlerter({
    getConfig: () => ({ webhooks: [{ id: 'h', url: 'https://example.org', kind: 'json' }], rules: [{ id: 'd', kind: 'disk', threshold: 99 }] }),
    post: async () => { throw new Error('不该被调') },
    now: () => NOW,
  })
  const result = await alerter.evaluate({ host: { n: { diskPercent: 10 } } })
  assert.deepEqual(result.events, [])
})
