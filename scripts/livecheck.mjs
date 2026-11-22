#!/usr/bin/env node
/**
 * 只读联调：把 api.handle 挂到一个临时 HTTP 端口，用真 registry 跑一遍。
 * 只发 GET，不启动/停止/删除任何容器。
 *
 *   node scripts/livecheck.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-livecheck-'))

const { PREFIX, createApi } = await import('../lib/api.js')
const { createActions } = await import('../lib/actions.js')
const { createAudit } = await import('../lib/audit.js')
const { createConfigStore, paths } = await import('../lib/config.js')
const { createNodeRegistry } = await import('../lib/nodes.js')
const { createPendingStore } = await import('../lib/pending.js')

const configStore = createConfigStore({})
const dataPaths = paths()
const audit = createAudit({ file: dataPaths.audit, keepLines: 200 })
const pendings = createPendingStore({ file: dataPaths.pending, ttlSeconds: 600 })
const registry = createNodeRegistry(configStore)
const actions = createActions({ registry, configStore, pendings, audit })
const api = createApi({
  registry,
  configStore,
  pendings,
  actions,
  audit,
  verify: () => ({ ok: true }),
  helperHint: () => 'sudo bash helper/install-helper.sh',
  info: { name: 'dsh-container-manager', version: createRequire(import.meta.url)('../package.json').version },
})

const server = createServer((req, res) => {
  Promise.resolve(api.handle(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(error && error.message) } }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = 'http://127.0.0.1:' + address.port + PREFIX

async function get(path) {
  const response = await fetch(base + path)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { status: response.status, body }
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label + (detail ? ' — ' + detail : ''))
  } else {
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
    failures.push(label)
  }
}

console.log('临时端口:', address.port, '\n')

console.log('[health]')
const health = await get('/health')
check('GET /health 返回 200', health.status === 200, 'HTTP ' + health.status)
check('health 带版本', Boolean(health.body?.data?.version), health.body?.data?.version)

console.log('\n[state]')
const state = await get('/state')
check('GET /state 返回 200', state.status === 200, 'HTTP ' + state.status)
const snapshot = state.body?.data
check('拿到节点列表', Array.isArray(snapshot?.nodes), (snapshot?.nodes ?? []).length + ' 个节点')
for (const node of snapshot?.nodes ?? []) {
  console.log('       node: ' + node.id + ' 可用=' + node.available + (node.reason ? ' 原因=' + node.reason : '') + (node.code ? ' 代码=' + node.code : ''))
}
check('读到容器（至少现有的那个）', Array.isArray(snapshot?.containers), (snapshot?.containers ?? []).length + ' 个容器')
for (const container of snapshot?.containers ?? []) {
  console.log('       container: ' + container.name + ' [' + container.state + '] ' + container.image)
}
check('读到网络', Array.isArray(snapshot?.networks), (snapshot?.networks ?? []).length + ' 个网络')
for (const network of snapshot?.networks ?? []) {
  console.log('       network: ' + network.name + ' ' + (network.subnet ?? '') + ' ' + (network.driver ?? ''))
}
// helper 装没装都要有明确状态：装了 → 可用且带 lxc 版本；没装 → HELPER_DOWN + 安装命令。
const lxcNode = (snapshot?.nodes ?? []).find(node => node.id === 'local-lxc')
if (lxcNode && lxcNode.available) {
  check('LXC 节点可用并报出 lxc 版本', Boolean(lxcNode.detail?.version), 'lxc ' + (lxcNode.detail?.version ?? '?'))
} else {
  check('LXC 不可用时报 HELPER_DOWN 而不是崩', lxcNode?.code === 'HELPER_DOWN', String(lxcNode?.code ?? 'missing node'))
}

const first = (snapshot?.containers ?? [])[0]
if (first) {
  console.log('\n[container detail]')
  const detail = await get('/containers/' + encodeURIComponent(first.nodeId) + '/' + encodeURIComponent(first.name))
  check('GET 容器详情', detail.status === 200, 'HTTP ' + detail.status + ' name=' + detail.body?.data?.name)
  const logs = await get('/containers/' + encodeURIComponent(first.nodeId) + '/' + encodeURIComponent(first.name) + '/logs?tail=5')
  check('GET 容器日志', logs.status === 200 && typeof logs.body?.data?.text === 'string', 'HTTP ' + logs.status)
}

console.log('\n[pending]')
const pending = await get('/pending')
check('GET /pending 返回列表', pending.status === 200 && Array.isArray(pending.body?.data), 'HTTP ' + pending.status + ' ' + (Array.isArray(pending.body?.data) ? pending.body.data.length : '?') + ' 条')

console.log('\n[nodes/probe]')
const nodes = await get('/nodes')
check('GET /nodes 返回 200', nodes.status === 200, 'HTTP ' + nodes.status)

const config = await get('/config')
check('GET /config 返回 200', config.status === 200, 'HTTP ' + config.status)

server.close()
await new Promise(resolve => server.close(resolve))

console.log('')
if (failures.length > 0) {
  console.error('失败 ' + failures.length + ' 项：' + failures.join(' / '))
  process.exit(1)
}
console.log('只读联调全部通过。')
