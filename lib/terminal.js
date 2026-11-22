/**
 * 终端：把容器里的交互 shell 搬到面板上。
 *
 * 走 WebSocket；PTY 靠 util-linux 的 script 造出来（podman exec -it 在非 tty 下会报
 * "not a tty"，套一层 script 就有了 /dev/pts/N，实测可用）。
 *
 * 已知限制：script 不支持动态改窗口大小，所以 resize 只记录不发。
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { createConnection, handshake } from './ws.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
const SAFE_SHELL = /^(sh|bash|ash|zsh|dash)$/
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * WebSocket 的同源校验。
 *
 * 为什么不能只认 127.0.0.1：面板常常挂在反代后面（本机是 nginx 192.0.2.10:3086
 * → 127.0.0.1:3085），浏览器发来的 Host 是外部地址，硬编码白名单会把这种正常访问
 * 一律 403 —— 表现就是「WebSocket 连不上」，而实际上 nginx 转发得好好的。
 *
 * 所以：本机直连仍走老白名单；其它情况要求 Origin 与 Host 同源（比较主机名，
 * 忽略端口，因为反代内外端口本来就不一样）。同源校验才是这里真正的安全语义。
 */
export function originAllowed(req) {
  const hostHeader = String(req?.headers?.host || '').toLowerCase()
  const hostname = hostHeader.replace(/:\d+$/, '')
  const origin = req?.headers?.origin

  if (ALLOWED_HOSTS.has(hostname)) {
    if (!origin) return true
    try {
      return ALLOWED_HOSTS.has(new URL(String(origin)).hostname)
    } catch {
      return false
    }
  }

  if (!origin) return false
  try {
    return new URL(String(origin)).hostname.toLowerCase() === hostname
  } catch {
    return false
  }
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

export function createTerminalService({ registry, verify = null }) {
  function reject(socket, status, reason) {
    try {
      socket.write('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\n\r\n')
      socket.end()
    } catch {
      // 连接已经断了
    }
  }


  function handleUpgrade(req, socket, head) {
    // 一个坏请求不该把 DSH 主进程带下水 —— 这里所有意外都要自己吞掉。
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      // 先走和 REST 同一套认证；再过一遍本机来源检查（双保险）。
      if (typeof verify === 'function') {
        const verdict = verify(req)
        if (!verdict || verdict.ok !== true) {
          return reject(socket, verdict && verdict.status ? verdict.status : 401, 'Unauthorized')
        }
      }
      if (!originAllowed(req)) return reject(socket, 403, 'Forbidden')
      const nodeId = String(url.searchParams.get('node') || '')
      const ref = String(url.searchParams.get('ref') || '')
      const shellParam = String(url.searchParams.get('shell') || '')
      const shell = SAFE_SHELL.test(shellParam) ? shellParam : 'sh'
      if (!ref || !SAFE_NAME.test(ref)) return reject(socket, 400, 'Bad Request')
      if (!handshake(req, socket)) return reject(socket, 400, 'Bad Request')
      void start({ socket, nodeId, ref, shell })
    } catch {
      reject(socket, 400, 'Bad Request')
    }
  }

  async function start({ socket, nodeId, ref, shell }) {
    let child = null
    const decoder = new StringDecoder('utf8')

    function kill() {
      if (!child) return
      try { child.kill('SIGHUP') } catch { /* 已经退了 */ }
      child = null
    }

    const conn = createConnection(socket, {
      onMessage(text) {
        let frame = null
        try { frame = JSON.parse(text) } catch { return }
        if (!frame || typeof frame.type !== 'string') return
        if (frame.type === 'input' && typeof frame.data === 'string' && child) {
          try { child.stdin.write(frame.data) } catch { /* 管道关了 */ }
          return
        }
        if (frame.type === 'resize') {
          // script 改不了窗口大小，记下来但不假装做到
          return
        }
        if (frame.type === 'ping') conn.send(JSON.stringify({ type: 'pong', at: Date.now() }))
      },
      onClose() {
        kill()
      },
    })

    let node = null
    try {
      node = registry.find(nodeId || 'local-podman')
    } catch (error) {
      conn.send(JSON.stringify({ type: 'error', message: error.message }))
      conn.close()
      return
    }

    // 容器存不存在先说清楚，别让用户对着黑屏猜。
    try {
      await registry.inspect(node.id, ref)
    } catch (error) {
      conn.send(JSON.stringify({ type: 'error', message: '打不开终端：' + error.message }))
      conn.close()
      return
    }

    const inner = node.kind === 'lxc'
      ? 'sudo -n lxc-attach -n ' + shellQuote(ref) + ' -- ' + shell
      : 'podman exec -it ' + shellQuote(ref) + ' ' + shell

    try {
      child = spawn('script', ['-qfec', inner, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (error) {
      conn.send(JSON.stringify({ type: 'error', message: '起不了终端：' + error.message }))
      conn.close()
      return
    }

    child.stdin.on('error', () => { /* 对端退出时写会失败，忽略 */ })

    const forward = (chunk) => {
      const text = decoder.write(chunk)
      if (text) conn.send(JSON.stringify({ type: 'data', data: text }))
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)

    child.on('error', (error) => {
      conn.send(JSON.stringify({ type: 'error', message: '终端进程出错：' + error.message }))
      conn.close()
    })

    child.on('exit', (code, signal) => {
      const rest = decoder.end()
      if (rest) conn.send(JSON.stringify({ type: 'data', data: rest }))
      conn.send(JSON.stringify({ type: 'exit', code, signal }))
      conn.close()
    })

    conn.send(JSON.stringify({ type: 'ready', node: node.id, ref, shell }))
  }

  return { handleUpgrade }
}
