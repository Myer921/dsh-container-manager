import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActions } from '../lib/actions.js'
import { createConfigStore } from '../lib/config.js'
import { createPendingStore } from '../lib/pending.js'

// 网卡 MAC 由 create-spec 缺省自动生成（随机），比较结构时先剥掉它。
const withoutMac = net => { const { hwaddr, hwaddrAuto, ...rest } = net || {}; return rest }


const calls = []
const auditLines = []

const fakeRegistry = {
  async act(node, ref, action) {
    calls.push({ kind: 'act', node, ref, action })
    return { action, ref, output: 'ok' }
  },
  async networkOp(node, op) {
    calls.push({ kind: 'network', node, op })
    return { op: op.op, name: op.name, network: op.name }
  },
  async lxcNetworkSet(node, name, nics, options) {
    calls.push({ kind: 'lxc-net', node, name, nics, options })
    return { name, nics, restarted: options.restart }
  },
  async renameContainer(node, ref, name) {
    calls.push({ kind: 'rename', node, ref, name })
    return { from: ref, to: name }
  },
  async commitContainer(node, ref, image) {
    calls.push({ kind: 'commit', node, ref, image })
    return { container: ref, image, id: 'abc123' }
  },
  async createContainer(node, spec) {
    calls.push({ kind: 'create', node, spec })
    return { nodeId: node, kind: 'podman', name: spec.name ?? 'made-up', id: 'x', state: 'running', warnings: [] }
  },
  async updatePodmanCgroup(node, ref, limits) {
    calls.push({ kind: 'limits', node, ref, limits })
    return { ref, applied: limits }
  },
  async setLxcConfig(node, name, patch) {
    calls.push({ kind: 'lxc-config', node, name, patch })
    return { name, changed: true, settings: { autostart: Boolean(patch.autostart), memoryMax: patch.memoryMax ?? '' } }
  },
}

function setup({ ttlSeconds = 600, confirmRequired = true } = {}) {
  process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-actions-'))
  calls.length = 0
  auditLines.length = 0
  const configStore = createConfigStore({ confirmRequired, confirmTtlSeconds: ttlSeconds })
  const pendings = createPendingStore({ file: join(process.env.DSH_CM_DIR, 'pending.json'), ttlSeconds })
  const audit = {
    append: entry => auditLines.push(entry),
    read: () => auditLines,
  }
  const actions = createActions({ registry: fakeRegistry, configStore, pendings, audit })
  return { actions, pendings, configStore, audit }
}

test('安全动作直接执行并写审计', async () => {
  const { actions } = setup()
  const result = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'start' })
  assert.equal(result.status, 'done')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'start')
  assert.ok(auditLines.some(line => line.action === 'container.start'))
})

test('删除走待确认，不直接执行', async () => {
  const { actions } = setup()
  const result = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
  assert.equal(result.status, 'pending')
  assert.match(result.token, /^cm-/)
  assert.match(result.summary, /删除容器 demo/)
  assert.equal(calls.length, 0)
  assert.ok(auditLines.some(line => line.action === 'pending.begin'))
})

test('确认后执行一次，结果回写', async () => {
  const { actions, pendings } = setup()
  const pending = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
  const done = await actions.confirm(pending.token, { principal: 'panel' })
  assert.equal(done.status, 'done')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'delete')
  assert.equal(done.record.status, 'done')

  const record = pendings.get(pending.token)
  assert.equal(record.status, 'done')
  assert.ok(auditLines.some(line => line.action === 'confirm.container.action'))

  await assert.rejects(() => actions.confirm(pending.token, { principal: 'panel' }), /已经处于 done/)
})

test('确认时执行失败会标 failed 并抛出', async () => {
  const { actions, pendings } = setup()
  const original = fakeRegistry.act
  fakeRegistry.act = async () => { throw new Error('bundle broke') }
  try {
    const pending = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
    await assert.rejects(() => actions.confirm(pending.token, { principal: 'panel' }), /bundle broke/)
    assert.equal(pendings.get(pending.token).status, 'failed')
  } finally {
    fakeRegistry.act = original
  }
})

test('取消后不会再执行', async () => {
  const { actions, pendings } = setup()
  const pending = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
  actions.cancel(pending.token, { principal: 'panel' })
  assert.equal(pendings.get(pending.token).status, 'cancelled')
  await assert.rejects(() => actions.confirm(pending.token, { principal: 'panel' }), /cancelled/)
})

test('网络写操作走待确认，读操作直接执行', async () => {
  const { actions } = setup()
  const read = await actions.networkOperation({ node: 'local-podman', op: { op: 'list' } })
  assert.equal(read.status, 'done')
  assert.equal(calls.length, 1)

  const create = await actions.networkOperation({ node: 'local-podman', op: { op: 'create', name: 'cm-net', subnet: '10.99.0.0/24' } })
  assert.equal(create.status, 'pending')
  assert.match(create.summary, /创建网络 cm-net/)
  assert.equal(calls.length, 1)
})

