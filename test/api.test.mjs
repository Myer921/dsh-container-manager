import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApi } from '../lib/api.js'
import { createActions } from '../lib/actions.js'
import { createConfigStore } from '../lib/config.js'
import { createPendingStore } from '../lib/pending.js'

// 网卡 MAC 由 create-spec 缺省自动生成（随机），比较结构时先剥掉它。
const withoutMac = net => { const { hwaddr, hwaddrAuto, ...rest } = net || {}; return rest }


function makeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  const res = {
    state,
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value },
    end(body) { state.body = String(body ?? '') },
    json() { return JSON.parse(state.body) },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: value => { state.statusCode = value },
  })
  return res
}

function makeRequest({ method = 'GET', url = '/api/container-manager/state', headers = {}, body = null } = {}) {
  const listeners = {}
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3085', ...headers },
    setEncoding() {},
    on(event, handler) {
      listeners[event] = handler
      return this
    },
    destroy() {},
    start() {
      if (body !== null && listeners.data) listeners.data(JSON.stringify(body))
      if (listeners.end) listeners.end()
    },
  }
}

function setup({ verify = () => ({ ok: true, principal: { kind: 'owner' } }) } = {}) {
  process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-api-'))
  const configStore = createConfigStore({})
  const pendings = createPendingStore({ file: join(process.env.DSH_CM_DIR, 'pending.json'), ttlSeconds: 600 })
  const registryCalls = []
  const registry = {
    async snapshot() {
      return {
        nodes: [{ id: 'local-podman', label: '本机 Podman', kind: 'podman', transport: 'local', available: true, detail: { version: '4.3.1', rootless: true } }],
        containers: [{ nodeId: 'local-podman', id: 'abc', name: 'demo', state: 'running', image: 'alpine', ports: [], networks: [] }],
        networks: [{ nodeId: 'local-podman', name: 'podman', driver: 'bridge', subnet: '10.88.0.0/16', gateway: '10.88.0.1', containers: [] }],
        errors: [],
        at: new Date().toISOString(),
      }
    },
    async probeAll() { return [{ node: { id: 'local-podman', label: '本机 Podman', kind: 'podman', transport: 'local' }, available: true, code: null, reason: null, hint: null, detail: null }] },
    async inspect(node, ref) { return { id: ref, name: ref, state: 'running' } },
    async logs(node, ref, tail) { return { text: 'hello', truncated: false } },
    async act(node, ref, action) { registryCalls.push({ kind: 'act', node, ref, action }); return { action, ref } },
    async networkOp(node, op) { registryCalls.push({ kind: 'net', node, op }); return { op: op.op } },
    async lxcNetwork(node, ref) { return { name: ref, nics: [] } },
    async lxcNetworkSet(node, ref, nics, options) { registryCalls.push({ kind: 'lxc-net', node, ref, nics, options }); return { ref } },
    async hostInfo() { return { host: {} } },
    async ensureModule(node, name) { return { module: name, loaded: true } },
    async createContainer(node, spec) {
      registryCalls.push({ kind: 'create', node, spec })
      return { nodeId: node, kind: 'podman', name: spec.name ?? 'generated', id: 'deadbeef', state: 'running', warnings: [], detail: { name: spec.name ?? 'generated' } }
    },
    async updatePodmanCgroup(node, ref, limits) {
      registryCalls.push({ kind: 'limits', node, ref, limits })
      return { ref, applied: limits, detail: { name: ref } }
    },
    async setLxcConfig(node, name, patch) {
      registryCalls.push({ kind: 'lxc-config', node, name, patch })
      return { name, changed: true, settings: { autostart: Boolean(patch.autostart), memoryMax: patch.memoryMax ?? '' } }
    },
    async listImages(node) {
      registryCalls.push({ kind: 'images', node })
      return [{ reference: 'docker.io/library/alpine:3.22' }]
    },
    async listLxcExports(node) {
      registryCalls.push({ kind: 'exports', node })
      return { dir: '/var/lib/dsh-container-manager/exports', files: [] }
    },
  }
  const audit = { append() {}, read() { return [] } }
  const actions = createActions({ registry, configStore, pendings, audit })
  const api = createApi({ registry, configStore, pendings, actions, audit, verify, helperHint: () => 'install me' })
  return { api, pendings, configStore, registryCalls, registry }
}

