import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRetention,
  createBackupScheduler,
  normalizeBackupPolicy,
  parseExportName,
  planBackups,
} from '../lib/backup.js'

const NOW = Date.parse('2026-11-24T12:00:00Z')

test('导出文件名能解析出容器名与时间；带 - 的容器名也不切错', () => {
  const single = parseExportName('unlock-20261124T030000.tar.gz')
  assert.equal(single.container, 'unlock')
  assert.equal(single.at, '2026-11-24T03:00:00.000Z')
  const dashed = parseExportName('catstar-next-smokeping-20261120T230000.tar.gz')
  assert.equal(dashed.container, 'catstar-next-smokeping')
  assert.equal(dashed.at, '2026-11-20T23:00:00.000Z')
})

test('不是归档的文件名一律 null（不猜）', () => {
  assert.equal(parseExportName('notes.txt'), null)
  assert.equal(parseExportName(''), null)
  assert.equal(parseExportName('unlock.tar.gz').at, null)
})

test('策略规范化：非法值回默认，目标去重', () => {
  const policy = normalizeBackupPolicy({ enabled: true, targets: ['unlock', 'unlock', 'bad name', ''], everyHours: 0, keepCount: 999, keepDays: -1 })
  assert.equal(policy.enabled, true)
  assert.deepEqual(policy.targets, ['unlock'])
  assert.equal(policy.everyHours, 1)
  assert.equal(policy.keepCount, 64)
  assert.equal(policy.keepDays, 1)
  assert.equal(normalizeBackupPolicy(null).enabled, false)
})

test('到期判断：没有归档 / 超过周期就到期，还新的就不动', () => {
  const files = [
    { name: 'unlock-20261124T100000.tar.gz', bytes: 10 },
    { name: 'fwchat-20261120T100000.tar.gz', bytes: 10 },
  ]
  const plan = planBackups({ policy: { enabled: true, targets: ['unlock', 'fwchat', 'gone'], everyHours: 24 }, files, containers: ['unlock', 'fwchat'], now: NOW })
  assert.deepEqual(plan.due.map(item => item.name), ['fwchat'])
  assert.deepEqual(plan.fresh.map(item => item.name), ['unlock'])
  assert.deepEqual(plan.missing, ['gone'])
  assert.equal(plan.due[0].lastAt, '2026-11-20T10:00:00.000Z')
})

test('从没导出过的容器一定到期', () => {
  const plan = planBackups({ policy: { enabled: true, targets: ['unlock'], everyHours: 24 }, files: [], containers: ['unlock'], now: NOW })
  assert.equal(plan.due.length, 1)
  assert.equal(plan.due[0].lastAt, null)
  assert.equal(plan.due[0].ageHours, null)
})

test('保留策略：留最近 N 份，超龄的也删', () => {
  const files = [
    { name: 'unlock-20261124T100000.tar.gz', bytes: 1 },
    { name: 'unlock-20261123T100000.tar.gz', bytes: 2 },
    { name: 'unlock-20261122T100000.tar.gz', bytes: 3 },
    { name: 'unlock-20261001T100000.tar.gz', bytes: 4 },
  ]
  const result = applyRetention({ files, keepCount: 2, keepDays: 7, now: NOW })
  assert.deepEqual(result.keep.map(file => file.name), ['unlock-20261124T100000.tar.gz', 'unlock-20261123T100000.tar.gz'])
  assert.deepEqual(result.remove.map(file => file.name), ['unlock-20261122T100000.tar.gz', 'unlock-20261001T100000.tar.gz'])
  assert.equal(result.freedBytes, 7)
})

test('保留策略按容器分组算，不会因为别的容器多就删掉你的', () => {
  const files = [
    { name: 'a-20261124T100000.tar.gz', bytes: 1 },
    { name: 'a-20261123T100000.tar.gz', bytes: 1 },
    { name: 'b-20261124T100000.tar.gz', bytes: 1 },
    { name: 'b-20261123T100000.tar.gz', bytes: 1 },
    { name: 'b-20261122T100000.tar.gz', bytes: 1 },
  ]
  const result = applyRetention({ files, keepCount: 2, keepDays: 30, now: NOW })
  assert.equal(result.keep.filter(file => file.container === 'a').length, 2)
  assert.equal(result.keep.filter(file => file.container === 'b').length, 2)
  assert.deepEqual(result.remove.map(file => file.name), ['b-20261122T100000.tar.gz'])
})

test('调度器：关着就什么都不做', async () => {
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: false }),
    listFiles: async () => [],
    exportNow: async () => { throw new Error('不该被调') },
    removeFile: async () => {},
    listContainers: async () => [],
  })
  const result = await scheduler.tick()
  assert.equal(result.skipped, 'disabled')
})

test('调度器：到期的才导出，导出后按保留策略删旧的', async () => {
  const state = {
    files: [
      { name: 'unlock-20261120T100000.tar.gz', bytes: 1 },
      { name: 'unlock-20261001T100000.tar.gz', bytes: 1 },
    ],
    exported: [],
    removed: [],
  }
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['unlock'], everyHours: 1, keepCount: 1, keepDays: 3650 }),
    listFiles: async () => state.files.slice(),
    exportNow: async name => {
      state.exported.push(name)
      state.files.push({ name: name + '-20261124T120000.tar.gz', bytes: 1 })
    },
    removeFile: async name => { state.removed.push(name) },
    listContainers: async () => ['unlock'],
    now: () => NOW,
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, ['unlock'])
  assert.deepEqual(state.exported, ['unlock'])
  assert.ok(state.removed.length >= 1, '旧的应该被删')
  assert.ok(result.events.some(event => event.level === 'ok'))
})

test('调度器：一次只跑一个导出，重入直接跳过', async () => {
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['unlock'], everyHours: 1 }),
    listFiles: async () => [],
    exportNow: async () => { await gate },
    removeFile: async () => {},
    listContainers: async () => ['unlock'],
    now: () => NOW,
  })
  const first = scheduler.tick()
  const second = await scheduler.tick()
  assert.equal(second.skipped, 'busy')
  release()
  const done = await first
  assert.deepEqual(done.started, ['unlock'])
})

test('调度器：导出失败记下来接着走，不整轮崩掉', async () => {
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['a', 'b'], everyHours: 1 }),
    listFiles: async () => [],
    exportNow: async name => { if (name === 'a') throw new Error('没空间了') },
    removeFile: async () => {},
    listContainers: async () => ['a', 'b'],
    now: () => NOW,
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, ['b'])
  assert.ok(result.events.some(event => event.level === 'bad' && /没空间了/.test(event.text)))
})

test('调度器：目标不是 LXC 容器时提醒并跳过', async () => {
  const scheduler = createBackupScheduler({
    getPolicy: () => ({ enabled: true, targets: ['nginx'], everyHours: 1 }),
    listFiles: async () => [],
    exportNow: async () => { throw new Error('不该被调') },
    removeFile: async () => {},
    listContainers: async () => ['unlock'],
    now: () => NOW,
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, [])
  assert.ok(result.events.some(event => /不是 LXC 容器/.test(event.text)))
})
