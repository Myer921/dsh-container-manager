import test from 'node:test'
import assert from 'node:assert/strict'

import { createPlanner } from '../lib/plan.js'

function fakeRegistry({ inspect = null, inspectError = null, containers = [], mounts = null, driver = {} } = {}) {
  const podmanDriver = {
    listContainers: async () => containers,
    listImages: async () => [],
    ...driver,
  }
  return {
    find: id => ({ id, kind: 'podman', transport: 'local' }),
    driverFor: () => podmanDriver,
    inspect: async () => {
      if (inspectError) throw new Error(inspectError)
      if (!inspect) throw new Error('没有')
      return inspect
    },
    readMounts: async () => mounts,
  }
}

test('删运行中的容器：说清楚会先停、挂载与端口都会交代', async () => {
  const planner = createPlanner({
    registry: fakeRegistry({
      inspect: {
        name: 'demo',
        running: true,
        image: 'nginx:latest',
        labels: {},
        networks: [{ name: 'br0' }, { name: 'podman' }],
        mounts: [
          { type: 'volume', source: 'demo_data', destination: '/data', rw: true },
          { type: 'bind', source: '/srv/conf', destination: '/etc/nginx/conf.d', rw: false },
        ],
        ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
      },
    }),
  })
  const plan = await planner.describe({ node: 'local-podman', kind: 'container.action', target: 'demo', action: 'delete' })
  const text = plan.items.map(item => item.text).join('\n')
  assert.match(text, /会先发停止信号/)
  assert.match(text, /卷 demo_data/)
  assert.match(text, /腾出宿主端口：8080\/tcp/)
  assert.match(text, /br0/)
  assert.equal(plan.blockers.length, 0)
})

test('compose 管的容器会提醒「删了会被重建」', async () => {
  const planner = createPlanner({
    registry: fakeRegistry({
      inspect: {
        name: 'web', running: false, image: 'x', networks: [], mounts: [], ports: [],
        labels: { 'com.docker.compose.project': 'shop' },
      },
    }),
  })
  const plan = await planner.describe({ node: 'local-podman', kind: 'container.action', target: 'web', action: 'delete' })
  const warn = plan.items.filter(item => item.tone === 'warn').map(item => item.text).join(' ')
  assert.match(warn, /compose 项目 shop/)
  assert.match(warn, /重建/)
})

test('删卷时有人挂着就变成 blocker，不让人盲点', async () => {
  const planner = createPlanner({
    registry: fakeRegistry({ driver: { volumeUsage: async () => ['a', 'b'] } }),
  })
  const plan = await planner.describe({ node: 'local-podman', kind: 'volume.delete', target: 'data', args: { name: 'data' } })
  assert.equal(plan.blockers.length, 1)
  assert.match(plan.blockers[0], /a、b/)
})

test('探不到就说探不到，不写成「没人用」', async () => {
  const planner = createPlanner({ registry: fakeRegistry({}) })
  const plan = await planner.describe({ node: 'local-podman', kind: 'volume.delete', target: 'data', args: { name: 'data' } })
  assert.equal(plan.blockers.length, 0)
  assert.match(plan.items.map(item => item.text).join(' '), /没能确认/)
})

test('容器详情读不到不是错误，是一条 warn', async () => {
  const planner = createPlanner({ registry: fakeRegistry({ inspectError: '节点连不上' }) })
  const plan = await planner.describe({ node: 'local-podman', kind: 'container.action', target: 'ghost', action: 'delete' })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].tone, 'warn')
  assert.match(plan.items[0].text, /读不到容器详情/)
})

test('compose down 会说出停几个、涉及哪些服务', async () => {
  const planner = createPlanner({
    registry: fakeRegistry({}),
    compose: {
      detail: async () => ({ counts: { running: 2, total: 3 }, services: [{ name: 'web' }, { name: 'db' }] }),
    },
  })
  const plan = await planner.describe({ node: 'compose', kind: 'compose.down', target: 'shop', args: { name: 'shop' } })
  const text = plan.items.map(item => item.text).join(' ')
  assert.match(text, /2 个在跑，共 3 个/)
  assert.match(text, /web、db/)
})

test('网络里还有容器时删网络会被标成 blocker', async () => {
  const planner = createPlanner({
    registry: fakeRegistry({ containers: [{ name: 'a', networks: ['mynet'] }, { name: 'b', networks: ['other'] }] }),
  })
  const plan = await planner.describe({ node: 'local-podman', kind: 'network.operation', target: 'mynet', args: { op: 'remove', name: 'mynet' } })
  assert.equal(plan.blockers.length, 1)
  assert.match(plan.blockers[0], /mynet 里还有 a/)
})

test('没预演方案的种类返回 null，而不是编一份出来', async () => {
  const planner = createPlanner({ registry: fakeRegistry({}) })
  assert.equal(await planner.describe({ node: 'local-podman', kind: 'net.link', target: 'eth0' }), null)
})
