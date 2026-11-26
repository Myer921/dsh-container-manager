import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'

import { createApi } from '../lib/api.js'
import { normalizePodmanCreate } from '../lib/create-spec.js'
import { writeLxcSettings } from '../helper/net-config.mjs'

function apiFor(principal = { kind: 'owner' }) {
  let state = {
    version: 1,
    nodes: [],
    confirmRequired: true,
    confirmTtlSeconds: 600,
    allowLogs: true,
    logTailDefault: 100,
    logTailMax: 2000,
    compose: {},
    alerts: { webhooks: [], rules: [], dedupeMinutes: 30 },
  }
  const store = {
    get: () => state,
    replace: next => { state = { ...state, ...next }; return state },
    updateCompose() {},
    file: '/tmp/cm-security/config.json',
  }
  const api = createApi({
    registry: { clearProbe() {} },
    configStore: store,
    pendings: { list() { return [] } },
    actions: {},
    audit: { append() {}, read() { return [] } },
    verify: () => ({ ok: true, principal }),
    helperHint: () => '',
  })
  return { api, state: () => state }
}

async function call(api, { url, body = {}, headers = {}, principal = 'panel' } = {}) {
  const req = new PassThrough()
  req.method = 'POST'
  req.url = url
  req.headers = { 'content-type': 'application/json', 'x-cm-request': '1', 'x-cm-principal': principal, ...headers }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = String(value ?? '') },
  }
  const handling = api.handle(req, res)
  req.end(JSON.stringify(body))
  await handling
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

test('helper 的 node:fs 命名导入都存在', async () => {
  const source = readFileSync(new URL('../helper/dsh-lxcd.mjs', import.meta.url), 'utf8')
  const match = source.match(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/)
  assert.ok(match, 'helper 应显式导入 node:fs')
  const fs = await import('node:fs')
  for (const raw of match[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0]
    if (!name) continue
    assert.notEqual(fs[name], undefined, 'node:fs 没有导出 ' + name)
  }
})

test('创建容器拒绝宿主敏感根目录挂载', () => {
  assert.throws(() => normalizePodmanCreate({
    image: 'alpine',
    volumes: [{ source: '/', destination: '/host' }],
  }), /禁止挂载宿主敏感根目录/)
})

test('宿主挂载和自定义命令要求确认', () => {
  const mounted = normalizePodmanCreate({ image: 'alpine', volumes: [{ source: '/srv/data', destination: '/data', ro: true }] })
  assert.equal(mounted.requiresConfirm, true)
  const commanded = normalizePodmanCreate({ image: 'alpine', command: ['sh', '-c', 'id'] })
  assert.equal(commanded.requiresConfirm, true)
})

test('LXC 配置标量拒绝换行注入', () => {
  assert.throws(() => writeLxcSettings('lxc.start.auto = 1\n', {
    initCmd: '/bin/sh\nlxc.mount.entry = / /host none bind,create=dir',
  }), /不允许换行/)
})

test('LXC capability 使用白名单', () => {
  assert.throws(() => writeLxcSettings('', { capDrop: 'made_up_cap' }), /未知 capability/)
  assert.match(writeLxcSettings('', { capDrop: 'sys_time net_raw' }), /lxc\.cap\.drop = sys_time net_raw/)
})

test('非 owner Peer 伪造 panel 头仍被写守卫拒绝', async () => {
  const { api, state } = apiFor({ kind: 'remote' })
  const res = await call(api, { url: '/api/container-manager/config', body: { confirmRequired: false } })
  assert.equal(res.status, 403)
  assert.equal(state().confirmRequired, true)
})

test('告警出口按 id 局部修改，不回写掩码地址', async () => {
  const { api, state } = apiFor()
  const first = await call(api, {
    url: '/api/container-manager/alerts/webhooks/add',
    body: { id: 'h1', name: 'one', kind: 'json', url: 'https://example.org/secret-one', enabled: true },
  })
  assert.equal(first.status, 200)
  const second = await call(api, {
    url: '/api/container-manager/alerts/webhooks/add',
    body: { id: 'h2', name: 'two', kind: 'json', url: 'https://example.org/secret-two', enabled: true },
  })
  assert.equal(second.status, 200)
  const removed = await call(api, { url: '/api/container-manager/alerts/webhooks/delete', body: { id: 'h1' } })
  assert.equal(removed.status, 200)
  assert.deepEqual(state().alerts.webhooks.map(hook => hook.url), ['https://example.org/secret-two'])
})

test('超大 JSON 请求返回 413 且不落盘', async () => {
  const { api, state } = apiFor()
  const req = new PassThrough()
  req.method = 'POST'
  req.url = '/api/container-manager/config'
  req.headers = { 'content-type': 'application/json', 'x-cm-request': '1' }
  const res = {
    statusCode: 0,
    setHeader() {},
    end(value) { this.body = String(value ?? '') },
  }
  const handling = api.handle(req, res)
  req.end(JSON.stringify({ padding: 'x'.repeat(1_100_000) }))
  await handling
  assert.equal(res.statusCode, 413)
  assert.equal(state().confirmRequired, true)
})
