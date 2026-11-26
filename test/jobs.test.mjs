import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJobStore } from '../lib/jobs.js'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'cm-jobs-')), 'jobs.json')
}

function waitFor(store, id, status, timeoutMs = 8000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const job = store.get(id)
      if (job && job.status === status) return resolve(job)
      if (Date.now() - started > timeoutMs) return reject(new Error('等不到 ' + status + '，现在是 ' + (job && job.status)))
      setTimeout(tick, 40)
    }
    tick()
  })
}

test('跑完的命令是 done，尾部输出按行收着', async () => {
  const store = createJobStore({ file: tempFile() })
  const job = store.enqueue({ kind: 'test', label: '回声', command: '/bin/sh', args: ['-c', 'echo one; echo two'] })
  // 入队可能立刻开跑，所以这里只断言「还没结束」
  assert.ok(['queued', 'running'].includes(job.status), '入队后应该是排队或运行中，实际 ' + job.status)
  const done = await waitFor(store, job.id, 'done')
  assert.equal(done.exitCode, 0)
  assert.deepEqual(done.tail, ['one', 'two'])
  store.dispose()
})

test('非零退出码是 failed，stderr 带 ! 前缀', async () => {
  const store = createJobStore({ file: tempFile() })
  const job = store.enqueue({ kind: 'test', label: '失败', command: '/bin/sh', args: ['-c', 'echo boom >&2; exit 3'] })
  const failed = await waitFor(store, job.id, 'failed')
  assert.match(String(failed.error), /退出码 3/)
  assert.deepEqual(failed.tail, ['! boom'])
  store.dispose()
})

test('排队中的任务可以取消，且不会被执行', async () => {
  const store = createJobStore({ file: tempFile(), maxRunning: 1 })
  const blocker = store.enqueue({ kind: 'test', label: '占位', command: '/bin/sh', args: ['-c', 'sleep 1'] })
  const queued = store.enqueue({ kind: 'test', label: '排队', command: '/bin/sh', args: ['-c', 'echo never > /tmp/cm-never'] })
  assert.equal(store.get(queued.id).status, 'queued')
  store.cancel(queued.id, 'tester')
  const cancelled = store.get(queued.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelledBy, 'tester')
  await waitFor(store, blocker.id, 'done')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(store.get(queued.id).status, 'cancelled')
  store.dispose()
})

test('并发上限真的生效', async () => {
  const store = createJobStore({ file: tempFile(), maxRunning: 1 })
  const first = store.enqueue({ kind: 'test', label: 'A', command: '/bin/sh', args: ['-c', 'sleep 0.6'] })
  const second = store.enqueue({ kind: 'test', label: 'B', command: '/bin/sh', args: ['-c', 'sleep 0.1'] })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(store.get(first.id).status, 'running')
  assert.equal(store.get(second.id).status, 'queued')
  await waitFor(store, second.id, 'done')
  store.dispose()
})

test('状态落盘，新实例读得到；running 残留标成 interrupted', async () => {
  const file = tempFile()
  const store = createJobStore({ file })
  const job = store.enqueue({ kind: 'test', label: '落盘', command: '/bin/sh', args: ['-c', 'echo keep'] })
  await waitFor(store, job.id, 'done')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.length, 1)
  assert.equal(onDisk[0].status, 'done')

  const zombie = { ...onDisk[0], id: 'job-zombie', status: 'running', error: null }
  writeFileSync(file, JSON.stringify([...onDisk, zombie]), 'utf8')
  const reopened = createJobStore({ file })
  assert.equal(reopened.get('job-zombie').status, 'interrupted')
  assert.match(String(reopened.get('job-zombie').error), /中断/)
  reopened.dispose()
  store.dispose()
})

test('run() 形式也能跑，并带得动 report', async () => {
  const store = createJobStore({ file: tempFile() })
  const job = store.enqueue({
    kind: 'helper',
    label: '走 socket 的活',
    run: async ({ report }) => { report({ percent: 40, note: '一半' }); return { ok: true } },
  })
  const done = await waitFor(store, job.id, 'done')
  assert.deepEqual(done.progress, { percent: 40, note: '一半' })
  store.dispose()
})