async function call(api, { method = 'GET', url, headers = {}, body = null }) {
  const req = makeRequest({ method, url, headers, body })
  const res = makeResponse()
  const pendingCall = api.handle(req, res)
  req.start()
  await pendingCall
  return res
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-cm-request': '1' }

test('GET /state 返回聚合快照', async () => {
  const { api } = setup()
  const res = await call(api, {})
  assert.equal(res.state.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.containers.length, 1)
  assert.equal(body.data.nodes[0].id, 'local-podman')
  assert.deepEqual(body.data.pending, [])
})

test('认证失败直接 401', async () => {
  const { api } = setup({ verify: () => ({ ok: false, status: 401, reason: 'no cookie' }) })
  const res = await call(api, {})
  assert.equal(res.state.statusCode, 401)
  assert.equal(res.json().error.code, 'UNAUTHORIZED')
})

test('写请求缺 x-cm-request 被拒', async () => {
  const { api } = setup()
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/actions',
    headers: { 'content-type': 'application/json' },
    body: { node: 'local-podman', ref: 'demo', action: 'start' },
  })
  assert.equal(res.state.statusCode, 403)
})

test('写请求必须是 JSON', async () => {
  const { api } = setup()
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/actions',
    headers: { 'x-cm-request': '1', 'content-type': 'text/plain' },
    body: { node: 'x' },
  })
  assert.equal(res.state.statusCode, 415)
})

test('安全动作经面板直接执行', async () => {
  const { api, registryCalls } = setup()
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/actions',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { node: 'local-podman', ref: 'demo', action: 'start' },
  })
  assert.equal(res.state.statusCode, 200)
  assert.equal(res.json().data.status, 'done')
  assert.equal(registryCalls.length, 1)
})

test('删除经 API 返回 pending，确认要求 panel principal', async () => {
  const { api, registryCalls } = setup()
  const created = await call(api, {
    method: 'POST',
    url: '/api/container-manager/actions',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { node: 'local-podman', ref: 'demo', action: 'delete' },
  })
  assert.equal(created.json().data.status, 'pending')
  assert.equal(registryCalls.length, 0)
  const token = created.json().data.token

  const { api: deniedApi } = setup({ verify: () => ({ ok: true, principal: { kind: 'remote' } }) })
  const denied = await call(deniedApi, {
    method: 'POST',
    url: '/api/container-manager/actions/confirm',
    headers: WRITE_HEADERS,
    body: { token },
  })
  assert.equal(denied.state.statusCode, 403)

  const confirmed = await call(api, {
    method: 'POST',
    url: '/api/container-manager/actions/confirm',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { token },
  })
  assert.equal(confirmed.state.statusCode, 200)
  assert.equal(confirmed.json().data.status, 'done')
  assert.equal(registryCalls.length, 1)
})

test('不存在的前缀被 404', async () => {
  const { api } = setup()
  const res = await call(api, { url: '/api/other' })
  assert.equal(res.state.statusCode, 404)
})

test('未知路径 404，未知方法 405', async () => {
  const { api } = setup()
  const missing = await call(api, { url: '/api/container-manager/nope' })
  assert.equal(missing.state.statusCode, 404)

  const wrongMethod = await call(api, {
    method: 'PUT',
    url: '/api/container-manager/state',
    headers: WRITE_HEADERS,
  })
  assert.equal(wrongMethod.state.statusCode, 405)
})