test('LXC 网卡改动进待确认，摘要带类型', async () => {
  const { actions } = setup()
  const result = await actions.setLxcNetwork({
    node: 'local-lxc',
    name: 'demo-lxc',
    nics: [{ type: 'macvlan', link: 'enp125s0f0' }],
    restart: true,
  })
  assert.equal(result.status, 'pending')
  assert.match(result.summary, /macvlan/)
  assert.match(result.summary, /重启/)
})

test('LXC 的 delete 翻成 destroy 并挂起确认', async () => {
  const { actions } = setup()
  const pending = await actions.containerAction({ node: 'local-lxc', ref: 'demo-lxc', action: 'delete' })
  assert.equal(pending.status, 'pending')
  assert.match(pending.summary, /删除容器 demo-lxc/)
  assert.equal(calls.length, 0, '挂起阶段不能真的执行')

  const done = await actions.confirm(pending.token, { principal: 'panel' })
  assert.equal(done.status, 'done')
  assert.equal(calls.at(-1).kind, 'act')
  assert.equal(calls.at(-1).action, 'destroy', 'LXC 驱动只认 destroy')
})

test('直接传 destroy 也算危险动作', async () => {
  const { actions } = setup()
  const result = await actions.containerAction({ node: 'local-lxc', ref: 'x', action: 'destroy' })
  assert.equal(result.status, 'pending')
})

test('Podman 收到 freeze/unfreeze 会翻成 pause/unpause（安全动作直接跑）', async () => {
  const { actions } = setup()
  const frozen = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'freeze' })
  assert.equal(frozen.status, 'done')
  assert.equal(calls.at(-1).action, 'pause')
  const thawed = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'unfreeze' })
  assert.equal(thawed.status, 'done')
  assert.equal(calls.at(-1).action, 'unpause')
})

test('confirmRequired=false 时危险动作直接执行', async () => {
  const { actions } = setup({ confirmRequired: false })
  const result = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
  assert.equal(result.status, 'done')
  assert.equal(calls[0].action, 'delete')
})

test('过期的确认被拒绝', async () => {
  const { actions } = setup({ ttlSeconds: 0 })
  const pending = await actions.containerAction({ node: 'local-podman', ref: 'demo', action: 'delete' })
  await assert.rejects(() => actions.confirm(pending.token, { principal: 'panel' }), /过期/)
})
/* ───────────────────────── 创建 / 限制 / 启动项 ───────────────────────── */

test('createContainer 按节点类型分派，并把 spec 归一化后再交下去', async () => {
  const { actions } = setup()
  const podman = await actions.createContainer({
    node: 'local-podman',
    spec: { image: 'alpine:3.22', name: 'demo-9', ports: [{ containerPort: 80 }], restart: 'always' },
  })
  assert.equal(podman.status, 'done')
  const created = calls.find(item => item.kind === 'create')
  assert.equal(created.spec.image, 'alpine:3.22')
  assert.deepEqual(created.spec.ports, [{ hostPort: 80, containerPort: 80, protocol: 'tcp' }])
  assert.equal(created.spec.restart, 'always')
  assert.ok(auditLines.some(line => line.action === 'container.create'))
})

test('createContainer 给 LXC 节点会走 lxc 归一化（默认 debian bookworm arm64）', async () => {
  const { actions } = setup()
  await actions.createContainer({ node: 'local-lxc', spec: { name: 'lxc-9', network: 'lxcbr0' } })
  const created = calls.find(item => item.kind === 'create')
  assert.equal(created.spec.distro, 'debian')
  assert.equal(created.spec.release, 'bookworm')
  assert.equal(created.spec.arch, 'arm64')
  assert.deepEqual(withoutMac(created.spec.network), { type: 'veth', link: 'lxcbr0' })
})

test('createContainer 未知节点直接报错，不调用 registry', async () => {
  const { actions } = setup()
  await assert.rejects(() => actions.createContainer({ node: 'nope', spec: { image: 'alpine' } }), /没有这个节点/)
  assert.equal(calls.length, 0)
})

test('createContainer 参数非法时在调 registry 之前就拒掉', async () => {
  const { actions } = setup()
  await assert.rejects(() => actions.createContainer({ node: 'local-podman', spec: { image: 'alpine', ports: [{ containerPort: 80, protocol: 'sctp' }] } }), /协议只支持/)
  assert.equal(calls.length, 0)
})

test('updatePodmanCgroup 直接执行并写审计', async () => {
  const { actions } = setup()
  const result = await actions.updatePodmanCgroup({ node: 'local-podman', ref: 'demo', limits: { memory: '256m', cpus: 1 } })
  assert.equal(result.status, 'done')
  assert.deepEqual(calls.find(item => item.kind === 'limits').limits, { memory: '256m', cpus: 1 })
  assert.ok(auditLines.some(line => line.action === 'container.limits'))
})

