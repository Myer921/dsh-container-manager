/**
 * 待确认队列
 *
 * 危险动作不直接执行：先落一条 pending，拿到 token；只有面板拿着 token
 * 点确认才真正跑。AI 工具只能看见它、不能确认它。
 *
 * 状态：pending → executing → done / failed；pending → cancelled / expired。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { CmError, ERR, digest, newToken, nowIso, safeJson } from './util.js'

const FINISHED_KEEP = 100

export function createPendingStore({ file, ttlSeconds = 600 }) {
  mkdirSync(file.substring(0, file.lastIndexOf('/')), { recursive: true })

  /** @type {Map<string, any>} */
  const records = new Map()

  for (const raw of readDisk()) {
    if (!raw || typeof raw.token !== 'string') continue
    if (raw.status === 'executing') {
      records.set(raw.token, {
        ...raw,
        status: 'interrupted',
        finishedAt: nowIso(),
        error: '宿主重启，执行结果未知。',
      })
      continue
    }
    records.set(raw.token, raw)
  }

  function readDisk() {
    if (!existsSync(file)) return []
    const parsed = safeJson(readFileSync(file, 'utf8'), null)
    return Array.isArray(parsed) ? parsed : []
  }

  function persist() {
    const all = [...records.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const finished = all.filter(record => record.status !== 'pending' && record.status !== 'executing')
    const active = all.filter(record => record.status === 'pending' || record.status === 'executing')
    const kept = [...active, ...finished.slice(-FINISHED_KEEP)]
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }

  function expired(record) {
    return Date.parse(record.expiresAt) <= Date.now()
  }

  /** 过期判定只针对尚未执行的 pending；executing 的结果由执行器写回。 */
  function sweep() {
    let changed = false
    for (const record of records.values()) {
      if (record.status === 'pending' && expired(record)) {
        record.status = 'expired'
        record.finishedAt = nowIso()
        record.error = '待确认已过期，未执行。'
        changed = true
      }
    }
    if (changed) persist()
    return changed
  }

  return {
    file,
    ttlSeconds,

    /**
     * 登记一条待确认。
     * @param {{node:string, kind:string, target?:string, action:string, args?:object, summary:string, principal?:string}} input
     */
    begin(input) {
      sweep()
      const token = newToken('cm')
      const createdAt = nowIso()
      const record = {
        token,
        node: input.node,
        kind: input.kind,
        target: input.target ?? null,
        action: input.action,
        args: input.args ?? {},
        argsDigest: digest(input.args ?? {}),
        summary: input.summary,
        // 危险动作的预演：确认之前就能看到「会发生什么」。读不到时这里是 null。
        plan: input.plan ?? null,
        principal: input.principal ?? 'ai',
        status: 'pending',
        createdAt,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      }
      records.set(token, record)
      persist()
      return { ...record }
    },

    list({ includeFinished = true } = {}) {
      sweep()
      const all = [...records.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return all
        .filter(record => includeFinished || record.status === 'pending')
        .map(record => ({ ...record }))
    },

    get(token) {
      sweep()
      const record = records.get(String(token))
      return record ? { ...record } : null
    },

    /**
     * 原子取走：pending → executing。过期、已用、已取消一律拒绝。
     * @param {string} token
     */
    take(token) {
      sweep()
      const record = records.get(String(token))
      if (!record) throw new CmError(ERR.NOT_FOUND, '没有这条待确认（可能已过期并被清理）。')
      if (expired(record)) {
        record.status = 'expired'
        persist()
        throw new CmError(ERR.CONFIRM_REQUIRED, '这条待确认已经过期，请重新发起。')
      }
      if (record.status !== 'pending') {
        throw new CmError(ERR.BAD_ARGS, `这条待确认已经处于 ${record.status}，不能重复执行。`)
      }
      if (record.argsDigest !== digest(record.args ?? {})) {
        throw new CmError(ERR.BAD_ARGS, '待确认参数与发起时不一致，已拒绝执行。')
      }
      record.status = 'executing'
      record.startedAt = nowIso()
      persist()
      return { ...record }
    },

    /** 执行完写回结果。 */
    finish(token, { ok, result, error }) {
      const record = records.get(String(token))
      if (!record) return null
      record.status = ok ? 'done' : 'failed'
      record.finishedAt = nowIso()
      record.result = result ?? null
      record.error = ok ? null : String(error ?? '执行失败')
      persist()
      return { ...record }
    },

    cancel(token, principal = 'panel') {
      sweep()
      const record = records.get(String(token))
      if (!record) throw new CmError(ERR.NOT_FOUND, '没有这条待确认。')
      if (record.status !== 'pending') throw new CmError(ERR.BAD_ARGS, `这条待确认已经处于 ${record.status}，不能取消。`)
      record.status = 'cancelled'
      record.finishedAt = nowIso()
      record.cancelledBy = principal
      persist()
      return { ...record }
    },
  }
}
