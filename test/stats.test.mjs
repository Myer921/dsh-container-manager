import test from 'node:test'
import assert from 'node:assert/strict'

import { parseDf, parseLoadavg, parseMeminfo, nodeStats, stats } from '../lib/stats.js'
import { normalizeStatsRow, sizeToBytes } from '../lib/drivers/podman.js'

test('parseLoadavg 拆出三段负载和进程数', () => {
  const parsed = parseLoadavg('2.32 1.56 1.37 1/577 1242039\n')
  assert.equal(parsed.one, 2.32)
  assert.equal(parsed.five, 1.56)
  assert.equal(parsed.fifteen, 1.37)
  assert.equal(parsed.running, 1)
  assert.equal(parsed.total, 577)
})

test('parseLoadavg 遇到空串不抛，给 0', () => {
  const parsed = parseLoadavg('')
  assert.equal(parsed.one, 0)
  assert.equal(parsed.total, 0)
})

test('parseMeminfo 换算成字节并算百分比', () => {
  const text = [
    'MemTotal:       32726712 kB',
    'MemFree:          874508 kB',
    'MemAvailable:   27767408 kB',
    'SwapTotal:       1024000 kB',
    'SwapFree:         512000 kB',
  ].join('\n')
  const parsed = parseMeminfo(text)
  assert.equal(parsed.total, 32726712 * 1024)
  assert.equal(parsed.available, 27767408 * 1024)
  assert.equal(parsed.used, (32726712 - 27767408) * 1024)
  assert.ok(parsed.percent > 15 && parsed.percent < 16)
  assert.equal(parsed.swapTotal, 1024000 * 1024)
})

test('parseMeminfo 没有 MemAvailable 时退回 MemFree', () => {
  const parsed = parseMeminfo('MemTotal: 1000 kB\nMemFree: 400 kB\n')
  assert.equal(parsed.available, 400 * 1024)
  assert.equal(parsed.used, 600 * 1024)
})

test('parseDf 只认带百分比的真实行', () => {
  const text = [
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/nvme0n1p2   982862268 411407620 521454316      45% /',
    'garbage line',
  ].join('\n')
  const rows = parseDf(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mount, '/')
  assert.equal(rows[0].percent, 45)
  assert.equal(rows[0].total, 982862268 * 1024)
})

test('sizeToBytes 认 MB / GB / KiB', () => {
  assert.equal(sizeToBytes('134.5MB'), Math.round(134.5 * 1024 ** 2))
  assert.equal(sizeToBytes('33.51GB'), Math.round(33.51 * 1024 ** 3))
  assert.equal(sizeToBytes('512kB'), 512 * 1024)
  assert.equal(sizeToBytes('1.5GiB'), Math.round(1.5 * 1024 ** 3))
  assert.equal(sizeToBytes(''), 0)
  assert.equal(sizeToBytes('说不清'), 0)
})

test('normalizeStatsRow 把 podman stats 一行摊平', () => {
  const row = normalizeStatsRow({
    id: '4ce25fe1c0d3',
    name: 'catstar-next-smokeping',
    cpu_time: '20.779832s',
    cpu_percent: '0.32%',
    avg_cpu: '0.32%',
    mem_usage: '134.5MB / 33.51GB',
    mem_percent: '0.40%',
    net_io: '0B / 0B',
    block_io: '0B / 0B',
    pids: '59',
  })
  assert.equal(row.name, 'catstar-next-smokeping')
  assert.equal(row.cpuPercent, 0.32)
  assert.equal(row.memPercent, 0.4)
  assert.equal(row.memUsed, Math.round(134.5 * 1024 ** 2))
  assert.equal(row.memLimit, Math.round(33.51 * 1024 ** 3))
  assert.equal(row.pids, 59)
  assert.equal(row.cpuTime, '20.779832s')
})

test('normalizeStatsRow 丢掉没有名字的行', () => {
  assert.equal(normalizeStatsRow({}), null)
  assert.equal(normalizeStatsRow(null), null)
})

test('nodeStats 对没有 stats 的驱动如实说明，不给假数字', async () => {
  const result = await nodeStats({})
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有实现实时占用/)
  assert.deepEqual(result.containers, [])
})

test('nodeStats 把驱动异常收成 reason，不抛', async () => {
  const result = await nodeStats({
    async stats() {
      throw new Error('podman stats 超时了。')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /超时/)
})

test('stats 组装容器占用与宿主负载', async () => {
  const driver = {
    async stats() {
      return [{ name: 'a', cpuPercent: 1 }]
    },
  }
  const result = await stats({
    driver,
    transport: 'local',
    readFileImpl: async (path) => {
      if (path === '/proc/loadavg') return '0.5 0.4 0.3 2/100 1'
      if (path === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n'
      throw new Error('unexpected ' + path)
    },
    exec: async () => ({ code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 40 60 40% /\n' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.containers.length, 1)
  assert.equal(result.host.ok, true)
  assert.equal(result.host.load.one, 0.5)
  assert.equal(result.host.disks[0].percent, 40)
})

test('stats 对远端节点不假装能读宿主负载', async () => {
  const result = await stats({
    driver: { async stats() { return [] } },
    transport: 'ssh',
  })
  assert.equal(result.host.ok, false)
  assert.match(result.host.reason, /远端/)
})
