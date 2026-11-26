/**
 * dsh-container-manager —— 基础工具层
 *
 * 这里只放「与 DSH 无关、可以单独单测」的东西：错误类型、子进程封装、
 * 参数校验、token、摘要。驱动层（podman / lxc）都从这里拿执行器。
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/** 面向上层的稳定错误码。工具与 REST 都把它们原样交给调用方。 */
export const ERR = Object.freeze({
  BAD_ARGS: 'BAD_ARGS',
  NODE_UNAVAILABLE: 'NODE_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  PODMAN_ERROR: 'PODMAN_ERROR',
  HELPER_DOWN: 'HELPER_DOWN',
  UNSUPPORTED_ROOTLESS: 'UNSUPPORTED_ROOTLESS',
  TIMEOUT: 'TIMEOUT',
  MISSING_BINARY: 'MISSING_BINARY',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL: 'INTERNAL',
})

/** 带稳定 code 的领域错误。message 给人看，hint 给下一步。 */
export class CmError extends Error {
  /**
   * @param {string} code 稳定错误码（见 ERR）
   * @param {string} message 人话说明
   * @param {string} [hint] 可选下一步
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'CmError'
    this.code = code
    if (hint) this.hint = hint
  }
}

/** 把任意异常收敛成 CmError，避免上层到处判类型。 */
export function asCmError(err, fallbackCode = ERR.INTERNAL) {
  if (err instanceof CmError) return err
  const message = err && typeof err.message === 'string' ? err.message : String(err)
  return new CmError(fallbackCode, message)
}

/**
 * 跑一个子进程，永远不因「退出码非零」抛异常（那是业务结果），
 * 只有「命令不存在 / 超时」才返回带标记的结果。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, maxBuffer?: number, env?: Record<string,string>, cwd?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, missing: boolean}>}
 */
export function execFileAsync(command, args, options = {}) {
  const {
    timeoutMs = 30_000,
    maxBuffer = 4 * 1024 * 1024,
    env,
    cwd,
    signal,
  } = options

  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          maxBuffer,
          encoding: 'utf8',
          windowsHide: true,
          ...(env ? { env: { ...process.env, ...env } } : {}),
          ...(cwd ? { cwd } : {}),
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          const timedOut = Boolean(error && (error.killed || error.signal === 'SIGTERM' || error.signal === 'SIGKILL'))
          const missing = Boolean(error && error.code === 'ENOENT')
          done({
            code: error && typeof error.code === 'number' ? error.code : missing ? null : timedOut ? null : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            timedOut,
            missing,
          })
        },
      )
    } catch (error) {
      done({ code: null, stdout: '', stderr: error && error.message ? error.message : String(error), timedOut: false, missing: error && error.code === 'ENOENT' })
      return
    }
    child.on('error', (error) => {
      done({
        code: null,
        stdout: '',
        stderr: error && error.message ? error.message : String(error),
        timedOut: false,
        missing: Boolean(error && error.code === 'ENOENT'),
      })
    })
  })
}

/**
 * 取二进制输出（tar 流之类）。execFileAsync 固定 utf8，拿它读二进制会毁数据。
 * 这里返回 Buffer，调用方自己决定怎么解释。
 */
export function execFileBuffer(command, args, options = {}) {
  const { timeoutMs = 60_000, maxBuffer = 32 * 1024 * 1024 } = options
  return new Promise((resolve) => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      execFile(command, args, { timeout: timeoutMs, maxBuffer, encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error.killed || error.signal === 'SIGTERM' || error.signal === 'SIGKILL'))
        const missing = Boolean(error && error.code === 'ENOENT')
        done({
          code: error && typeof error.code === 'number' ? error.code : missing ? null : timedOut ? null : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
          timedOut,
          missing,
        })
      })
    } catch (error) {
      done({ code: null, stdout: Buffer.alloc(0), stderr: error?.message ?? String(error), timedOut: false, missing: error?.code === 'ENOENT' })
    }
  })
}

/** 往子进程 stdin 灌二进制（podman cp - 要从标准输入吃 tar）。 */
export function execFileWithInput(command, args, input, options = {}) {
  const { timeoutMs = 60_000, maxBuffer = 8 * 1024 * 1024 } = options
  return new Promise((resolve) => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ code: null, stdout: '', stderr: error?.message ?? String(error), timedOut: false, missing: error?.code === 'ENOENT' })
      return
    }
    const out = []
    const err = []
    let bytes = 0
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      done({ code: null, stdout: '', stderr: '命令超时。', timedOut: true, missing: false })
    }, timeoutMs)
    if (timer.unref) timer.unref()
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes <= maxBuffer) out.push(chunk)
    })
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      done({ code: null, stdout: '', stderr: error?.message ?? String(error), timedOut: false, missing: error?.code === 'ENOENT' })
    })
    child.on('close', code => {
      clearTimeout(timer)
      done({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut: false,
        missing: false,
      })
    })
    try {
      child.stdin.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? '')))
    } catch (error) {
      clearTimeout(timer)
      done({ code: null, stdout: '', stderr: error?.message ?? String(error), timedOut: false, missing: false })
    }
  })
}

