import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshotScheduler, normalizeSnapshotPolicy, planSnapshots, retainSnapshots } from '../lib/snapshot-policy.js'

const NOW = Date.parse('2026-11-26T06:00:00Z')

test('定时快照策略规范化', () => {
  const policy = normalizeSnapshotPolicy({ enabled: true, targets: ['demo', 'demo', 'bad name'], everyHours: 0, keepCount: 999 })
  assert.equal(policy.enabled, true)
  assert.deepEqual(policy.targets, ['demo'])
  assert.equal(policy.everyHours, 1)
  assert.equal(policy.keepCount, 64)
})

test('到期判断只认策略创建的快照', () => {
  const state = { containers: { demo: [{ name: 'snap1', createdAt: '2026-11-25T06:00:00Z' }] } }
  const plan = planSnapshots({ policy: { enabled: true, targets: ['demo'], everyHours: 24 }, state, containers: ['demo'], now: NOW })
  assert.equal(plan.due.length, 1)
  assert.equal(plan.fresh.length, 0)
})

test('保留策略不动手工快照', () => {
  const state = { containers: { demo: [
    { name: 'snap1', createdAt: '2026-11-24T06:00:00Z' },
    { name: 'snap2', createdAt: '2026-11-25T06:00:00Z' },
  ] } }
  assert.deepEqual(retainSnapshots({ state, targets: ['demo'], keepCount: 1 }), [{ container: 'demo', snapshot: 'snap1' }])
})

test('调度器等待任务终态并记录新快照', async () => {
  let state = { containers: {} }
  let snapshots = []
  const removed = []
  const scheduler = createSnapshotScheduler({
    getPolicy: () => ({ enabled: true, targets: ['demo'], everyHours: 24, keepCount: 2 }),
    listContainers: async () => ['demo'],
    listSnapshots: async () => ({ snapshots }),
    createSnapshot: async () => ({ status: 'job', job: { id: 'job-1' } }),
    waitJob: async id => {
      assert.equal(id, 'job-1')
      snapshots = [{ name: 'snap0', detail: 'cm-auto' }]
      return { status: 'done' }
    },
    deleteSnapshot: async (container, snapshot) => { removed.push([container, snapshot]); snapshots = snapshots.filter(item => item.name !== snapshot) },
    loadState: () => state,
    saveState: value => { state = value },
    now: () => NOW,
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, [{ name: 'demo', snapshot: 'snap0' }])
  assert.equal(state.containers.demo.length, 1)
  assert.deepEqual(removed, [])
})

test('创建失败时不清理该目标旧快照', async () => {
  let state = { containers: { demo: [
    { name: 'snap0', createdAt: '2026-11-24T06:00:00Z' },
    { name: 'snap1', createdAt: '2026-11-25T06:00:00Z' },
  ] } }
  const removed = []
  const scheduler = createSnapshotScheduler({
    getPolicy: () => ({ enabled: true, targets: ['demo'], everyHours: 1, keepCount: 1 }),
    listContainers: async () => ['demo'],
    listSnapshots: async () => ({ snapshots: state.containers.demo }),
    createSnapshot: async () => { throw new Error('disk full') },
    deleteSnapshot: async (container, snapshot) => { removed.push([container, snapshot]) },
    loadState: () => state,
    saveState: value => { state = value },
    now: () => NOW,
  })
  const result = await scheduler.tick()
  assert.deepEqual(result.started, [])
  assert.deepEqual(removed, [])
  assert.ok(result.events.some(event => /保留旧快照/.test(event.text) || /快照失败/.test(event.text)))
})