test('updatePodmanCgroup 缺容器名时报错', async () => {
  const { actions } = setup()
  await assert.rejects(() => actions.updatePodmanCgroup({ node: 'local-podman', ref: '', limits: { memory: '1g' } }), /需要容器名/)
})

test('setLxcConfig 走待确认，确认后真的写配置', async () => {
  const { actions, pendings } = setup()
  const pending = await actions.setLxcConfig({ node: 'local-lxc', name: 'lxc-1', patch: { autostart: true, memoryMax: '256m' } })
  assert.equal(pending.status, 'pending')
  assert.match(pending.summary, /开机自启 开/)
  assert.match(pending.summary, /内存上限 256m/)
  assert.equal(calls.some(item => item.kind === 'lxc-config'), false)
  const record = pendings.get(pending.token)
  assert.equal(record.kind, 'lxc.config')
  const done = await actions.confirm(pending.token, { principal: 'panel' })
  assert.equal(done.status, 'done')
  const written = calls.find(item => item.kind === 'lxc-config')
  assert.deepEqual(written.patch, { autostart: true, memoryMax: '256m' })
})

test('setLxcConfig 没有可改项时报错', async () => {
  const { actions } = setup()
  await assert.rejects(() => actions.setLxcConfig({ node: 'local-lxc', name: 'lxc-1', patch: {} }), /没有要改的项/)
})

test('改名直接执行，不走待确认', async () => {
  const { actions } = setup()
  const result = await actions.renameContainer({ node: 'local-podman', ref: 'old', name: 'fresh' })
  assert.equal(result.status, 'done')
  assert.equal(result.to, 'fresh')
  assert.ok(calls.some(item => item.kind === 'rename' && item.name === 'fresh'))
})

test('改名拒绝空名字与同名', async () => {
  const { actions } = setup()
  await assert.rejects(() => actions.renameContainer({ node: 'local-podman', ref: 'old', name: '   ' }), /新名字不能为空/)
  await assert.rejects(() => actions.renameContainer({ node: 'local-podman', ref: 'old', name: 'old' }), /新旧名字一样/)
})

test('提交镜像先挂起，摘要写清代价', async () => {
  const { actions, pendings } = setup()
  const pending = await actions.commitContainer({ node: 'local-podman', ref: 'demo', image: 'local/demo:1' })
  assert.equal(pending.status, 'pending')
  assert.match(pending.summary, /整层复制/)
  assert.equal(calls.some(item => item.kind === 'commit'), false)
  const record = pendings.get(pending.token)
  assert.equal(record.kind, 'container.commit')
})

test('确认之后提交真的执行', async () => {
  const { actions } = setup()
  const pending = await actions.commitContainer({ node: 'local-podman', ref: 'demo', image: 'local/demo:1' })
  const done = await actions.confirm(pending.token, { principal: 'panel' })
  assert.equal(done.status, 'done')
  const written = calls.find(item => item.kind === 'commit')
  assert.equal(written.image, 'local/demo:1')
})


test('改宿主网络连接：默认先挂起，等人点', async () => {
  const { actions, pendings } = setup({ confirmRequired: true })
  const result = await actions.applyNetworkConnection({
    name: 'Ethernet connection 1',
    patch: { dns: ['1.1.1.1', '8.8.8.8'] },
    principal: 'ai',
  })
  assert.equal(result.status, 'pending')
  assert.ok(result.token, '必须给 token')
  assert.match(result.message, /Ethernet connection 1/)
  assert.match(result.message, /DNS 1\.1\.1\.1/)
  assert.match(result.message, /断/, '摘要要说清会断网')
  const record = pendings.get(result.token)
  assert.equal(record.kind, 'net.connection')
  assert.equal(record.node, 'host')
  assert.deepEqual(record.args.patch, { dns: ['1.1.1.1', '8.8.8.8'] })
})

test('改宿主网络连接：空 patch 直接拒，不留待确认', async () => {
  const { actions, pendings } = setup({ confirmRequired: true })
  await assert.rejects(
    () => actions.applyNetworkConnection({ name: 'x', patch: {}, principal: 'ai' }),
    /没有要改的项/,
  )
  assert.equal(pendings.list().length, 0)
})

test('启停宿主连接：停用时要提醒会断网', async () => {
  const { actions, pendings } = setup({ confirmRequired: true })
  const stopped = await actions.setNetworkLink({ name: 'wgjump', up: false, principal: 'ai' })
  assert.equal(stopped.status, 'pending')
  assert.match(stopped.message, /停用/)
  assert.match(stopped.message, /断网/)
  assert.equal(pendings.get(stopped.token).kind, 'net.link')
  assert.deepEqual(pendings.get(stopped.token).args, { up: false })

  const started = await actions.setNetworkLink({ name: 'wgjump', up: true, principal: 'ai' })
  assert.match(started.message, /启用/)
  assert.ok(!/断网/.test(started.message), '启用不该吓人')
})
