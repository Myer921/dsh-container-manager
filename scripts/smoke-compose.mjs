/**
 * compose 端到端冒烟：起一个真实 HTTP 服务，打真实接口，用真实 podman 跑起来。
 *
 * 用法：
 *   DSH_HOME=/tmp/cm-smoke node scripts/smoke-compose.mjs            # 全跑（含装 venv）
 *   DSH_HOME=/tmp/cm-smoke node scripts/smoke-compose.mjs --skip-install
 *
 * 一切都在 DSH_HOME 下面，不碰 ~/.dsh-next 的真实配置。
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActions } from '../lib/actions.js'
import { createApi } from '../lib/api.js'
import { createAudit } from '../lib/audit.js'
import { createComposeService } from '../lib/compose/service.js'
import { createConfigStore, paths } from '../lib/config.js'
import { createNodeRegistry } from '../lib/nodes.js'
import { createPendingStore } from '../lib/pending.js'

const skipInstall = process.argv.includes('--skip-install')
const home = process.env.DSH_HOME
if (!home) {
  console.error('先设 DSH_HOME（例如 DSH_HOME=/tmp/cm-smoke）')
  process.exit(2)
}

const root = join(home, 'base')
const demoDir = join(root, 'podman', 'cmsmoke')
const hostPort = 20000 + Math.floor(Math.random() * 20000)
const secondPort = hostPort + 1
const projectName = 'cmsmoke'

function step(name) {
  console.log('\n=== ' + name + ' ===')
}

function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message)
}

const configStore = createConfigStore({})
configStore.updateCompose({ root })
const audit = createAudit({ file: paths().audit, keepLines: 2000 })
const pendings = createPendingStore({ file: paths().pending, ttlSeconds: 600 })
const helperHint = () => 'hint'
const registry = createNodeRegistry(configStore, { helperHint, lxc: { helperHint } })
const compose = createComposeService({ configStore, registry, audit })
const actions = createActions({ registry, configStore, pendings, audit, compose })
const api = createApi({
  registry,
  configStore,
  pendings,
  actions,
  audit,
  verify: () => ({ ok: true }),
  helperHint,
  compose,
})

const server = createServer((req, res) => {
  Promise.resolve(api.handle(req, res)).catch((error) => {
    console.error('接口异常：', error)
    try { res.statusCode = 500; res.end('{}') } catch { /* 已结束 */ }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port + '/api/container-manager'
console.log('服务起来了：' + origin)
console.log('DSH_HOME=' + home + '  项目根=' + root)

async function call(method, path, body) {
  const response = await fetch(origin + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-cm-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text }
}

/** 只测 TCP 能不能连上：端口发布成立与否，握手就能说明。 */
function tryConnect(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

async function probe(port) {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    if (await tryConnect(port)) return { ok: true, status: null }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { ok: false }
}

/** 往端口写一行，用来证明数据真的进了容器（日志里能看到）。 */
function poke(port, text) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.write(text + '\n', () => {
        setTimeout(() => { socket.destroy(); resolve(true) }, 300)
      })
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false) })
  })
}

