/**
 * podman-compose 运行时（v0.3.0，grill Q8：插件自己装，pin 1.6.0）
 *
 * 为什么不用系统那个 1.0.3：它对 network_mode: host 会生成两个 --network 导致 podman 拒绝，
 * 对 healthcheck 生成 podman 4.3.1 不认的 --healthcheck-command。实测两个都是硬伤。
 *
 * venv 必须放在数据目录里（~/.dsh-next/container-manager/venv），不能放 /tmp ——
 * 那个重启就没了，表现为「昨天还能用今天说没装」。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { DEFAULT_COMPOSE_VERSION, dataDir } from '../config.js'

const execFileAsync = promisify(execFile)

export function venvDir() {
  return join(dataDir(), 'venv')
}

export function defaultBinaryPath() {
  return join(venvDir(), 'bin', 'podman-compose')
}

/** 配置里显式给了 binary 就用它，否则用默认 venv 路径。 */
export function resolveBinary(composeSettings = {}) {
  const configured = typeof composeSettings.binary === 'string' ? composeSettings.binary.trim() : ''
  return configured || defaultBinaryPath()
}

async function versionOf(binary, exec) {
  try {
    const result = await exec(binary, ['--version'], { timeoutMs: 20_000, maxBuffer: 1024 * 1024 })
    const text = String(result.stdout || result.stderr || '').trim()
    // podman-compose --version 会先打一行 podman 的版本再打自己的；只留自己那行。
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    const own = lines.find(line => /podman-compose/i.test(line))
    return own || lines[0] || ''
  } catch (error) {
    return ''
  }
}

/**
 * 运行时是否可用。不抛错 —— 状态不好本身就是一种正常状态。
 * @returns {{ready:boolean, binary:string, exists:boolean, version:string, expected:string, venv:string, hint?:string}}
 */
export async function runtimeStatus(composeSettings = {}, { exec = execFileAsync } = {}) {
  const binary = resolveBinary(composeSettings)
  const expected = composeSettings.version || DEFAULT_COMPOSE_VERSION
  const exists = existsSync(binary)
  if (!exists) {
    return {
      ready: false,
      binary,
      exists: false,
      // 用 null 而不是空串：前端「没探测到」和「探测到空版本」不用分两种情况去猜。
      version: null,
      expected,
      venv: venvDir(),
      hint: '本机还没装 podman-compose（面板上的「一键安装」会建 venv 并装 ' + expected + '）。',
    }
  }
  const version = await versionOf(binary, exec)
  const ready = Boolean(version)
  return {
    ready,
    binary,
    exists: true,
    version: version || null,
    expected,
    venv: venvDir(),
    ...(ready ? {} : { hint: '二进制在但跑不起来（--version 没输出），可能 venv 坏了；删掉 ' + venvDir() + ' 重装。' }),
  }
}

function tail(text, lines = 60) {
  const parts = String(text || '').split('\n')
  return parts.slice(Math.max(0, parts.length - lines)).join('\n')
}

async function runStep(exec, file, args, { timeoutMs = 300_000 } = {}) {
  try {
    const result = await exec(file, args, { timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error && error.stdout || ''),
      stderr: String(error && error.stderr || (error && error.message) || ''),
      code: error && error.code,
    }
  }
}

/**
 * 建 venv 并装 podman-compose。
 * @returns {{ok:boolean, binary:string, version:string, steps:Array, log:string, hint?:string}}
 */
export async function installRuntime({ version = DEFAULT_COMPOSE_VERSION, exec = execFileAsync, onLog } = {}) {
  const dir = venvDir()
  mkdirSync(dataDir(), { recursive: true })
  const steps = []
  const push = (name, result) => {
    const record = { step: name, ok: result.ok, output: tail(result.stderr || result.stdout, 40) }
    steps.push(record)
    if (typeof onLog === 'function') {
      try { onLog(record) } catch { /* 回调挂了不影响安装 */ }
    }
    return result
  }

  if (!existsSync(join(dir, 'bin', 'python'))) {
    const created = push('python3 -m venv', await runStep(exec, 'python3', ['-m', 'venv', dir], { timeoutMs: 180_000 }))
    if (!created.ok) {
      const missingVenv = /ensurepip|python3-venv|No module named venv/i.test(created.stderr || '')
      return {
        ok: false,
        binary: join(dir, 'bin', 'podman-compose'),
        version: '',
        steps,
        log: created.stderr,
        hint: missingVenv
          ? '这台机器缺 python3-venv：先 sudo apt install python3-venv，再点一次安装。'
          : '建 venv 失败，看 steps 里的原始输出。',
      }
    }
  }

  const pip = join(dir, 'bin', 'pip')
  const installed = push(
    'pip install podman-compose==' + version,
    await runStep(exec, pip, ['install', '--disable-pip-version-check', 'podman-compose==' + version], { timeoutMs: 600_000 }),
  )
  if (!installed.ok) {
    return {
      ok: false,
      binary: join(dir, 'bin', 'podman-compose'),
      version: '',
      steps,
      log: installed.stderr,
      hint: '装包失败：多半是没网或代理不通。原始输出在 steps 里。',
    }
  }

  const binary = join(dir, 'bin', 'podman-compose')
  const reported = await versionOf(binary, exec)
  return {
    ok: Boolean(reported),
    binary,
    version: reported,
    steps,
    log: tail(installed.stdout + '\n' + installed.stderr, 60),
    ...(reported ? {} : { hint: '装完了但 --version 跑不起来，检查 venv 的 bin 目录权限。' }),
  }
}
