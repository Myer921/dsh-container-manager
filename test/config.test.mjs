import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfigStore, defaultConfig, mergeConfig } from '../lib/config.js'

function store() {
  process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-config-'))
  return createConfigStore({})
}

test('LXC 默认存储配置可规范化', () => {
  assert.deepEqual(mergeConfig({}).lxcDefaults, { backend: 'loop', diskSize: '8G' })
  assert.deepEqual(mergeConfig({ lxcDefaults: { backend: 'dir', diskSize: '16g' } }).lxcDefaults, { backend: 'dir', diskSize: '16G' })
})

test('默认配置有两个本机节点', () => {
  const config = defaultConfig()
  assert.deepEqual(config.nodes.map(node => node.id), ['local-podman', 'local-lxc'])
  assert.equal(config.confirmRequired, true)
  assert.equal(config.confirmTtlSeconds, 600)
})

test('mergeConfig 丢弃坏节点但保留好的', () => {
  const merged = mergeConfig({
    nodes: [
      { id: 'local-podman', label: '本机 Podman', kind: 'podman', transport: 'local' },
      { id: 'BAD ID', kind: 'podman' },
      { id: 'nope-kind', kind: 'docker' },
      { id: 'remote', kind: 'podman', transport: 'ssh', host: 'example.com', user: 'root', port: 2222 },
      { id: 'lxc-ssh', kind: 'lxc', transport: 'ssh', host: 'x' },
    ],
  })
  assert.deepEqual(merged.nodes.map(node => node.id), ['local-podman', 'remote'])
  assert.equal(merged.nodes[1].port, 2222)
})

test('mergeConfig 兜住 TTL 与坏值', () => {
  const merged = mergeConfig({ confirmTtlSeconds: 5, auditKeepLines: 'nope', logTailDefault: 9999 })
  assert.equal(merged.confirmTtlSeconds, 30)
  assert.equal(merged.auditKeepLines, 2000)
  assert.equal(merged.logTailDefault, 2000)
})

test('createConfigStore：增删节点与持久化', () => {
  const configStore = store()
  assert.equal(configStore.get().nodes.length, 2)

  const added = configStore.addNode({ id: 'remote-1', label: '远端', kind: 'podman', transport: 'ssh', host: '10.0.0.5' })
  assert.equal(added.id, 'remote-1')
  assert.equal(configStore.get().nodes.length, 3)

  assert.throws(() => configStore.addNode({ id: 'remote-1', kind: 'podman', transport: 'ssh', host: 'x' }), /已存在/)
  assert.throws(() => configStore.addNode({ id: 'x', kind: 'podman', transport: 'ssh' }), /不合法/)

  assert.equal(configStore.removeNode('remote-1'), true)
  assert.equal(configStore.get().nodes.length, 2)
  assert.throws(() => configStore.removeNode('local-podman'), /不能删/)
  assert.throws(() => configStore.removeNode('missing'), /没有这个节点/)
})

test('replace 会合并默认值', () => {
  const configStore = store()
  const next = configStore.replace({ confirmTtlSeconds: 120, nodes: [{ id: 'only', kind: 'podman', transport: 'local' }] })
  assert.equal(next.confirmTtlSeconds, 120)
  assert.deepEqual(next.nodes.map(node => node.id), ['only'])
})
