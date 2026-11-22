#!/usr/bin/env node
/**
 * 写操作验收：用一个临时容器把「创建 → 详情 → 日志 → 删除挂起 → 面板确认 → 真删掉」走一遍。
 *
 * 只碰它自己建的 cm-smoke-<随机>，结束无论如何都清理。
 * 业务容器（catstar-next-smokeping 之类）一律不动。
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-writetest-'))

const { PREFIX, createApi } = await import('../lib/api.js')
const { createActions } = await import('../lib/actions.js')
const { createAudit } = await import('../lib/audit.js')
const { createConfigStore, paths } = await import('../lib/config.js')
const { createNodeRegistry } = await import('../lib/nodes.js')
const { createPendingStore } = await import('../lib/pending.js')

const run = promisify(execFile)
const IMAGE = process.env.CM_TEST_IMAGE ?? 'docker.io/library/eclipse-temurin:25-jre-noble'
const NAME = 'cm-smoke-' + Math.random().toString(16).slice(2, 8)
const NODE = 'local-podman'

const configStore = createConfigStore({})
const dataPaths = paths()
const audit = createAudit({ file: dataPaths.audit, keepLines: 500 })
const pendings = createPendingStore({ file: dataPaths.pending, ttlSeconds: 600 })
const helperHint = () => 'sudo bash helper/install-helper.sh'
const registry = createNodeRegistry(configStore, { helperHint })
const actions = createActions({ registry, configStore, pendings, audit })
const api = createApi({
  registry,
  configStore,
  pendings,
  actions,
  audit,
  verify: () => ({ ok: true }),
  helperHint,
  info: { name: 'dsh-container-manager', version: createRequire(import.meta.url)('../package.json').version },
})

const server = createServer((req, res) => {
  Promise.resolve(api.handle(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(error && error.message) } }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + PREFIX

async function request(path, { method = 'GET', headers = {}, body = null } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json', 'x-cm-request': '1', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 300) } }
  return { status: response.status, body: parsed }
}

const failures = []
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label + (detail ? ' — ' + detail : ''))
  else {
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
    failures.push(label)
  }
}

async function cleanup() {
  try {
    await run('podman', ['rm', '-f', NAME], { timeout: 30000 })
  } catch {
    // 已经不在了
  }
}

try {
  console.log('临时容器:', NAME, ' 镜像:', IMAGE, '\n')

  console.log('[create via panel API]')
  // 走面板那条路（POST /containers），而不是直接调 registry —— 要验的是用户点按钮时发生的事。
  const createResult = await request('/containers', {
    method: 'POST',
    body: {
      node: NODE,
      image: IMAGE,
      name: NAME,
      network: 'none',
      command: ['sleep', '300'],
      env: { CM_SMOKE: '1' },
      restart: 'no',
    },
  })
  check(
    'POST /containers 创建成功',
    createResult.status === 200 && createResult.body?.data?.created?.name === NAME,
    'HTTP ' + createResult.status + ' ' + JSON.stringify(createResult.body?.data ?? createResult.body?.error).slice(0, 200),
  )

  let state = 'unknown'
  for (let index = 0; index < 20; index += 1) {
    const list = await registry.listContainers?.(NODE)
    void list
    const snapshot = await request('/state')
    const found = (snapshot.body?.data?.containers ?? []).find(item => item.name === NAME)
    state = found?.state ?? 'missing'
    if (state === 'running' || state === 'exited') break
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  check('新容器出现在 /state 且跑起来了', state === 'running', '状态=' + state)

  console.log('\n[read]')
  const detail = await request('/containers/' + NODE + '/' + NAME)
  check('详情可读', detail.status === 200 && detail.body?.data?.name === NAME, 'HTTP ' + detail.status)
  const envKeys = detail.body?.data?.envKeys ?? []
  check('环境变量写进去了（只回键名）', envKeys.includes('CM_SMOKE'), 'envKeys=' + JSON.stringify(envKeys))
  check('端口/网络没被乱改', (detail.body?.data?.ports ?? []).length === 0, JSON.stringify(detail.body?.data?.ports))
  const logs = await request('/containers/' + NODE + '/' + NAME + '/logs?tail=10')
  check('日志可读', logs.status === 200 && typeof logs.body?.data?.text === 'string', 'HTTP ' + logs.status)

  console.log('\n[limits]')
  const limits = await request('/containers/' + NODE + '/' + NAME + '/limits', {
    method: 'POST',
    body: { memory: '256m' },
  })
  if (limits.status === 200) {
    check('改内存限制并确认生效', limits.body?.data?.applied?.memory === '256m', JSON.stringify(limits.body?.data?.applied))
  } else if (/内存上限没变/.test(JSON.stringify(limits.body?.error ?? {}))) {
    // 这不是插件的问题，是环境限制：rootless podman 4.3.1 不写 cgroup。
    // 如实记一条 note，不当失败 —— 假成功才是失败。
    console.log('  note ' + limits.body.error.message)
  } else {
    check('改内存限制', false, 'HTTP ' + limits.status + ' ' + JSON.stringify(limits.body?.error))
  }

  console.log('\n[delete → pending]')
  const del = await request('/actions', {
    method: 'POST',
    headers: { 'x-cm-principal': 'panel' },
    body: { node: NODE, ref: NAME, action: 'delete' },
  })
  check('删除返回 pending', del.body?.data?.status === 'pending', JSON.stringify(del.body?.data).slice(0, 160))
  const token = del.body?.data?.token
  const stillThere = (await request('/state')).body?.data?.containers?.some(item => item.name === NAME)
  check('确认前容器还在（没有偷跑）', stillThere === true)

  const pendingList = await request('/pending')
  check('待确认队列里能看到它', (pendingList.body?.data ?? []).some(item => item.token === token), (pendingList.body?.data ?? []).length + ' 条')

  console.log('\n[confirm]')
  const badConfirm = await request('/actions/confirm', { method: 'POST', body: { token } })
  check('没有 panel principal 的确认被拒', badConfirm.status === 403, 'HTTP ' + badConfirm.status)

  const confirmed = await request('/actions/confirm', {
    method: 'POST',
    headers: { 'x-cm-principal': 'panel' },
    body: { token },
  })
  check('面板确认后执行成功', confirmed.body?.data?.status === 'done', JSON.stringify(confirmed.body?.data).slice(0, 200))

  await new Promise(resolve => setTimeout(resolve, 800))
  const gone = (await request('/state')).body?.data?.containers?.some(item => item.name === NAME)
  check('容器真的被删掉了', gone === false)

  const again = await request('/actions/confirm', {
    method: 'POST',
    headers: { 'x-cm-principal': 'panel' },
    body: { token },
  })
  check('同一个 token 不能确认第二次', again.status >= 400, 'HTTP ' + again.status)

  console.log('\n[audit]')
  const auditText = readFileSync(dataPaths.audit, 'utf8')
  check('审计里留下创建与删除记录', auditText.includes(NAME) && auditText.includes('confirm'), auditText.split('\n').filter(Boolean).length + ' 行')
} finally {
  await cleanup()
  await new Promise(resolve => server.close(resolve))
}

console.log('')
if (failures.length > 0) {
  console.error('失败 ' + failures.length + ' 项：' + failures.join(' / '))
  process.exit(1)
}
console.log('写操作验收全部通过，临时容器已清理。')