test('容器详情与日志路由', async () => {
  const { api } = setup()
  const detail = await call(api, { url: '/api/container-manager/containers/local-podman/demo' })
  assert.equal(detail.state.statusCode, 200)
  assert.equal(detail.json().data.name, 'demo')

  const logs = await call(api, { url: '/api/container-manager/containers/local-podman/demo/logs?tail=20' })
  assert.equal(logs.state.statusCode, 200)
  assert.equal(logs.json().data.text, 'hello')
})

test('LXC 网卡接口：读直接、写走 pending', async () => {
  const { api, registryCalls } = setup()
  const read = await call(api, { url: '/api/container-manager/containers/local-lxc/demo-lxc/network' })
  assert.equal(read.state.statusCode, 200)
  assert.equal(read.json().data.nics.length, 0)

  const write = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers/local-lxc/demo-lxc/network',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { nics: [{ type: 'veth', link: 'lxcbr0' }], restart: true },
  })
  assert.equal(write.state.statusCode, 200)
  assert.equal(write.json().data.status, 'pending')
  assert.equal(registryCalls.length, 0)
})
/* ───────────────────────── 创建 / 限制 / 启动项 ───────────────────────── */

test('POST /containers 创建 Podman 容器并透传归一化后的 spec', async () => {
  const { api, registryCalls } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers',
    headers: WRITE_HEADERS,
    body: { node: 'local-podman', image: 'alpine:3.22', name: 'demo-1', ports: [{ containerPort: 80 }] },
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().ok, true)
  const created = registryCalls.find(item => item.kind === 'create')
  assert.ok(created, '应当调用 registry.createContainer')
  assert.equal(created.spec.image, 'alpine:3.22')
  assert.deepEqual(created.spec.ports, [{ hostPort: 80, containerPort: 80, protocol: 'tcp' }])
})

test('POST /containers 缺 node 报 400，镜像非法也报 400', async () => {
  const { api } = setup()
  const noNode = await call(api, { method: 'POST', url: '/api/container-manager/containers', headers: WRITE_HEADERS, body: { image: 'alpine' } })
  assert.equal(noNode.statusCode, 400)
  const badImage = await call(api, { method: 'POST', url: '/api/container-manager/containers', headers: WRITE_HEADERS, body: { node: 'local-podman', image: '-nope' } })
  assert.equal(badImage.statusCode, 400)
})

test('POST /containers 缺 x-cm-request 被拒，不执行', async () => {
  const { api, registryCalls } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers',
    headers: { 'content-type': 'application/json' },
    body: { node: 'local-podman', image: 'alpine' },
  })
  assert.equal(result.statusCode, 403)
  assert.equal(registryCalls.some(item => item.kind === 'create'), false)
})

test('POST /containers 创建 LXC 容器走 lxc 分支', async () => {
  const { api, registryCalls } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers',
    headers: WRITE_HEADERS,
    body: { node: 'local-lxc', name: 'lxc-1', distro: 'alpine', release: '3.22', arch: 'arm64', network: 'lxcbr0' },
  })
  assert.equal(result.statusCode, 200)
  const created = registryCalls.find(item => item.kind === 'create')
  assert.equal(created.spec.distro, 'alpine')
  assert.deepEqual(withoutMac(created.spec.network), { type: 'veth', link: 'lxcbr0' })
})

test('GET /images 需要 node 参数', async () => {
  const { api } = setup()
  const missing = await call(api, { method: 'GET', url: '/api/container-manager/images' })
  assert.equal(missing.statusCode, 400)
  const ok = await call(api, { method: 'GET', url: '/api/container-manager/images?node=local-podman' })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().data[0].reference, 'docker.io/library/alpine:3.22')
})

test('GET /lxc/templates 给建议清单与架构', async () => {
  const { api } = setup()
  const result = await call(api, { method: 'GET', url: '/api/container-manager/lxc/templates' })
  assert.equal(result.statusCode, 200)
  assert.ok(Array.isArray(result.json().data.suggestions))
  assert.ok(result.json().data.arches.includes('arm64'))
})

