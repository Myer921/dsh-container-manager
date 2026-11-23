/**
 * 任务队列
 *
 * 为什么需要它：克隆、快照、导出、提交镜像这些操作在 HTTP 请求里 await 是错的。
 * ext4 + loop 上克隆一个 8G 容器就是整份复制，浏览器四分钟前就超时了，命令还在跑，
 * 人看到的是「失败」，磁盘上多了一半东西。
 *
 * 这里只做三件事：入队、流式收尾部输出、能取消。进度是 best-effort ——
 * 大多数 podman/lxc 子命令不给百分比，那就老实显示「跑着呢」，不编进度条。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CmError, ERR, newToken, nowIso, safeJson } from './util.js'

const KEEP_FINISHED = 200
const TAIL_LINES = 200
const PERSIST_EVERY_MS = 1500
const KILL_GRACE_MS = 5000

export function createJobStore({ file, maxRunning = 2, onChange = null } = {}) {
  mkdirSync(dirname(file), { recursive: true })

  /** @type {Map<string, any>} */
  const records = new Map()
  /** 待跑队列：只放 id 与运行期 spec，函数不进磁盘。 */
  const queue = []
  /** 运行期句柄：子进程 / 中止器 / 报告器。 */
  const runtime = new Map()
  let running = 0
  let persistTimer = null

  for (const raw of readDisk()) {
    if (!raw || typeof raw.id !== 'string') continue
    if (raw.status === 'running' || raw.status === 'queued') {
      // 宿主重启时正在跑的任务没人接管了：如实标中断，不假装成功也不删记录。
      records.set(raw.id, {
        ...raw,
        status: 'interrupted',
        finishedAt: nowIso(),
        error: '宿主重启，任务被中断，结果未知。',
      })
      continue
    }
    records.set(raw.id, raw)
  }

  function readDisk() {
    if (!existsSync(file)) return []
    const parsed = safeJson(readFileSync(file, 'utf8'), null)
    return Array.isArray(parsed) ? parsed : []
  }

  function persist() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    const all = [...records.values()]
    const active = all.filter(record => record.status === 'queued' || record.status === 'running')
    const finished = all
      .filter(record => record.status !== 'queued' && record.status !== 'running')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const kept = [...active, ...finished.slice(-KEEP_FINISHED)]
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }

  /** 输出每来一行就写盘太浪费，攒一下再写。 */
  function touch() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      try { persist() } catch { /* 写不进去也别把任务带崩 */ }
    }, PERSIST_EVERY_MS)
    if (persistTimer.unref) persistTimer.unref()
  }

  function notify() {
    if (typeof onChange !== 'function') return
    try { onChange() } catch { /* 订阅者自己的错，不归队列管 */ }
  }

  function pushLine(record, line) {
    if (!line) return
    record.tail.push(line.length > 500 ? line.slice(0, 500) + '…' : line)
    while (record.tail.length > TAIL_LINES) record.tail.shift()
  }

  function finish(id, { ok, result, error, exitCode, signal }) {
    const record = records.get(id)
    if (!record) return
    record.status = ok ? 'done' : (record.cancelled ? 'cancelled' : 'failed')
    record.finishedAt = nowIso()
    record.exitCode = exitCode ?? null
    record.signal = signal ?? null
    record.result = result ?? null
    record.error = ok ? null : String(error ?? '任务失败')
    persist()
    notify()
  }

  /** 跑一个子进程，把 stdout/stderr 按行收进尾部缓冲。 */
  function runCommand(spec, record, signal) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
          cwd: spec.cwd || undefined,
          env: { ...process.env, ...(spec.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(error)
        return
      }
      runtime.set(record.id, { ...(runtime.get(record.id) || {}), child })
      const feed = (chunk, isErr) => {
        const text = String(chunk)
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue
          pushLine(record, isErr ? '! ' + line : line)
        }
        touch()
        notify()
      }
      child.stdout.on('data', chunk => feed(chunk, false))
      child.stderr.on('data', chunk => feed(chunk, true))
      child.on('error', error => reject(error))
      child.on('close', (code, closeSignal) => {
        if (signal && signal.aborted) {
          resolve({ exitCode: code, signal: closeSignal, aborted: true })
          return
        }
        if (code === 0) resolve({ exitCode: 0, signal: closeSignal })
        else reject(new Error('命令退出码 ' + code + '（' + spec.command + '）'))
      })
    })
  }

  async function start(entry) {
    const { id, spec } = entry
    const record = records.get(id)
    if (!record || record.status !== 'queued') return
    running += 1
    const controller = new AbortController()
    runtime.set(id, { controller })
    record.status = 'running'
    record.startedAt = nowIso()
    persist()
    notify()
    try {
      const result = spec.run
        ? await spec.run({
          signal: controller.signal,
          report: patch => {
            if (patch && typeof patch === 'object') {
              record.progress = { ...(record.progress || {}), ...patch }
              touch()
              notify()
            }
          },
          log: line => { pushLine(record, line); touch(); notify() },
        })
        : await runCommand(spec, record, controller.signal)
      if (controller.signal.aborted) finish(id, { ok: false, error: '已取消。' })
      else finish(id, { ok: true, result: result ?? null, exitCode: result ? result.exitCode : 0 })
    } catch (error) {
      finish(id, { ok: false, error: error && error.message ? error.message : String(error) })
    } finally {
      const handle = runtime.get(id)
      runtime.delete(id)
      if (handle && handle.killTimer) clearTimeout(handle.killTimer)
      running -= 1
      pump()
    }
  }

  function pump() {
    while (running < maxRunning && queue.length > 0) {
      const entry = queue.shift()
      void start(entry)
    }
  }

  function pruneQueued(id) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].id === id) queue.splice(index, 1)
    }
  }

  return {
    file,

    /**
     * 入队。spec 三选一：command+args（跑子进程）、run(ctx)（走 helper socket 这类异步调用）。
     * @returns 任务记录快照
     */
    enqueue(spec) {
      if (!spec || typeof spec !== 'object') throw new CmError(ERR.BAD_ARGS, '任务描述不能为空。')
      if (!spec.command && typeof spec.run !== 'function') {
        throw new CmError(ERR.BAD_ARGS, '任务要么给 command，要么给 run()。')
      }
      const id = newToken('job')
      const record = {
        id,
        kind: String(spec.kind || 'task'),
        label: String(spec.label || spec.command || spec.kind || '任务').slice(0, 200),
        node: spec.node ?? null,
        target: spec.target ?? null,
        status: 'queued',
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        signal: null,
        error: null,
        result: null,
        progress: null,
        tail: [],
        args: spec.args ?? {},
        principal: spec.principal ?? 'ai',
        cancellable: typeof spec.run === 'function' ? true : Boolean(spec.command),
      }
      records.set(id, record)
      queue.push({ id, spec })
      persist()
      notify()
      pump()
      return { ...record }
    },

    list({ includeFinished = true } = {}) {
      const all = [...records.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return all
        .filter(record => includeFinished || record.status === 'queued' || record.status === 'running')
        .map(record => ({ ...record, tail: [...record.tail] }))
    },

    get(id) {
      const record = records.get(String(id))
      return record ? { ...record, tail: [...record.tail] } : null
    },

    /** 统计：给顶栏那个「N 个任务」胶囊用。 */
    summary() {
      let queued = 0
      let active = 0
      let failed = 0
      for (const record of records.values()) {
        if (record.status === 'queued') queued += 1
        else if (record.status === 'running') active += 1
        else if (record.status === 'failed') failed += 1
      }
      return { queued, running: active, failed, total: records.size }
    },

    cancel(id, principal = 'panel') {
      const record = records.get(String(id))
      if (!record) throw new CmError(ERR.NOT_FOUND, '没有这个任务。')
      if (record.status === 'queued') {
        pruneQueued(record.id)
        record.status = 'cancelled'
        record.cancelled = true
        record.cancelledBy = principal
        record.finishedAt = nowIso()
        record.error = '排队中被取消，没有执行。'
        persist()
        notify()
        return { ...record }
      }
      if (record.status !== 'running') {
        throw new CmError(ERR.BAD_ARGS, '任务已经是 ' + record.status + '，不能取消。')
      }
      record.cancelled = true
      record.cancelledBy = principal
      const handle = runtime.get(record.id) || {}
      if (handle.controller) {
        try { handle.controller.abort() } catch { /* 没接也无所谓 */ }
      }
      if (handle.child) {
        try { handle.child.kill('SIGTERM') } catch { /* 已经退了 */ }
        handle.killTimer = setTimeout(() => {
          try { handle.child.kill('SIGKILL') } catch { /* 已经退了 */ }
        }, KILL_GRACE_MS)
        if (handle.killTimer.unref) handle.killTimer.unref()
      }
      runtime.set(record.id, handle)
      notify()
      return { ...record }
    },

    /** 插件卸载时调用：不杀正在跑的子进程，但要停掉待跑队列。 */
    dispose() {
      queue.length = 0
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      try { persist() } catch { /* 卸载路径上别抛 */ }
    },
  }
}
