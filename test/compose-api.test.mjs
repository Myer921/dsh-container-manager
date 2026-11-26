/** compose 接口层的集成测试：真的走 api.handle，不 mock 路由。 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PREFIX, createApi } from '../lib/api.js'
import { createActions } from '../lib/actions.js'
import { createComposeService } from '../lib/compose/service.js'

const SAMPLE = [
  '# 顶部注释',
  'services:',
  '  web:',
  '    image: alpine',
  '    ports:',
  '      - "8080:80"',
  '  db:',
  '    image: alpine',
].join('\n')

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'cm-api-'))
}

function makeProject(root, name, text) {
  const dir = join(root, 'podman', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'docker-compose.yml'), text)
  return dir
}

function makeConfigStore(root) {
  const state = {
    version: 1,
    nodes: [{ id: 'local-podman', kind: 'podman', transport: 'local' }],
    confirmRequired: true,
    confirmTtlSeconds: 600,
    allowLogs: true,
    logTailDefault: 200,
    logTailMax: 2000,
    auditKeepLines: 1000,
    compose: { root, binary: '/nonexistent/podman-compose', version: '1.6.0', installedAt: '' },
  }
  return {
    get: () => state,
    updateCompose(patch) {
      state.compose = { ...state.compose, ...patch }
      return state.compose
    },
    replace(next) {
      Object.assign(state, next)
      return state
    },
  }
}

function makeRegistry(containers = []) {
  const deleted = []
  return {
    containersOfKind: async () => ({ containers, failures: [] }),
    firstOfKind: () => ({ id: 'local-podman', kind: 'podman' }),
    act: async (nodeId, ref, action) => {
      deleted.push({ nodeId, ref, action })
      return { action, ref }
    },
    deleted,
  }
}

function makeHarness(root, { containers = [] } = {}) {
  const configStore = makeConfigStore(root)
  const audit = { append() {}, read: () => [] }
  const pendings = {
    begun: [],
    begin(record) {
      const stored = { ...record, token: 'tok-' + (this.begun.length + 1) }
      this.begun.push(stored)
      return stored
    },
    list: () => [],
    take() { return null },
    get() { return null },
  }
  const registry = makeRegistry(containers)
  const compose = createComposeService({ configStore, registry, audit })
  const actions = createActions({ registry, configStore, pendings, audit, compose })
  const api = createApi({
    registry,
    configStore,
    pendings,
    actions,
    audit,
    verify: () => ({ ok: true, principal: { kind: 'owner' } }),
    helperHint: () => 'hint',
    compose,
  })
  return { api, configStore, pendings, registry, compose, actions }
}

function makeReq({ method = 'GET', path, body = null }) {
  const readable = new Readable({ read() {} })
  if (body !== null) readable.push(typeof body === 'string' ? body : JSON.stringify(body))
  readable.push(null)
  readable.method = method
  readable.url = PREFIX + path
  readable.headers = {
    host: '127.0.0.1:3085',
    'content-type': 'application/json',
    'x-cm-request': '1',
  }
  return readable
}

async function call(api, { method = 'GET', path, body = null }) {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
  }
  await api.handle(makeReq({ method, path, body }), res)
  const text = res.chunks.join('')
  return { status: res.statusCode, text, json: text ? JSON.parse(text) : null }
}

function withRoot(name, text) {
  const root = tempRoot()
  if (name) makeProject(root, name, text ?? SAMPLE)
  return root
}

test('GET /compose/projects：拿到项目与状态计数', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const { status, json } = await call(api, { path: '/compose/projects' })
    assert.equal(status, 200)
    assert.equal(json.data.projects.length, 1)
    assert.equal(json.data.projects[0].name, 'demo')
    assert.equal(json.data.projects[0].services.length, 2)
    assert.equal(json.data.projects[0].counts.missing, 2)
    assert.equal(json.data.layout.podmanRoot, join(root, 'podman'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GET /compose/projects：没配根目录时给 400 和一句能照做的 hint', async () => {
  const { api } = makeHarness('')
  const { status, json } = await call(api, { path: '/compose/projects' })
  assert.equal(status, 400)
  assert.ok(json.error.hint.includes('/opt/dsh-container'))
})

test('GET /compose/projects/:name：详情带 runtime 与备份列表', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const { status, json } = await call(api, { path: '/compose/projects/demo' })
    assert.equal(status, 200)
    assert.equal(json.data.name, 'demo')
    assert.equal(json.data.runtime.ready, false)
    assert.deepEqual(json.data.backups, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GET /compose/projects/:name/yaml：带回原文', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const { json } = await call(api, { path: '/compose/projects/demo/yaml' })
    assert.ok(json.data.text.includes('顶部注释'))
    assert.equal(json.data.fileName, 'docker-compose.yml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST services/:svc/ports：写回文件并返回新端口', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const { status, json } = await call(api, {
      method: 'POST',
      path: '/compose/projects/demo/services/web/ports',
      body: { ports: ['9090:80', '8443:443'] },
    })
    assert.equal(status, 200)
    assert.deepEqual(json.data.parsedPorts.map(item => item.hostPort), [9090, 8443])
    const text = readFileSync(join(root, 'podman', 'demo', 'docker-compose.yml'), 'utf8')
    assert.ok(text.includes('9090:80'))
    assert.ok(existsSync(json.data.backup))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST yaml：坏内容给 400，文件不动', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const file = join(root, 'podman', 'demo', 'docker-compose.yml')
    const before = readFileSync(file, 'utf8')
    const { status, json } = await call(api, {
      method: 'POST',
      path: '/compose/projects/demo/yaml',
      body: { text: 'services: [unclosed' },
    })
    assert.equal(status, 400)
    assert.ok(json.error.message.includes('行'))
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST down：挂起而不是直接删，摘要把风险说清', async () => {
  const root = withRoot('demo')
  try {
    const { api, pendings } = makeHarness(root)
    const { status, json } = await call(api, { method: 'POST', path: '/compose/projects/demo/down' })
    assert.equal(status, 200)
    assert.equal(json.data.status, 'pending')
    assert.equal(pendings.begun.length, 1)
    assert.equal(pendings.begun[0].kind, 'compose.down')
    assert.ok(pendings.begun[0].summary.includes('bind mount 的宿主数据保留'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST up：运行时没装就停在 runtime 阶段，不假装成功', async () => {
  const root = withRoot('demo')
  try {
    const { api } = makeHarness(root)
    const { status, json } = await call(api, { method: 'POST', path: '/compose/projects/demo/up' })
    assert.equal(status, 200)
    assert.equal(json.data.ok, false)
    assert.equal(json.data.stage, 'runtime')
    assert.ok(json.data.hint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GET /compose/runtime：没装时给出 false 与安装提示', async () => {
  const root = withRoot(null)
  try {
    const { api } = makeHarness(root)
    const { status, json } = await call(api, { path: '/compose/runtime' })
    assert.equal(status, 200)
    assert.equal(json.data.ready, false)
    assert.equal(json.data.version, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /config：只带 compose.root 时走增量，节点与其余设置不丢', async () => {
  const root = withRoot(null)
  const target = join(root, 'base')
  try {
    const { api, configStore } = makeHarness(root)
    const { status, json } = await call(api, { method: 'POST', path: '/config', body: { compose: { root: target } } })
    assert.equal(status, 200)
    assert.equal(json.data.compose.root, target)
    assert.equal(configStore.get().nodes.length, 1)
    assert.equal(configStore.get().confirmRequired, true)
    assert.ok(json.data.layout)
    assert.ok(existsSync(join(target, 'podman')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GET /compose/projects：孤儿容器单独列出来，不混进项目', async () => {
  const root = withRoot('demo')
  try {
    const orphans = [
      { id: 'x', name: 'catstar-next-smokeping', state: 'running', running: true, image: 'local/smokeping', labels: {} },
    ]
    const { api } = makeHarness(root, { containers: orphans })
    const { json } = await call(api, { path: '/compose/projects' })
    assert.deepEqual(json.data.orphans.map(item => item.name), ['catstar-next-smokeping'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
