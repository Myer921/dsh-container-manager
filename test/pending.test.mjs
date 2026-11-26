import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPendingStore } from '../lib/pending.js'

function store(ttlSeconds = 600) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-pending-'))
  return createPendingStore({ file: join(dir, 'pending.json'), ttlSeconds })
}

test('begin → take → finish 正常流程', () => {
  const pendings = store()
  const record = pendings.begin({
    node: 'local-podman',
    kind: 'container.action',
    target: 'demo',
    action: 'delete',
    args: { action: 'delete' },
    summary: '删除 demo',
  })
  assert.match(record.token, /^cm-[0-9a-f]{32}$/)
  assert.equal(record.status, 'pending')
  assert.ok(Date.parse(record.expiresAt) > Date.now())

  const taken = pendings.take(record.token)
  assert.equal(taken.status, 'executing')

  const finished = pendings.finish(record.token, { ok: true, result: { done: true } })
  assert.equal(finished.status, 'done')
  assert.deepEqual(finished.result, { done: true })

  assert.throws(() => pendings.take(record.token), /已经处于 done/)
})

test('取两次只能成功一次', () => {
  const pendings = store()
  const record = pendings.begin({ node: 'n', kind: 'k', action: 'a', summary: 's' })
  pendings.take(record.token)
  assert.throws(() => pendings.take(record.token), /已经处于 executing/)
})

test('过期的 pending 取不出来', () => {
  const pendings = store(0)
  const record = pendings.begin({ node: 'n', kind: 'k', action: 'a', summary: 's' })
  assert.throws(() => pendings.take(record.token), /过期/)
  const after = pendings.get(record.token)
  assert.equal(after.status, 'expired')
})

test('取消后不能再执行', () => {
  const pendings = store()
  const record = pendings.begin({ node: 'n', kind: 'k', action: 'a', summary: 's' })
  const cancelled = pendings.cancel(record.token, 'panel')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelledBy, 'panel')
  assert.throws(() => pendings.take(record.token), /已经处于 cancelled/)
})

test('list 默认只给未完成', () => {
  const pendings = store()
  const first = pendings.begin({ node: 'n', kind: 'k', action: 'a', summary: 's1' })
  pendings.begin({ node: 'n', kind: 'k', action: 'a', summary: 's2' })
  assert.equal(pendings.list().length, 2)
  assert.equal(pendings.list({ includeFinished: false }).length, 2)
  pendings.take(first.token)
  pendings.finish(first.token, { ok: true, result: null })
  assert.equal(pendings.list({ includeFinished: false }).length, 1)
  assert.equal(pendings.list().length, 2)
})

test('落盘后重新加载还在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-pending-'))
  const file = join(dir, 'pending.json')
  const first = createPendingStore({ file, ttlSeconds: 600 })
  const record = first.begin({ node: 'n', kind: 'k', action: 'a', summary: 's' })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Array.isArray(raw), true)
  assert.equal(raw[0].token, record.token)

  const second = createPendingStore({ file, ttlSeconds: 600 })
  assert.equal(second.get(record.token).summary, 's')
})

test('参数摘要记录在原位', () => {
  const pendings = store()
  const record = pendings.begin({ node: 'n', kind: 'k', action: 'a', args: { x: 1 }, summary: 's' })
  assert.match(record.argsDigest, /^[0-9a-f]{32}$/)
})