test('POST /limits 直接执行，不挂起', async () => {
  const { api, registryCalls } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers/local-podman/demo/limits',
    headers: WRITE_HEADERS,
    body: { memory: '256m', cpus: 1.5 },
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().data.status, 'done')
  const call1 = registryCalls.find(item => item.kind === 'limits')
  assert.deepEqual(call1.limits, { memory: '256m', cpus: 1.5 })
})

test('POST /config（LXC 启动项）走待确认，不直接写', async () => {
  const { api, registryCalls } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers/local-lxc/lxc-1/config',
    headers: WRITE_HEADERS,
    body: { autostart: true, memoryMax: '256m' },
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().data.status, 'pending')
  assert.match(result.json().data.summary, /开机自启 开/)
  assert.equal(registryCalls.some(item => item.kind === 'lxc-config'), false, '挂起时不能先写')
})

test('POST /config 没有可改项时报 400', async () => {
  const { api } = setup()
  const result = await call(api, {
    method: 'POST',
    url: '/api/container-manager/containers/local-lxc/lxc-1/config',
    headers: WRITE_HEADERS,
    body: {},
  })
  assert.equal(result.statusCode, 400)
})

test('GET /authz 给出角色、deny 与能力矩阵', async () => {
  const { api } = setup()
  const res = await call(api, { url: '/api/container-manager/authz' })
  assert.equal(res.state.statusCode, 200)
  const data = res.json().data
  assert.equal(data.role, 'operator')
  assert.deepEqual(data.deny, [])
  assert.equal(data.matrix.length, 3)
  assert.equal(data.access.container_action, 'danger')
})

test('AI 不能给自己提权：非 owner 请求改 /authz/set 被拒', async () => {
  const { api, configStore } = setup({ verify: () => ({ ok: true, principal: { kind: 'remote' } }) })
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/authz/set',
    headers: WRITE_HEADERS,
    body: { role: 'admin' },
  })
  assert.equal(res.state.statusCode, 403)
  assert.match(res.json().error.message, /owner/)
  assert.equal(configStore.get().authz.aiRole, 'operator')
})

test('面板改角色：写进配置，deny 会被规范化', async () => {
  const { api, configStore } = setup()
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/authz/set',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { role: 'readonly', deny: ['container_logs', 'container_logs', 'a b'] },
  })
  assert.equal(res.state.statusCode, 200)
  assert.equal(configStore.get().authz.aiRole, 'readonly')
  assert.deepEqual(configStore.get().authz.deny, ['container_logs'])
})

test('改角色用到的非法值会回落到 operator，不炸', async () => {
  const { api, configStore } = setup()
  await call(api, {
    method: 'POST',
    url: '/api/container-manager/authz/set',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { role: 'root' },
  })
  assert.equal(configStore.get().authz.aiRole, 'operator')
})


test('GET /backup 给出策略、归档与到期清单', async () => {
  const { api } = setup()
  const res = await call(api, { url: '/api/container-manager/backup' })
  assert.equal(res.state.statusCode, 200)
  const data = res.json().data
  assert.equal(data.policy.enabled, false)
  assert.deepEqual(data.files, [])
  assert.deepEqual(data.due, [])
})

test('POST /backup/policy 只有面板能改，写进来会被规范化', async () => {
  const { api, configStore } = setup()
  const { api: deniedApi } = setup({ verify: () => ({ ok: true, principal: { kind: 'remote' } }) })
  const denied = await call(deniedApi, {
    method: 'POST',
    url: '/api/container-manager/backup/policy',
    headers: WRITE_HEADERS,
    body: { enabled: true },
  })
  assert.equal(denied.state.statusCode, 403)
  assert.match(denied.json().error.message, /owner/)

  const ok = await call(api, {
    method: 'POST',
    url: '/api/container-manager/backup/policy',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { enabled: true, targets: ['unlock'], everyHours: 0 },
  })
  assert.equal(ok.state.statusCode, 200)
  assert.equal(configStore.get().backupPolicy.enabled, true)
  assert.deepEqual(configStore.get().backupPolicy.targets, ['unlock'])
  assert.equal(configStore.get().backupPolicy.everyHours, 1)
})

