import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import { describeToolCall, explainedTools, summarizeArgs } from '../lib/explain.js'

test('读类工具都写明是可撤回的', () => {
  const said = describeToolCall('container_logs', { ref: 'demo' })
  assert.match(said.intent, /demo/)
  assert.equal(said.reversible, 'reversible')
  assert.equal(said.reversibleText, '可撤回')
})

test('删除类明说不可撤回，不给人错觉', () => {
  const said = describeToolCall('container_action', { ref: 'demo', action: 'delete' })
  assert.match(said.intent, /delete demo/)
  assert.equal(said.reversible, 'risky')
  assert.equal(said.reversibleText, '不可撤回')
})

test('同一个工具换个动作，可撤回性跟着变', () => {
  assert.equal(describeToolCall('container_action', { ref: 'demo', action: 'restart' }).reversible, 'reversible')
  assert.equal(describeToolCall('lxc_snapshot', { name: 'unlock', op: 'list' }).reversible, 'reversible')
  assert.equal(describeToolCall('lxc_snapshot', { name: 'unlock', op: 'restore' }).reversible, 'risky')
})

test('危险操作标明「要你在面板确认」，不当成自动执行', () => {
  assert.equal(describeToolCall('container_commit', { ref: 'demo', image: 'local/demo:1' }).reversible, 'needs-confirm')
  assert.equal(describeToolCall('network_host_apply', { op: 'dns', name: 'eth0' }).reversible, 'needs-confirm')
})

test('参数里没给的不替模型补', () => {
  const said = describeToolCall('container_create', {})
  assert.match(said.intent, /未指定/)
})

test('未知工具也不崩，老实写成「调用了 xxx」', () => {
  const said = describeToolCall('weird_tool', { node: 'n1' })
  assert.match(said.intent, /weird_tool/)
  assert.equal(said.reversible, 'needs-confirm')
})

test('参数摘要会截断，不把长 base64 写进审计', () => {
  const long = 'A'.repeat(5000)
  const summary = summarizeArgs({ path: '/etc/hosts', content: long })
  assert.ok(summary.length <= 160)
  assert.match(summary, /path=\/etc\/hosts/)
})

test('参数摘要遇到数组只写条数', () => {
  assert.match(summarizeArgs({ ports: [1, 2, 3] }), /\[3 项\]/)
})

test('所有已注册的工具都要有说明（漏了就补模板）', () => {
  const explained = new Set(explainedTools())
  // 工具清单从源码读，避免手工维护两份
  const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const names = Array.from(source.matchAll(/name: '([a-z_]+)'/g)).map(match => match[1])
  assert.ok(names.length >= 30)
  const missing = names.filter(name => !explained.has(name))
  assert.deepEqual(missing, [], '这些工具还没有说明模板：' + missing.join(', '))
})
