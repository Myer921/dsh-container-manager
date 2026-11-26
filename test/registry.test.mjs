import test from 'node:test'
import assert from 'node:assert/strict'

import { createNodeRegistry } from '../lib/nodes.js'

/**
 * 回归：v0.3.0 加 LXC 快照时，nodes.js 里新写了一个同名函数 snapshot(nodeId, name, op)，
 * 在 return 对象里把面板用的 snapshot({force}) 覆盖掉了 —— /state 于是永远 409，
 * 前端拿不到 pending 计数，底部「待确认」抽屉根本不渲染。这里钉住两个名字不冲突。
 */
test('registry.snapshot 是面板快照，没有被 LXC 快照覆盖', async () => {
  const configStore = { get: () => ({ nodes: [] }) }
  const registry = createNodeRegistry(configStore, {})

  const snapshot = await registry.snapshot()
  assert.deepEqual(snapshot.nodes, [])
  assert.deepEqual(snapshot.containers, [])
  assert.deepEqual(snapshot.networks, [])
  assert.ok(Array.isArray(snapshot.errors))
  assert.equal(typeof snapshot.at, 'string')

  assert.equal(typeof registry.lxcSnapshot, 'function')
  assert.notEqual(registry.snapshot, registry.lxcSnapshot)
})

test('lxcSnapshot 只对 LXC 节点放行', async () => {
  const configStore = { get: () => ({ nodes: [{ id: 'p', label: 'P', kind: 'podman', transport: 'local' }] }) }
  const registry = createNodeRegistry(configStore, {})

  await assert.rejects(
    () => registry.lxcSnapshot('p', 'demo', 'create'),
    /只对 LXC 容器有意义/,
  )
  await assert.rejects(
    () => registry.lxcSnapshot('nope', 'demo', 'create'),
    /没有这个节点/,
  )
})