test('POST /backup/run 没接调度器时给明确错误，不让 AI 硬跑', async () => {
  const { api } = setup({ verify: () => ({ ok: true, principal: { kind: 'remote' } }) })
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/backup/run',
    headers: WRITE_HEADERS,
    body: {},
  })
  assert.equal(res.state.statusCode, 403)
  assert.match(res.json().error.message, /owner/)
})

test('面板跑一轮备份：结果原样返回', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-api-backup-'))
  process.env.DSH_CM_DIR = tmp
  const configStore = createConfigStore({})
  const pendings = createPendingStore({ file: join(tmp, 'pending.json'), ttlSeconds: 600 })
  const calls = []
  const backup = {
    async tick() {
      calls.push('tick')
      return { skipped: null, started: ['unlock'], removed: [], events: [] }
    },
    events() { return [] },
  }
  const api = createApi({
    registry: {},
    configStore,
    pendings,
    actions: {},
    audit: { append() {}, read() { return [] } },
    verify: () => ({ ok: true, principal: { kind: 'owner' } }),
    backup,
  })
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/backup/run',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: {},
  })
  assert.equal(res.state.statusCode, 200)
  assert.deepEqual(res.json().data.started, ['unlock'])
  assert.deepEqual(calls, ['tick'])
})


test('GET /alerts 给规则、掩码出口与最近发送', async () => {
  const { api } = setup()
  const res = await call(api, { url: '/api/container-manager/alerts' })
  assert.equal(res.state.statusCode, 200)
  const data = res.json().data
  assert.deepEqual(data.rules, [])
  assert.equal(data.hasWebhooks, false)
  assert.deepEqual(data.webhooks, [])
})

test('改告警规则只有 owner 能改', async () => {
  const { api, configStore } = setup()
  const { api: deniedApi } = setup({ verify: () => ({ ok: true, principal: { kind: 'remote' } }) })
  const denied = await call(deniedApi, {
    method: 'POST',
    url: '/api/container-manager/alerts/rules',
    headers: WRITE_HEADERS,
    body: { rules: [{ kind: 'disk', threshold: 90 }] },
  })
  assert.equal(denied.state.statusCode, 403)
  assert.equal(configStore.get().alerts.rules.length, 0)

  const ok = await call(api, {
    method: 'POST',
    url: '/api/container-manager/alerts/rules',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { rules: [{ id: 'd', kind: 'disk', threshold: 90, enabled: true }, { id: 'x', kind: '没这个', threshold: 1 }] },
  })
  assert.equal(ok.state.statusCode, 200)
  assert.equal(configStore.get().alerts.rules.length, 1)
  assert.equal(configStore.get().alerts.rules[0].threshold, 90)
})

test('面板加出口：地址写进配置，回显是掩码', async () => {
  const { api, configStore } = setup()
  const res = await call(api, {
    method: 'POST',
    url: '/api/container-manager/alerts/webhooks/add',
    headers: { ...WRITE_HEADERS, 'x-cm-principal': 'panel' },
    body: { id: 'h1', name: 'ntfy', url: 'https://ntfy.sh/super-secret-topic', kind: 'ntfy', enabled: true },
  })
  assert.equal(res.state.statusCode, 200)
  assert.equal(configStore.get().alerts.webhooks.length, 1)
  const shown = res.json().data.webhooks[0].url
  assert.ok(!shown.includes('super-secret-topic'))
  assert.match(shown, /ntfy\.sh/)
})
