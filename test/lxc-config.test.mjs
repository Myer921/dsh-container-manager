import test from 'node:test'
import assert from 'node:assert/strict'

import { LXC_SETTINGS, readLxcSettings, writeLxcSettings } from '../helper/net-config.mjs'

const SAMPLE = [
  '# Template used to create this container: /usr/share/lxc/templates/lxc-download',
  'lxc.include = /usr/share/lxc/config/alpine.common.conf',
  'lxc.arch = linux64',
  'lxc.apparmor.profile = generated',
  '',
  '# Network configuration',
  'lxc.net.0.type = veth',
  'lxc.net.0.link = lxcbr0',
  'lxc.net.0.flags = up',
  '',
].join('\n')

test('readLxcSettings：没有相关行时给默认值', () => {
  const out = readLxcSettings(SAMPLE)
  assert.equal(out.autostart, false)
  assert.equal(out.oomGroup, false)
  // 空串而不是 undefined：面板直接拿它当 input 的 value
  for (const field of [
    'hostname', 'initCmd', 'capDrop', 'startOrder', 'startDelay',
    'cpuMax', 'cpuWeight', 'memoryMax', 'memoryHigh', 'swapMax', 'cores', 'pidsMax', 'ioWeight',
  ]) {
    assert.equal(out[field], '', field + ' 的默认值应是空串')
  }
})

test('readLxcSettings：读得到 autostart 与内存上限', () => {
  const text = SAMPLE + 'lxc.start.auto = 1\nlxc.cgroup2.memory.max = 268435456\n'
  const out = readLxcSettings(text)
  assert.equal(out.autostart, true)
  assert.equal(out.memoryMax, '268435456')
  const off = SAMPLE + 'lxc.start.auto = 0\n'
  assert.equal(readLxcSettings(off).autostart, false)
})

test('readLxcSettings：cgroup v1 的写法也认', () => {
  const text = SAMPLE + 'lxc.cgroup.memory.limit_in_bytes = 134217728\n'
  assert.equal(readLxcSettings(text).memoryMax, '134217728')
})

test('writeLxcSettings：新增行追加在末尾空行之前，其它行逐字不变', () => {
  const after = writeLxcSettings(SAMPLE, { autostart: true })
  assert.ok(after.includes('lxc.start.auto = 1'))
  const kept = after.split('\n').filter(line => line !== 'lxc.start.auto = 1').join('\n')
  assert.equal(kept, SAMPLE)
  // 追加位置在最后一个非空行之后，不在文件尾部空行之间
  assert.ok(after.indexOf('lxc.start.auto = 1') > after.indexOf('lxc.net.0.flags'))
})

test('writeLxcSettings：已有行就原地替换，不会多出一行', () => {
  const text = SAMPLE + 'lxc.start.auto = 1\n'
  const after = writeLxcSettings(text, { autostart: false })
  assert.equal(after.includes('lxc.start.auto = 0'), true)
  assert.equal(after.includes('lxc.start.auto = 1'), false)
  assert.equal(after.split('\n').filter(line => line.startsWith('lxc.start.auto')).length, 1)
})

test('writeLxcSettings：memoryMax 传空表示删掉那一行', () => {
  const text = SAMPLE + 'lxc.cgroup2.memory.max = 268435456\n'
  const after = writeLxcSettings(text, { memoryMax: '' })
  assert.equal(after.includes('memory.max'), false)
  assert.equal(readLxcSettings(after).memoryMax, '')
})

test('writeLxcSettings：原来用 cgroup v1 就继续用 v1，不叠一行 v2', () => {
  const text = SAMPLE + 'lxc.cgroup.memory.limit_in_bytes = 134217728\n'
  const after = writeLxcSettings(text, { memoryMax: '268435456' })
  assert.ok(after.includes('lxc.cgroup.memory.limit_in_bytes = 268435456'))
  assert.equal(after.includes(LXC_SETTINGS.memoryMax), false)
})

test('writeLxcSettings：写两次结果一样（幂等）', () => {
  const once = writeLxcSettings(SAMPLE, { autostart: true, memoryMax: '268435456' })
  const twice = writeLxcSettings(once, { autostart: true, memoryMax: '268435456' })
  assert.equal(twice, once)
})

test('writeLxcSettings：什么都不传就原样返回', () => {
  assert.equal(writeLxcSettings(SAMPLE, {}), SAMPLE)
})

