/**
 * 审计：一条写操作一行 JSONL。
 *
 * 目的不是防谁，是「三天后还能回答那次删除是谁点的」。
 * 只追加、不覆盖；超过保留行数时整份裁一次（先写 .tmp 再 rename）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { nowIso } from './util.js'

export function createAudit({ file, keepLines = 2000 }) {
  let writes = 0
  let lastError = null
  mkdirSync(file.substring(0, file.lastIndexOf('/')), { recursive: true })

  function trimIfNeeded() {
    if (!existsSync(file)) return
    let lines
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch {
      return
    }
    if (lines.length <= keepLines) return
    const kept = lines.slice(-keepLines)
    const temporary = file + '.tmp'
    writeFileSync(temporary, kept.join('\n') + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }

  return {
    file,
    /**
     * 记一条。字段全部自由，调用方保证不含密钥。
     * @param {Record<string, unknown>} entry
     */
    append(entry) {
      const line = JSON.stringify({ ts: nowIso(), ...entry })
      try {
        appendFileSync(file, line + '\n', { mode: 0o600 })
        lastError = null
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
        return false
      }
      writes += 1
      if (writes % 50 === 0) trimIfNeeded()
      return true
    },
    health() {
      return { ok: lastError === null, lastError }
    },

    /** 最近 limit 条，旧的在前面。 */
    read(limit = 100) {
      if (!existsSync(file)) return []
      let lines
      try {
        lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
      const slice = lines.slice(-Math.max(1, Math.min(2000, limit)))
      const out = []
      for (const line of slice) {
        try {
          out.push(JSON.parse(line))
        } catch {
          // 坏行跳过，不因为一行坏数据丢掉整份审计
        }
      }
      return out
    },
  }
}
