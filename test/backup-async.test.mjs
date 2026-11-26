import test from 'node:test'
import assert from 'node:assert/strict'

import { createBackupScheduler } from '../lib/backup.js'

test('异步导出等待 job 终态后才清理旧备份', async () => {
  const files = [
    { name: 'demo-20261120T100000.tar.gz', bytes: 10 },
    { name: 'other-20261120T100000.tar.gz', bytes: 10 },
  ]
  const exported = []
  const removed = []
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['demo'], everyHours: 1, keepCount: 1, keepDays: 3650 }),
    listFiles: async () => files.slice(),
    listContainers: async () => ['demo', 'other'],
    exportNow: async name => {
      exported.push(name)
      return { status: 'job', job: { id: 'job-1' } }
    },
    waitJob: async id => {
      assert.equal(id, 'job-1')
      files.push({ name: 'demo-20261124T120000.tar.gz', bytes: 20 })
      return { id, status: 'done' }
    },
    removeFile: async name => { removed.push(name) },
    now: () => Date.parse('2026-11-24T12:00:00Z'),
  })
  const result = await scheduler.tick()
  assert.deepEqual(exported, ['demo'])
  assert.deepEqual(removed, ['demo-20261120T100000.tar.gz'])
  assert.equal(result.removed.length, 1)
})

test('导出任务失败时保留旧备份', async () => {
  const files = [{ name: 'demo-20261120T100000.tar.gz', bytes: 10 }]
  const removed = []
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['demo'], everyHours: 1, keepCount: 1, keepDays: 3650 }),
    listFiles: async () => files.slice(),
    listContainers: async () => ['demo'],
    exportNow: async () => ({ status: 'job', job: { id: 'job-fail' } }),
    waitJob: async () => ({ status: 'failed', error: 'disk full' }),
    removeFile: async name => { removed.push(name) },
    now: () => Date.parse('2026-11-24T12:00:00Z'),
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, [])
  assert.deepEqual(removed, [])
  assert.ok(result.events.some(event => /保留旧备份/.test(event.text)))
})

test('连续两轮不会重复入队同一目标', async () => {
  const files = []
  let exports = 0
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['demo'], everyHours: 24, keepCount: 5, keepDays: 14 }),
    listFiles: async () => files.slice(),
    listContainers: async () => ['demo'],
    exportNow: async () => {
      exports += 1
      return { status: 'job', job: { id: 'job-' + exports } }
    },
    waitJob: async () => {
      files.push({ name: 'demo-20261124T120000.tar.gz', bytes: 20 })
      return { status: 'done' }
    },
    removeFile: async () => {},
    now: () => Date.parse('2026-11-24T12:00:00Z'),
  })
  await scheduler.tick()
  await scheduler.tick()
  assert.equal(exports, 1)
})