test('readLxcSettings：读得到 cpuset 与 swap 上限', () => {
  const text = SAMPLE + '\nlxc.cgroup2.cpuset.cpus = 0-3\nlxc.cgroup2.memory.swap.max = 536870912\n'
  const out = readLxcSettings(text)
  assert.equal(out.cores, '0-3')
  assert.equal(out.swapMax, '536870912')
})

test('writeLxcSettings：写 cores 与 swap，传空则删掉那一行', () => {
  const written = writeLxcSettings(SAMPLE, { cores: '0-1', swapMax: '268435456' })
  assert.match(written, /lxc\.cgroup2\.cpuset\.cpus = 0-1/)
  assert.match(written, /lxc\.cgroup2\.memory\.swap\.max = 268435456/)
  const cleared = writeLxcSettings(written, { cores: '', swapMax: '' })
  assert.doesNotMatch(cleared, /cpuset\.cpus/)
  assert.doesNotMatch(cleared, /memory\.swap\.max/)
})

test('readLxcSettings：基本 / 安全 / 扩展资源都能读出来', () => {
  const text = SAMPLE + [
    'lxc.uts.name = DNS',
    'lxc.start.order = 5',
    'lxc.start.delay = 3',
    'lxc.init.cmd = /bin/sh',
    'lxc.cap.drop = sys_module mac_admin',
    'lxc.cgroup2.cpu.max = 50000 100000',
    'lxc.cgroup2.cpu.weight = 200',
    'lxc.cgroup2.memory.high = 402653184',
    'lxc.cgroup2.memory.oom.group = 1',
    'lxc.cgroup2.pids.max = 512',
    'lxc.cgroup2.io.weight = 300',
  ].join('\n')
  const out = readLxcSettings(text)
  assert.equal(out.hostname, 'DNS')
  assert.equal(out.startOrder, '5')
  assert.equal(out.startDelay, '3')
  assert.equal(out.initCmd, '/bin/sh')
  assert.equal(out.capDrop, 'sys_module mac_admin')
  assert.equal(out.cpuMax, '50000 100000')
  assert.equal(out.cpuWeight, '200')
  assert.equal(out.memoryHigh, '402653184')
  assert.equal(out.oomGroup, true)
  assert.equal(out.pidsMax, '512')
  assert.equal(out.ioWeight, '300')
})

test('readLxcSettings：cap.drop 写成多行时合并成一个字符串', () => {
  const text = SAMPLE + 'lxc.cap.drop = sys_module\nlxc.cap.drop = mac_admin\n'
  assert.equal(readLxcSettings(text).capDrop, 'sys_module mac_admin')
})

test('writeLxcSettings：cap.drop 多行旧值会被整个替换，不留残行', () => {
  const before = SAMPLE + 'lxc.cap.drop = sys_module\nlxc.cap.drop = mac_admin\n'
  const after = writeLxcSettings(before, { capDrop: 'sys_time' })
  const drops = after.split('\n').filter(line => line.trim().startsWith('lxc.cap.drop'))
  assert.deepEqual(drops, ['lxc.cap.drop = sys_time'])
})

test('writeLxcSettings：cap.drop 清空时把行删掉', () => {
  const before = SAMPLE + 'lxc.cap.drop = sys_module\n'
  const after = writeLxcSettings(before, { capDrop: '' })
  assert.ok(!after.includes('lxc.cap.drop'))
})

test('writeLxcSettings：每个扩展字段都能写进去并原样读回', () => {
  const patch = {
    hostname: 'web-1', startOrder: '7', startDelay: '2', initCmd: '/sbin/myinit',
    cpuMax: '150000 100000', cpuWeight: '250', memoryHigh: '268435456',
    pidsMax: '1024', ioWeight: '400',
  }
  const after = writeLxcSettings(SAMPLE, patch)
  const back = readLxcSettings(after)
  for (const [field, value] of Object.entries(patch)) {
    assert.equal(back[field], value, field + ' 没写对')
  }
})

test('writeLxcSettings：oom.group 开是 1，关就把行删掉', () => {
  const on = writeLxcSettings(SAMPLE, { oomGroup: true })
  assert.ok(on.includes('lxc.cgroup2.memory.oom.group = 1'))
  const off = writeLxcSettings(on, { oomGroup: false })
  assert.ok(!off.includes('lxc.cgroup2.memory.oom.group'))
})

test('writeLxcSettings：改新字段不碰已有的网络与 include 行', () => {
  const after = writeLxcSettings(SAMPLE, { hostname: 'x', pidsMax: '64' })
  for (const line of SAMPLE.split('\n')) {
    if (!line.trim()) continue
    assert.ok(after.includes(line), '原有行被动了：' + line)
  }
})