/** 把一次子进程结果翻译成成功输出，或抛带上下文的 CmError。 */
export function requireOk(result, { command, code = ERR.PODMAN_ERROR, hint } = {}) {
  if (result.missing) {
    throw new CmError(ERR.MISSING_BINARY, `找不到命令 ${command ?? ''}。`, hint ?? '确认它装在 PATH 里，或先装好再试。')
  }
  if (result.timedOut) {
    throw new CmError(ERR.TIMEOUT, `${command ?? '命令'} 超时了。`, hint ?? '操作可能仍在后台继续，稍后用只读接口确认状态。')
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n')
    throw new CmError(code, detail || `${command ?? '命令'} 退出码 ${result.code}`, hint)
  }
  return result.stdout
}

/** 从一个可以是 JSON 的 stdout 里拿值；解析失败给出可读错误。 */
export function parseJson(text, label = '输出') {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    throw new CmError(ERR.INTERNAL, `${label}不是合法 JSON。`, raw.slice(0, 200))
  }
}

/* ───────────────────────── 参数校验 ───────────────────────── */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}$/
const IFNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/

export function assertString(value, field, { min = 1, max = 256 } = {}) {
  if (typeof value !== 'string') throw new CmError(ERR.BAD_ARGS, `${field} 必须是字符串。`)
  const text = value.trim()
  if (text.length < min) throw new CmError(ERR.BAD_ARGS, `${field} 不能为空。`)
  if (text.length > max) throw new CmError(ERR.BAD_ARGS, `${field} 太长（>${max}）。`)
  return text
}

export function assertContainerName(value, field = '容器名') {
  const text = assertString(value, field, { max: 63 })
  if (!NAME_RE.test(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不合法：只允许字母数字和 _ . -，且以字母数字开头。`)
  return text
}

export function assertNetworkName(value, field = '网络名') {
  return assertContainerName(value, field)
}

export function assertImage(value, field = '镜像') {
  const text = assertString(value, field, { max: 255 })
  if (!IMAGE_RE.test(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不合法（只允许字母数字与 _ . : / @ -）。`)
  return text
}

export function assertIpv4(value, field = 'IPv4') {
  const text = assertString(value, field, { max: 64 })
  if (!isIPv4(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不是合法 IPv4：${text}`)
  return text
}

export function assertIpv6(value, field = 'IPv6') {
  const text = assertString(value, field, { max: 64 })
  if (!isIPv6(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不是合法 IPv6：${text}`)
  return text
}

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/

export function assertMac(value, field = 'MAC 地址') {
  // 上限给宽一点，让下面那条正则统一给「格式不对」的提示，而不是先撞上长度限制。
  const text = String(value ?? '').trim()
  if (!MAC_RE.test(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不合法（形如 00:16:3e:8a:1c:44）：${text || '(空)'}`)
  return text.toLowerCase()
}

/**
 * 给容器网卡生成本地管理范围内的 MAC。
 *
 * 前缀 00:16:3e 是 LXC / Xen 传统分给虚拟网卡的 OUI，用它就不会和真实厂商的网卡撞号。
 * 后三个字节随机 —— 不按容器名派生，免得 MAC 变成可预测的。
 */
export function randomLxcMac() {
  const bytes = randomBytes(3)
  const tail = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(':')
  return `00:16:3e:${tail}`
}

/** 允许 v4 / v6 的地址（LXC 配置里两种都可能出现）。 */
export function assertIp(value, field = 'IP') {
  const text = assertString(value, field, { max: 64 })
  if (!isIPv4(text) && !isIPv6(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不是合法 IP：${text}`)
  return text
}

export function assertCidr(value, field = 'CIDR') {
  const text = assertString(value, field, { max: 80 })
  const slash = text.indexOf('/')
  if (slash <= 0) throw new CmError(ERR.BAD_ARGS, `${field} 必须是 a.b.c.d/nn：${text}`)
  const address = text.slice(0, slash)
  const prefix = Number(text.slice(slash + 1))
  if (!isIPv4(address) && !isIPv6(address)) throw new CmError(ERR.BAD_ARGS, `${field} 的地址部分不合法：${address}`)
  const maxPrefix = isIPv4(address) ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new CmError(ERR.BAD_ARGS, `${field} 的前缀长度不合法（0..${maxPrefix}）：${prefix}`)
  }
  return text
}

export function assertInterfaceName(value, field = '接口名') {
  const text = assertString(value, field, { max: 15 })
  if (!IFNAME_RE.test(text)) throw new CmError(ERR.BAD_ARGS, `${field} 不合法：${text}`)
  return text
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.trunc(number)
  return Math.min(max, Math.max(min, integer))
}

export function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new CmError(ERR.BAD_ARGS, `${field} 只能是 ${allowed.join(' / ')}，收到 ${String(value)}。`)
  }
  return value
}

/* ───────────────────────── 杂项 ───────────────────────── */

/** 一次性 token；pending 与审计都用它。 */
export function newToken(prefix = 'cm') {
  return `${prefix}-${randomBytes(16).toString('hex')}`
}

/** 参数摘要，用来确认「确认时执行的还是当初发起的那件事」。 */
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32)
}

export function nowIso() {
  return new Date().toISOString()
}

/** 只保留需要的键，避免把整份 inspect 丢给前端。 */
export function pick(object, keys) {
  const out = {}
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) out[key] = object[key]
  }
  return out
}

/** 安全 JSON 解析：坏数据给 fallback，不抛。 */
export function safeJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}
