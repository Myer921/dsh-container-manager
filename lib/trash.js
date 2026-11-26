import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { newToken, nowIso, safeJson } from './util.js'

export function createTrashStore({ file, retentionDays = 7 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  let records = existsSync(file) ? safeJson(readFileSync(file, 'utf8'), []) : []
  if (!Array.isArray(records)) records = []

  function persist() {
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
  }

  return {
    file,
    list() {
      const cutoff = Date.now() - retentionDays * 86_400_000
      return records.filter(record => Date.parse(record.createdAt) >= cutoff)
    },
    add(record) {
      const value = { id: newToken('trash'), createdAt: nowIso(), ...record }
      records.push(value)
      persist()
      return value
    },
    remove(id) {
      const before = records.length
      records = records.filter(record => record.id !== id)
      if (records.length === before) return false
      persist()
      return true
    },
  }
}
