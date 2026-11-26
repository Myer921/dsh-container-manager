import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * LXC 要有跟 Podman 一样的实时占用。
 *
 * 之前只有 Podman 能显示占用：nodeStats 在驱动没实现 stats() 时直接返回原因，
 * 而 LXC 驱动根本没有这个方法。现在 helper 补了 /lxc/stats（读 cgroup），
 * 驱动补了 stats()，这里把整条链钉住。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = readFileSync(join(ROOT, 'helper/dsh-lxcd.mjs'), 'utf8')
const DRIVER = readFileSync(join(ROOT, 'lib/drivers/lxc.js'), 'utf8')
const STATS = readFileSync(join(ROOT, 'lib/stats.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('helper 有 /lxc/stats 路由', () => {
  assert.match(HELPER, /case '\/lxc\/stats':/)
  assert.match(HELPER, /return send\(res, 200, ok\(await statsAll\(\)\)\)/)
})

test('helper 从 cgroup 读真实的 CPU / 内存 / pids', () => {
  assert.match(HELPER, /function sampleUsage\(name\)/)
  assert.match(HELPER, /'cpu\.stat'/, 'CPU 累计时间来自 cpu.stat')
  assert.match(HELPER, /usage_usec/, 'cgroup v2 的 CPU 累计字段')
  assert.match(HELPER, /'memory\.current'/)
  assert.match(HELPER, /'memory\.max'/)
  assert.match(HELPER, /'pids\.current'/)
})

test('CPU 百分比靠两次采样求差，不是编的', () => {
  assert.match(HELPER, /const first = names\.map\(sampleUsage\)/)
  assert.match(HELPER, /const second = names\.map\(sampleUsage\)/)
  assert.match(HELPER, /spanMs = 220/)
  assert.match(HELPER, /deltaUsec \/ \(spanMs \* 1000\)/, '100% 应等于占满一个核')
})

test('内存没设上限时用宿主总量当分母（和 podman 口径一致）', () => {
  assert.match(HELPER, /function hostMemoryTotal\(\)/)
  assert.match(HELPER, /MemTotal/)
  assert.match(HELPER, /const memLimit = after\.memLimit > 0 \? after\.memLimit : hostTotal/)
})

test('返回字段和前端消费的一一对上', () => {
  // 前端读的是 cpuPercent / cpuTime / memUsed / memLimit / memPercent / pids / netIo
  for (const field of ['name', 'cpuPercent', 'cpuTime', 'memUsed', 'memLimit', 'memPercent', 'pids', 'netIo']) {
    // 简写属性（cpuPercent,）和完整写法（cpuPercent: 0）都算
    assert.match(HELPER, new RegExp('\\s+' + field + '[,:]'), '缺少字段 ' + field)
  }
  // 不编网络吞吐：cgroup v2 不按容器统计，留空让前端显示 '—'
  assert.match(HELPER, /netIo: '',/)
  assert.match(HELPER, /blockIo: '',/)
})

test('driver 调 /lxc/stats 并带 3 秒缓存', () => {
  assert.match(DRIVER, /async function stats\(\{ force = false \} = \{\}\)/)
  assert.match(DRIVER, /call\('\/lxc\/stats'/)
  assert.match(DRIVER, /now - statsCacheAt < 3_000/)
  assert.match(DRIVER, /^\s+stats,$/m, 'stats 要出现在导出的方法表里')
})

test('只有 ssh 才当远端，helper 节点照样读本机 /proc', () => {
  assert.match(STATS, /transport === 'ssh' \? Promise\.resolve/)
  assert.ok(!/transport === 'local' \|\| !transport \? hostLoad/.test(STATS), 'helper 节点不该被当成远端')
})

test('每个节点的占用各取一份，不能只取 podman 那份', () => {
  // 左侧列表是所有节点混排的；以前只对一个 podman 节点取 stats，LXC 行就永远空着。
  assert.match(CLIENT, /function useStats\(nodeIds\)/, 'useStats 应接受多个节点')
  assert.match(CLIENT, /const liveByNode = useStats\(liveNodeIds\)/)
  assert.match(CLIENT, /liveByNode\.get\(node\.id\) \|\| null/, '列表行要按节点取')
  assert.match(CLIENT, /liveByNode\.get\(container\.nodeId\) \|\| null/, '概览卡要按容器所属节点取')
  assert.ok(!/const live = useStats\(liveNodeId\)/.test(CLIENT), '不该只取单个节点')
})
