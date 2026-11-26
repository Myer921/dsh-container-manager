import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMetricsStore, createSampler } from '../lib/metrics.js'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'cm-metrics-')), 'metrics.ndjson')
}

test('写进去的样本查得回来，时间窗外的会被过滤', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-24T10:00:00Z')
  const store = createMetricsStore({ file, now: () => clock })
  store.record({ host: { 'local-podman': { load: 1.5, memPercent: 40, containers: 3 } } })
  clock += 60_000
  store.record({ host: { 'local-podman': { load: 2.5, memPercent: 50, containers: 4 } } })
  clock += 4 * 3_600_000
  store.record({ host: { 'local-podman': { load: 9, memPercent: 90, containers: 9 } } })

  // 时钟已经走到 4 小时后：5 分钟窗口里只剩最后一条
  const recent = store.query({ node: 'local-podman', minutes: 5, points: 60 })
  assert.equal(recent.series.length, 1)
  assert.equal(recent.series[0].load, 9)

  const wide = store.query({ node: 'local-podman', minutes: 60 * 6, points: 60 })
  assert.equal(wide.series.length, 3)
  assert.equal(wide.series[0].load, 1.5)
  assert.equal(wide.series[1].load, 2.5)
  assert.equal(wide.series[2].containers, 9)
})

test('降采样：100 个点按桶平均成不超过 12 个', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-24T10:00:00Z')
  const store = createMetricsStore({ file, now: () => clock })
  for (let index = 0; index < 100; index += 1) {
    store.record({ host: { 'local-podman': { load: index, memPercent: 10, containers: 1 } } })
    clock += 30_000
  }
  const result = store.query({ node: 'local-podman', minutes: 60, points: 10 })
  assert.ok(result.series.length <= 12, '点数应被压到 12 以内，实际 ' + result.series.length)
  assert.ok(result.series.length >= 5, '压得太狠就丢了形状')
})

test('按节点过滤，取第一个节点的写法只在没指定节点时用', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-24T10:00:00Z')
  const store = createMetricsStore({ file, now: () => clock })
  store.record({ host: { 'local-podman': { load: 1 }, 'local-lxc': { load: 2 } } })
  assert.equal(store.query({ node: 'local-podman', minutes: 5 }).series[0].load, 1)
  assert.equal(store.query({ node: 'local-lxc', minutes: 5 }).series[0].load, 2)
  assert.equal(store.query({ node: 'nope', minutes: 5 }).series.length, 0)
  assert.equal(store.query({ minutes: 5 }).series.length, 1)
})

test('超过保留天数在重开时被剪掉', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-01T10:00:00Z')
  const store = createMetricsStore({ file, keepDays: 1, now: () => clock })
  store.record({ host: { 'local-podman': { load: 1 } } })
  clock += 3 * 86_400_000
  const reopened = createMetricsStore({ file, keepDays: 1, now: () => clock })
  assert.equal(reopened.count, 0)
})

test('超过字节上限就轮转，只留后半段', () => {
  const file = tempFile()
  const store = createMetricsStore({ file, maxBytes: 900, keepDays: 30 })
  for (let index = 0; index < 40; index += 1) {
    store.record({ host: { 'local-podman': { load: index, memPercent: 20, containers: 2 } } })
  }
  assert.ok(statSync(file).size <= 900, '轮转后文件该变小，现在 ' + statSync(file).size)
  assert.ok(store.count < 40, '内存里也不该留全部 40 条')
  assert.ok(existsSync(file))
  // 轮转后的文件还是能被完整解析的 NDJSON
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
})

test('采样器只记能采到的节点，采不到就跳过', async () => {
  const file = tempFile()
  const store = createMetricsStore({ file })
  const sampler = createSampler({
    metrics: store,
    registry: {
      nodes: () => [{ id: 'local-podman' }, { id: 'local-lxc' }],
      stats: async (id) => {
        if (id === 'local-lxc') throw new Error('helper 没装')
        return {
          ok: true,
          host: {
            ok: true,
            load: { one: 0.5, five: 0.4, fifteen: 0.3 },
            memory: { percent: 33, used: 100, total: 300 },
            disks: [{ mount: '/', percent: 61 }],
          },
          containers: [
            { name: 'a', cpuPercent: 1.234, memUsed: 1000 },
            { name: 'b', cpuPercent: 0, memUsed: 0 },
          ],
        }
      },
    },
  })
  const entry = await sampler.tick()
  assert.ok(entry)
  assert.deepEqual(Object.keys(entry.host), ['local-podman'])
  assert.equal(entry.host['local-podman'].load, 0.5)
  assert.equal(entry.host['local-podman'].diskPercent, 61)
  assert.equal(entry.host['local-podman'].containers, 2)
  // 刻意不落每个容器的曲线：面板只画宿主负载，多存一行都是白占盘
  assert.equal('top' in entry.host['local-podman'], false)
})

test('全都采不到时什么也不写', async () => {
  const store = createMetricsStore({ file: tempFile() })
  const sampler = createSampler({
    metrics: store,
    registry: { nodes: () => [{ id: 'x' }], stats: async () => ({ ok: false, reason: '不可用' }) },
  })
  assert.equal(await sampler.tick(), null)
  assert.equal(store.count, 0)
})

test('采样器能起能停，定时器由外部注入', () => {
  const store = createMetricsStore({ file: tempFile() })
  const timers = []
  const sampler = createSampler({
    metrics: store,
    registry: { nodes: () => [], stats: async () => ({ ok: false }) },
    intervalSeconds: 45,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { id: timers.length } },
    clearTimer: timer => { timers.push({ cleared: timer.id }) },
  })
  sampler.start()
  sampler.start()
  assert.equal(timers.length, 1, '重复 start 不该起两个定时器')
  assert.equal(timers[0].ms, 45_000)
  sampler.stop()
  assert.equal(timers.length, 2)
  assert.equal(timers[1].cleared, 1)
})
