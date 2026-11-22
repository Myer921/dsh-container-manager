/**
 * 终端链路冒烟：真起一个容器，真走 WebSocket，真在容器里跑一条命令。
 *
 * 用法：DSH_HOME=/tmp/cm-smoke node scripts/smoke-terminal.mjs
 */

import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createApi } from '../lib/api.js'
import { createActions } from '../lib/actions.js'
import { createAudit } from '../lib/audit.js'
import { createComposeService } from '../lib/compose/service.js'
import { createConfigStore, paths } from '../lib/config.js'
import { createNodeRegistry } from '../lib/nodes.js'
import { createPendingStore } from '../lib/pending.js'
import { createTerminalService } from '../lib/terminal.js'

const PROFILE_ROOT = process.env.CM_PROFILE_ROOT || join(homedir(), '.dsh-next/profiles/web')
const requireProfile = createRequire(join(PROFILE_ROOT, 'package.json'))
const WebSocket = requireProfile('ws')

const home = process.env.DSH_HOME
if (!home) {
  console.error('先设 DSH_HOME')
  process.exit(2)
}

const NAME = 'cm-term-test'
const ROOT = join(home, 'base')

const configStore = createConfigStore({})
configStore.updateCompose({ root: ROOT })
const audit = createAudit({ file: paths().audit, keepLines: 1000 })
const pendings = createPendingStore({ file: paths().pending, ttlSeconds: 600 })
const helperHint = () => 'hint'
const registry = createNodeRegistry(configStore, { helperHint, lxc: { helperHint } })
const compose = createComposeService({ configStore, registry, audit })
const actions = createActions({ registry, configStore, pendings, audit, compose })
const verify = () => ({ ok: true })
const api = createApi({ registry, configStore, pendings, actions, audit, verify, helperHint, compose })
const terminal = createTerminalService({ registry, verify })

const server = createServer((req, res) => {
  Promise.resolve(api.handle(req, res)).catch((error) => {
    console.error('接口异常', error)
    try { res.statusCode = 500; res.end('{}') } catch { /* 已结束 */ }
  })
})
server.on('upgrade', (req, socket, head) => terminal.handleUpgrade(req, socket, head))

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port + '/api/container-manager'
console.log('服务：' + base)

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-cm-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: text ? JSON.parse(text) : null }
}

function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message)
}

async function sh(command) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('bash', ['-lc', command], { timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

let failed = false
try {
  console.log('\n=== 1. 静态资源 ===')
  const xterm = await fetch(base + '/static/xterm/xterm.js')
  assert(xterm.status === 200, 'xterm.js 不是 200，是 ' + xterm.status)
  const size = (await xterm.text()).length
  assert(size > 100000, 'xterm.js 太小了：' + size)
  console.log('xterm.js 200，' + size + ' 字节')
  const css = await fetch(base + '/static/xterm/xterm.css')
  assert(css.status === 200, 'xterm.css 不是 200')
  const traverse = await fetch(base + '/static/..%2f..%2fpackage.json')
  assert(traverse.status === 404, '路径穿越没被挡住，返回 ' + traverse.status)
  console.log('xterm.css 200；穿越请求被挡（404）')

  console.log('\n=== 2. 起一个临时容器 ===')
  const created = await call('POST', '/containers', {
    node: 'local-podman',
    kind: 'podman',
    name: NAME,
    image: 'docker.io/library/alpine:latest',
    command: ['sh', '-c', 'sleep 600'],
    label: 'dsh-cm-smoke=1',
  })
  assert(created.status === 200, '创建容器返回 ' + created.status + '：' + created.text.slice(0, 300))
  console.log('已创建 ' + NAME)

  console.log('\n=== 3. WebSocket 终端 ===')
  const collected = []
  await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/api/container-manager/terminal?node=local-podman&ref=' + NAME)
    const timer = setTimeout(() => { try { socket.close() } catch {} ; reject(new Error('终端超时：没等到 HELLO-CM')) }, 40000)
    socket.on('open', () => {
      console.log('WS 已连上，等 ready…')
    })
    socket.on('message', (raw) => {
      let frame = null
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.type === 'ready') {
        console.log('收到 ready（' + frame.ref + '），发命令')
        socket.send(JSON.stringify({ type: 'input', data: 'echo HELLO-CM-' + frame.ref + '\n' }))
        return
      }
      if (frame.type === 'error') {
        clearTimeout(timer)
        reject(new Error('终端报错：' + frame.message))
        return
      }
      if (frame.type === 'data') {
        collected.push(frame.data)
        if (collected.join('').includes('HELLO-CM-' + NAME)) {
          clearTimeout(timer)
          socket.close()
          resolve()
        }
      }
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
  const transcript = collected.join('')
  assert(transcript.includes('HELLO-CM-' + NAME), '终端输出里没有命令结果')
  console.log('容器里回显成功，收到 ' + transcript.length + ' 字')

  console.log('\n=== 4. 清理 ===')
  const removed = await call('POST', '/actions', { node: 'local-podman', ref: NAME, action: 'delete' })
  const token = removed.json && removed.json.data ? removed.json.data.token : null
  if (token) {
    await actions.confirm(token, { principal: 'panel' })
    console.log('容器已删（走确认通道）')
  } else {
    console.log('删除没有挂起：' + removed.text.slice(0, 200))
  }

  console.log('\n全部通过。')
} catch (error) {
  failed = true
  console.error('\n失败：' + (error && error.stack ? error.stack : String(error)))
} finally {
  await sh('podman rm -f ' + NAME + ' 2>/dev/null || true')
  server.close()
}

process.exit(failed ? 1 : 0)
