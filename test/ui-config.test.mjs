import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 配置页要能改 LXC 容器该改的一切。
 * 这里只盯「字段有没有接上」，实际生效由 lxc-config / lxc-stats 那两组端着。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

function slice(from, to) {
  const start = CLIENT.indexOf(from)
  assert.ok(start >= 0, '找不到：' + from)
  const end = to === undefined ? CLIENT.length : CLIENT.indexOf(to, start + from.length)
  assert.ok(end > start, '找不到结束标记：' + to)
  return CLIENT.slice(start, end)
}

const PANE = slice('function ConfigPane', '/* ───────────────────────── 新建容器')

test('审计器是对象，不能当函数调', () => {
  // createActions 收到的 audit 只有 .append()，写成 audit({...}) 会在保存时抛
  // 「audit is not a function」，而且只在真正点保存时才暴露。
  const ACTIONS = readFileSync(join(ROOT, 'lib/actions.js'), 'utf8')
  assert.ok(!/\baudit\(\{/.test(ACTIONS), '要写 log({...}) 或 audit.append(...)')
  assert.match(ACTIONS, /function log\(entry\)/, '应该有 log() 这层包装')
})

test('基本字段都接上了', () => {
  for (const [label, field] of [
    ['主机名', 'hostnameText'],
    ['开机自启', 'autostartOn'],
    ['启动顺序', 'startOrderText'],
    ['启动延迟（秒）', 'startDelayText'],
  ]) {
    assert.ok(PANE.includes(label), '少了「' + label + '」')
    assert.ok(PANE.includes(field), '少了状态 ' + field)
  }
})

test('安全相关字段都接上了', () => {
  assert.ok(PANE.includes('init 命令'), '少了 init 命令')
  assert.ok(PANE.includes('initCmdText'))
  assert.ok(PANE.includes('丢弃的 capabilities'), '少了 cap.drop')
  assert.ok(PANE.includes('capDropText'))
})

test('资源字段一个不少', () => {
  for (const [label, field] of [
    ['CPU 绑核', 'coresText'],
    ['CPU 配额（核）', 'cpuQuotaText'],
    ['CPU 权重', 'cpuWeightText'],
    ['内存上限', 'memoryText'],
    ['内存软限', 'memoryHighText'],
    ['swap 上限', 'swapText'],
    ['PID 上限', 'pidsText'],
    ['IO 权重', 'ioWeightText'],
  ]) {
    assert.ok(PANE.includes(label), '少了「' + label + '」')
    assert.ok(PANE.includes(field), '少了状态 ' + field)
  }
  assert.ok(PANE.includes('oomGroupOn'), '少了 OOM 整组开关')
})

test('保存时把上面这些字段真的发出去', () => {
  const basics = slice("async function saveBasics()", 'async function saveResources()')
  for (const field of ['hostname', 'autostart', 'startOrder', 'startDelay', 'initCmd', 'capDrop']) {
    assert.ok(basics.includes(field + ':'), '基本保存少了 ' + field)
  }
  const resources = slice("async function saveResources()", 'return h(')
  for (const field of ['cores', 'cpuQuota', 'cpuWeight', 'memory', 'memoryHigh', 'swap', 'oomGroup', 'pids', 'ioWeight']) {
    assert.ok(resources.includes(field + ':'), '资源保存少了 ' + field)
  }
})

test('cpu.max 的读数换回核数给用户看', () => {
  assert.match(CLIENT, /function cpuQuotaFromMax\(text\) \{/)
  // 50000 / 100000 应该是 0.5 核
  const body = slice('function cpuQuotaFromMax(text)', '// io.weight 读出来是')
  assert.ok(body.includes('quota / period'), '应该拿配额除以周期')
  assert.ok(body.includes('Math.round'), '小数要收一下，别显示 0.30000000000000004')
})

test('io.weight 只认 default 那一档', () => {
  const body = slice('function ioWeightValue(text)', '// 把「现有容器」翻成创建表单的初值')
  assert.ok(body.includes('default'))
  assert.ok(body.includes('match[1]'))
})

test('空的内存上限不能显示成 0', () => {
  const body = slice('function humanBytes(bytes)', 'function cpuQuotaFromMax')
  assert.ok(body.includes("if (bytes === '' || bytes === null || bytes === undefined) return ''"),
    '空值要先挡掉，否则 Number 空串是 0，面板会写 memory.max=0')
})

test('实时读数覆盖全部资源项', () => {
  const line = slice("'cgroup 实时值：cpuset='", ': null,')
  for (const token of ['cpu.max', 'cpu.weight', 'memory.max', 'swap.max', 'pids=', 'io.weight']) {
    assert.ok(line.includes(token), '实时读数少了 ' + token)
  }
})

test('保存结果会区分「立即生效」和「要重启」', () => {
  assert.match(CLIENT, /function describeSave\(result, liveText\)/)
  const body = slice('function describeSave(result, liveText)', 'async function saveBasics()')
  assert.ok(body.includes('restartRequired'), '要把 helper 说的「要重启」转达给用户')
  assert.ok(body.includes('hostnameLive'), '主机名改失败要单独说')
})