function cleanup() {
  try { rmSync(demoDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

let failed = false
try {
  step('1. 配根目录（应自动建 podman/ 与 lxc/）')
  const configured = await call('POST', '/config', { compose: { root } })
  assert(configured.status === 200, 'POST /config 返回 ' + configured.status)
  assert(configured.json.data.compose.root === root, '根目录没写进去')
  console.log('layout:', JSON.stringify(configured.json.data.layout))

  step('2. 空目录：项目列表应为空')
  const empty = await call('GET', '/compose/projects')
  assert(empty.status === 200, 'GET /compose/projects 返回 ' + empty.status)
  assert(empty.json.data.projects.length === 0, '空目录居然有项目')
  console.log('projects=0，orphans=' + empty.json.data.orphans.length)

  step('3. 运行时状态')
  const runtime = await call('GET', '/compose/runtime')
  console.log('ready=' + runtime.json.data.ready + ' version=' + runtime.json.data.version + ' binary=' + runtime.json.data.binary)
  if (!runtime.json.data.ready) {
    if (skipInstall) throw new Error('跳过安装但运行时还没就绪')
    console.log('开始装 venv（可能几分钟）…')
    const install = await call('POST', '/compose/runtime/install')
    assert(install.status === 200, '安装接口返回 ' + install.status)
    console.log('安装结果：ok=' + install.json.data.ok + ' version=' + (install.json.data.version || ''))
    if (!install.json.data.ok) {
      console.log('安装日志尾部：\n' + String(install.json.data.log || '').split('\n').slice(-12).join('\n'))
      throw new Error('运行时装不上')
    }
  }

  step('4. 写一个 compose 项目（alpine + nc 监听 ' + hostPort + '）')
  mkdirSync(demoDir, { recursive: true })
  const composeText = [
    '# 冒烟用，跑完就删',
    'services:',
    '  web:',
    '    image: docker.io/library/alpine:latest',
    '    command: ["sh", "-c", "while true; do nc -l -p 80; done"]',
    '    ports:',
    '      - "' + hostPort + ':80"',
    '    environment:',
    '      SMOKE: "1"',
  ].join('\n')
  writeFileSync(join(demoDir, 'compose.yaml'), composeText + '\n')
  const listed = await call('GET', '/compose/projects')
  assert(listed.json.data.projects.length === 1, '项目没被发现')
  const project = listed.json.data.projects[0]
  assert(project.name === projectName, '项目名不对：' + project.name)
  assert(project.services.length === 1, '服务数不对')
  assert(project.counts.missing === 1, '还没启动但状态不是 missing')
  console.log('发现项目 ' + project.name + '：' + project.services[0].name + ' ' + project.services[0].image)

  step('5. 端口预检 + up')
  const up = await call('POST', '/compose/projects/' + projectName + '/up')
  console.log('up ok=' + up.json.data.ok + ' stage=' + up.json.data.stage)
  if (!up.json.data.ok) {
    console.log('stderr:\n' + String(up.json.data.stderr || '').slice(-2000))
    throw new Error('up 失败')
  }
  const reachable = await probe(hostPort)
  assert(reachable.ok, '宿主端口 ' + hostPort + ' 打不通')
  console.log('端口 ' + hostPort + ' 能连上')
  await poke(hostPort, 'ping-from-host-' + hostPort)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const seen = await call('GET', '/compose/projects/' + projectName + '/logs?tail=40&service=web')
  assert(String(seen.json.data.text || '').includes('ping-from-host-' + hostPort), '数据没进容器（日志里没有探针字符串）')
  console.log('数据真的进了容器：日志里有 ping-from-host-' + hostPort)

  step('6. 改端口（写回 compose）')
  const edited = await call('POST', '/compose/projects/' + projectName + '/services/web/ports', {
    ports: [secondPort + ':80'],
    rebuild: true,
  })
  assert(edited.status === 200, '改端口返回 ' + edited.status)
  assert(edited.json.data.rebuild && edited.json.data.rebuild.ok, 'rebuild 没成功')
  const reachable2 = await probe(secondPort)
  assert(reachable2.ok, '新端口 ' + secondPort + ' 打不通')
  console.log('新端口 ' + secondPort + ' 也通了')

  step('7. 日志（第 6 步重建过容器，这里是新的那个）')
  await poke(secondPort, 'ping-after-rebuild')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const logs = await call('GET', '/compose/projects/' + projectName + '/logs?tail=20')
  assert(logs.status === 200, '日志接口返回 ' + logs.status)
  assert(String(logs.json.data.text || '').includes('ping-after-rebuild'), '日志里没有重建后的探针串')
  console.log('日志里有 ping-after-rebuild（共 ' + String(logs.json.data.text || '').length + ' 字）')

  step('8. YAML 原文与坏 YAML 拒绝')
  const yaml = await call('GET', '/compose/projects/' + projectName + '/yaml')
  assert(yaml.json.data.text.includes('SMOKE'), 'YAML 里没读到环境变量')
  const bad = await call('POST', '/compose/projects/' + projectName + '/yaml', { text: 'services: [oops' })
  assert(bad.status === 400, '坏 YAML 应给 400，实际 ' + bad.status)
  console.log('坏 YAML 被拒：' + bad.json.error.message)

  step('9. down 挂起 → 确认 → 容器消失')
  const down = await call('POST', '/compose/projects/' + projectName + '/down')
  assert(down.json.data.status === 'pending', 'down 没挂起')
  const token = down.json.data.token
  console.log('挂起：' + down.json.data.message)
  const confirmed = await actions.confirm(token, { principal: 'panel' })
  console.log('确认结果：ok=' + confirmed.result.ok)
  const after = await call('GET', '/compose/projects')
  assert(after.json.data.projects[0].counts.running === 0, 'down 之后还在跑')
  console.log('容器已清掉，counts=' + JSON.stringify(after.json.data.projects[0].counts))

  console.log('\n全部通过。')
} catch (error) {
  failed = true
  console.error('\n失败：' + (error && error.stack ? error.stack : String(error)))
} finally {
  cleanup()
  try { await call('POST', '/compose/projects/' + projectName + '/down') } catch { /* 忽略 */ }
  server.close()
}

process.exit(failed ? 1 : 0)
