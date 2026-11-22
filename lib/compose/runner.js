/**
 * podman-compose 执行器（v0.3.0，混合方案的「执行」那一半）
 *
 * 我们只信它两件事：把 compose 变成正确的 podman 调用、以及 up/down 的生命周期顺序。
 * 状态、配置、端口一律自己读 —— 它的输出格式不是给人解析的。
 *
 * 两个必须显式传的开关：
 *   --in-pod=false  1.6.0 默认会建 pod（pod_<项目名>），和 docker compose 行为不一致
 *   -p <name>       项目名统一由我们 sanitize 后传入，不靠它从目录名猜
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const COMPOSE_ACTIONS = {
  up: ['up', '-d'],
  down: ['down'],
  restart: ['restart'],
  stop: ['stop'],
  ps: ['ps'],
  logs: ['logs', '--no-color'],
}

export function buildComposeCommand({ binary, project, action, extra = [] }) {
  const tail = COMPOSE_ACTIONS[action]
  if (!tail) throw new Error('不支持的 compose 动作：' + action)
  return [binary, '--in-pod=false', '-f', project.file, '-p', project.projectName, ...tail, ...extra]
}

/**
 * 跑一次 compose 动作。失败不抛错 —— 返回结构化结果，让上层决定怎么说给人听。
 * @returns {{ok:boolean, code:number|null, stdout:string, stderr:string, command:string, durationMs:number}}
 */
export async function runCompose({ binary, project, action, extra = [], timeoutMs = 180_000, cwd, exec = execFileAsync }) {
  const argv = buildComposeCommand({ binary, project, action, extra })
  const [file, ...args] = argv
  const startedAt = Date.now()
  try {
    const result = await exec(file, args, {
      timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      cwd: cwd || project.dir,
    })
    return {
      ok: true,
      code: 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      command: argv.join(' '),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const code = typeof error && error.code === 'number' ? error.code : null
    return {
      ok: false,
      code,
      stdout: String(error && error.stdout || ''),
      stderr: String(error && error.stderr || (error && error.message) || ''),
      command: argv.join(' '),
      durationMs: Date.now() - startedAt,
      timedOut: Boolean(error && error.timedOut),
    }
  }
}

/** 把 stderr 里真正有用的一行挑出来（compose 的输出经常一堆 INFO）。 */
export function summarizeFailure(result) {
  const lines = String(result && result.stderr || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const bad = lines.filter(line => /error|fail|cannot|denied|not found|冲突|失败/i.test(line))
  const picked = bad.length > 0 ? bad.slice(-3) : lines.slice(-3)
  return picked.join(' / ') || '没有输出，退出码 ' + String(result && result.code)
}
