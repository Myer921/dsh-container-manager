import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPodmanDriver,
  normalizeInspect,
  normalizeNetwork,
  normalizePsRow,
} from '../lib/drivers/podman.js'

const PS_ROW = {
  Command: ['/usr/bin/smokeping'],
  CreatedAt: 1763600000,
  Created: '25 hours ago',
  Id: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  Image: 'localhost/catstar-next/smokeping:2.9.0',
  ImageID: 'sha256:1111',
  IsInfra: false,
  Labels: {},
  Mounts: [],
  Names: ['catstar-next-smokeping'],
  Networks: ['podman'],
  Pid: 12345,
  Ports: [{ host_ip: '0.0.0.0', container_port: 80, host_port: 8080, protocol: 'tcp', range: 1 }],
  State: 'running',
  Status: 'Up 25 hours ago',
  Exited: false,
}

const INSPECT = {
  Id: 'abcdef0123456789',
  Name: '/demo',
  State: { Status: 'running', Running: true, Paused: false, Pid: 99, ExitCode: 0, StartedAt: '2026-11-20T00:00:00Z' },
  Config: { Image: 'alpine', Cmd: ['sh'], Env: ['PATH=/usr/bin', 'SECRET=x'], Labels: { a: 'b' } },
  Image: 'sha256:2222',
  ImageName: 'docker.io/library/alpine:3.20',
  Mounts: [{ Type: 'bind', Source: '/tmp/a', Destination: '/data', RW: true }],
  NetworkSettings: {
    Networks: { 'cm-net': { IPAddress: '10.99.0.5', MacAddress: '02:00:00:00:00:05', Gateway: '10.99.0.1', Subnet: '10.99.0.0/24' } },
    Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
  },
  HostConfig: { NetworkMode: 'cm-net', RestartPolicy: { Name: 'always' }, Memory: 268435456 },
}

const NETWORK = {
  name: 'cm-net',
  id: 'net123',
  driver: 'bridge',
  network_interface: 'podman1',
  subnets: [{ subnet: '10.99.0.0/24', gateway: '10.99.0.1' }],
  internal: false,
  dns_enabled: true,
  containers: {
    abc: { name: 'demo', interfaces: { eth0: { ip_addresses: ['10.99.0.5/24'] } } },
  },
}

function fakeExec(routes) {
  const calls = []
  const exec = async (command, args) => {
    calls.push({ command, args: [...args] })
    const line = command + ' ' + args.join(' ')
    for (const [needle, value] of routes) {
      if (line.includes(needle)) {
        return typeof value === 'function' ? value(command, args) : value
      }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
  }
  exec.calls = calls
  return exec
}

function json(value) {
  return { code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, missing: false }
}

test('normalizePsRow：4.3 的 PascalCase', () => {
  const row = normalizePsRow(PS_ROW)
  assert.equal(row.name, 'catstar-next-smokeping')
  assert.equal(row.state, 'running')
  assert.equal(row.ports[0].hostPort, 8080)
  assert.deepEqual(row.networks, ['podman'])
  assert.equal(row.runtime, 'podman')
  // ps 的 State 是字符串，running 布尔值必须自己算出来 —— compose 状态全靠它
  assert.equal(row.running, true)
  assert.equal(row.paused, false)
})

test('normalizePsRow：非 running 的状态不会误判成在跑', () => {
  for (const state of ['exited', 'created', 'paused', 'stopped']) {
    const row = normalizePsRow({ Id: 'abc123def456', State: state, Names: ['x'] })
    assert.equal(row.running, false, state + ' 被误判成 running')
    assert.equal(row.paused, state === 'paused', state + ' 的 paused 不对')
  }
})

test('normalizePsRow：没有名字时退回短 ID', () => {
  const row = normalizePsRow({ Id: 'abcdef0123456789', State: 'exited' })
  assert.equal(row.name, 'abcdef012345')
})

test('normalizeInspect 不泄露 env 值', () => {
  const detail = normalizeInspect(INSPECT)
  assert.equal(detail.name, 'demo')
  assert.equal(detail.running, true)
  assert.deepEqual(detail.envKeys, ['PATH', 'SECRET'])
  assert.equal(detail.ports[0].containerPort, 80)
  assert.equal(detail.networks[0].ip, '10.99.0.5')
  assert.equal(JSON.stringify(detail).includes('SECRET=x'), false)
})

test('normalizeNetwork 摊平子网与成员', () => {
  const network = normalizeNetwork(NETWORK)
  assert.equal(network.subnet, '10.99.0.0/24')
  assert.equal(network.gateway, '10.99.0.1')
  assert.equal(network.containers[0].name, 'demo')
  assert.deepEqual(network.containers[0].ips, ['10.99.0.5/24'])
})

test('driver.info 解析 rootless / 后端', async () => {
  const exec = fakeExec([['podman info', json({ version: { Version: '4.3.1' }, host: { security: { rootless: true }, networkBackend: 'netavark', arch: 'arm64' } })]])
  const driver = createPodmanDriver({ id: 'local-podman', kind: 'podman', transport: 'local' }, { exec })
  const info = await driver.info()
  assert.equal(info.ok, true)
  assert.equal(info.version, '4.3.1')
  assert.equal(info.rootless, true)
  assert.equal(info.networkBackend, 'netavark')
  assert.equal(exec.calls[0].command, 'podman')
})

test('driver.available 在 podman 缺失时给 MISSING_BINARY', async () => {
  const exec = fakeExec([['podman info', { code: null, stdout: '', stderr: 'spawn podman ENOENT', timedOut: false, missing: true }]])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const availability = await driver.available()
  assert.equal(availability.ok, false)
  assert.equal(availability.code, 'MISSING_BINARY')
})

test('listContainers / logs / act 的命令构造', async () => {
  const exec = fakeExec([
    ['podman ps', json([PS_ROW])],
    ['podman logs', { code: 0, stdout: 'out\n', stderr: 'err\n', timedOut: false, missing: false }],
    ['podman stop', { code: 0, stdout: 'demo\n', stderr: '', timedOut: false, missing: false }],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })

  const containers = await driver.listContainers()
  assert.equal(containers.length, 1)

  const logs = await driver.logs('demo', 50)
  assert.match(logs.text, /out/)
  assert.match(logs.text, /err/)

  const stopped = await driver.act('demo', 'stop')
  assert.equal(stopped.action, 'stop')
  const stopCall = exec.calls.find(call => call.args.includes('stop'))
  assert.deepEqual(stopCall.args, ['stop', '-t', '10', 'demo'])

  await assert.rejects(() => driver.act('demo', 'nuke'), /不支持/)
})

test('listContainers 从 inspect 补齐 ps 缺失的网络信息', async () => {
  const exec = fakeExec([
    ['podman ps', json([{ ...PS_ROW, Networks: [] }])],
    ['podman inspect', json([{ ...INSPECT, Id: PS_ROW.Id }])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const containers = await driver.listContainers()
  assert.deepEqual(containers[0].networks, [{
    name: 'cm-net', ip: '10.99.0.5', ip6: '', mac: '02:00:00:00:00:05', gateway: '10.99.0.1', subnet: '10.99.0.0/24',
  }])
  const inspectCall = exec.calls.find(call => call.args[0] === 'inspect')
  assert.deepEqual(inspectCall.args, ['inspect', PS_ROW.Id])
})

test('network create 的 argv 与危险参数', async () => {
  const exec = fakeExec([
    ['podman network create', { code: 0, stdout: 'cm-net\n', stderr: '', timedOut: false, missing: false }],
    ['podman network inspect', json([NETWORK])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.net({ op: 'create', name: 'cm-net', driver: 'bridge', subnet: '10.99.0.0/24', gateway: '10.99.0.1' })
  assert.equal(created.name, 'cm-net')
  const createCall = exec.calls.find(call => call.args.includes('create'))
  assert.deepEqual(createCall.args, ['network', 'create', '--driver', 'bridge', '--subnet', '10.99.0.0/24', '--gateway', '10.99.0.1', 'cm-net'])
})

test('network connect 带 --ip', async () => {
  const exec = fakeExec([['podman network connect', { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }]])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await driver.net({ op: 'connect', name: 'cm-net', container: 'demo', ip: '10.99.0.9' })
  assert.deepEqual(exec.calls[0].args, ['network', 'connect', 'cm-net', 'demo', '--ip', '10.99.0.9'])
})

test('ssh 节点把 podman 命令包给 ssh', async () => {
  const exec = fakeExec([['podman ps', json([PS_ROW])]])
  const driver = createPodmanDriver({
    id: 'remote',
    kind: 'podman',
    transport: 'ssh',
    host: 'build.example',
    user: 'icecat',
    port: 2222,
    identityFile: '/tmp/key',
  }, { exec })
  await driver.listContainers()
  const call = exec.calls[0]
  assert.equal(call.command, 'ssh')
  assert.deepEqual(call.args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', '2222', '-i', '/tmp/key', '--', 'icecat@build.example', 'podman', 'ps', '-a', '--format', 'json'])
})

test('Podman Pod 列表与创建参数', async () => {
  const exec = fakeExec([
    ['podman pod ps', json([{ Id: 'pod1', Name: 'demo', Status: 'Running', NumberOfContainers: 2 }])],
    ['podman pod create', { code: 0, stdout: 'pod2\n', stderr: '', timedOut: false, missing: false }],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const pods = await driver.listPods()
  assert.equal(pods[0].name, 'demo')
  assert.equal(pods[0].containers, 2)
  const created = await driver.createPod({ name: 'demo2', share: 'net,pid', infra: false })
  assert.equal(created.id, 'pod2')
  assert.deepEqual(exec.calls[1].args, ['pod', 'create', '--name', 'demo2', '--share', 'net', '--share', 'pid', '--infra=false'])
})

test('卷备份与恢复走临时容器，不直接把宿主目录塞进 tar', async () => {
  const exec = fakeExec([
    ['podman run', { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await driver.backupVolume('demo-data', '/srv/backups')
  assert.ok(exec.calls[0].args.includes('demo-data:/data:ro'))
  assert.ok(exec.calls[0].args.includes('/srv/backups:/backup'))
  await driver.restoreVolume('/srv/backups/demo.tar.gz', 'demo-data')
  assert.ok(exec.calls[1].args.includes('demo-data:/data'))
  assert.ok(exec.calls[1].args.includes('/srv/backups:/backup:ro'))
})

test('podman 失败时把 stderr 带出来', async () => {
  const exec = fakeExec([['podman network rm', { code: 125, stdout: '', stderr: 'network cm-net is in use', timedOut: false, missing: false }]])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await assert.rejects(() => driver.net({ op: 'remove', name: 'cm-net' }), /in use/)
})

test('create 的 argv 顺序正确', async () => {
  const exec = fakeExec([
    ['podman run', { code: 0, stdout: 'deadbeef\n', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.create({
    name: 'demo',
    image: 'alpine:3.20',
    network: 'none',
    ports: [{ hostPort: 8080, containerPort: 80 }],
    env: { A: '1' },
    command: ['sleep', '5'],
  })
  assert.equal(created.id, 'deadbeef')
  assert.deepEqual(created.warnings, [])
  assert.equal(created.uts, null)
  const argv = exec.calls.find(call => call.args[0] === 'run').args
  assert.deepEqual(argv, [
    'run', '-d', '--label', 'dsh-cm=1',
    '--name', 'demo',
    '--network', 'none',
    '-p', '8080:80/tcp',
    '-e', 'A=1',
    'alpine:3.20',
    'sleep', '5',
  ])
})

test('create 撞 sethostname 时清理半成品并退到 --uts=host', async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push(args)
    if (args[0] === 'container' && args[1] === 'exists') return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
    if (args[0] === 'run') {
      if (!args.includes('--uts')) return { code: 125, stdout: '', stderr: 'crun: sethostname: Operation not permitted: OCI permission denied', timedOut: false, missing: false }
      return { code: 0, stdout: 'cafebabe\n', stderr: '', timedOut: false, missing: false }
    }
    if (args[0] === 'inspect') return json([INSPECT])
    return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
  }
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.create({ name: 'demo', image: 'alpine:3.20', network: 'none', command: ['sleep', '5'] })
  assert.equal(created.uts, 'host')
  assert.equal(created.warnings.length, 1)
  assert.match(created.warnings[0], /sethostname/)
  assert.match(created.warnings[0], /--uts=host/)
  assert.ok(calls.some(args => args[0] === 'rm' && args.includes('demo')), '应该先清掉 created 状态的半成品')
  const runs = calls.filter(args => args[0] === 'run')
  assert.equal(runs.length, 2)
  assert.equal(runs[0].includes('--uts'), false)
  assert.equal(runs[1].includes('--uts'), true)
})

test('create 明确要 host 时不重试', async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push(args)
    if (args[0] === 'run') {
      if (!args.includes('--uts')) return { code: 125, stdout: '', stderr: 'crun: sethostname: Operation not permitted', timedOut: false, missing: false }
      return { code: 0, stdout: 'beef\n', stderr: '', timedOut: false, missing: false }
    }
    if (args[0] === 'inspect') return json([INSPECT])
    return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
  }
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.create({ name: 'demo', image: 'alpine', uts: 'host', command: ['true'] })
  assert.equal(created.id, 'beef')
  assert.equal(calls.filter(args => args[0] === 'run').length, 1)
})
test('create 会把 restart / memory / cpus 带上', async () => {
  const exec = fakeExec([
    ['podman run', { code: 0, stdout: 'deadbeef\n', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await driver.create({ name: 'demo', image: 'alpine', restart: 'unless-stopped', memory: '256m', cpus: 1.5 })
  const argv = exec.calls.find(call => call.args[0] === 'run').args
  assert.deepEqual(argv, [
    'run', '-d', '--label', 'dsh-cm=1',
    '--name', 'demo',
    '--restart', 'unless-stopped',
    '--memory', '256m',
    '--cpus', '1.5',
    'alpine',
  ])
})

test('updateCgroup 走 podman update，并返回生效后的详情', async () => {
  const exec = fakeExec([
    ['podman update', { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT])],
    ['podman exec', { code: 0, stdout: 'memory=268435456\ncpu=150000 100000\npids=max\n', stderr: '', timedOut: false, missing: false }],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const result = await driver.updateCgroup('demo', { memory: '256m', cpus: 1.5 })
  const argv = exec.calls.find(call => call.args[0] === 'update').args
  assert.deepEqual(argv, ['update', '--memory', '256m', '--cpus', '1.5', 'demo'])
  assert.deepEqual(result.applied, { memory: '256m', cpus: 1.5 })
  assert.deepEqual(result.verified, { memory: 268435456, cpus: 1.5 })
  assert.equal(result.detail.name, 'demo')
})

test('updateCgroup 传 restart 直接报错，不落到 podman 命令', async () => {
  const exec = fakeExec([])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await assert.rejects(
    () => driver.updateCgroup('demo', { restart: 'always' }),
    /不支持 --restart/,
  )
  assert.equal(exec.calls.length, 0, '不该执行任何命令')
})

test('updateCgroup 没有可改项时报参数错误', async () => {
  const exec = fakeExec([])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await assert.rejects(() => driver.updateCgroup('demo', {}), /没有要改的限制项/)
})

test('listImages 过滤掉 <none> 并拼出完整引用', async () => {
  const exec = fakeExec([
    ['podman images', json([
      { Repository: 'docker.io/library/alpine', Tag: '3.22' },
      { Repository: '<none>', Tag: '<none>' },
      { Repository: 'localhost/x', Tag: '<none>' },
    ])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const images = await driver.listImages()
  assert.deepEqual(images.map(item => item.reference), ['docker.io/library/alpine:3.22', 'localhost/x:latest'])
})
const INSPECT_NO_LIMIT = { ...INSPECT, HostConfig: { ...INSPECT.HostConfig, Memory: 0 } }

test('updateCgroup 遇到「命令成功但 cgroup 没改」要报错，不许假成功', async () => {
  const exec = fakeExec([
    ['podman update', { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT_NO_LIMIT])],
    ['podman exec', { code: 0, stdout: 'memory=536870912\ncpu=max\npids=max\n', stderr: '', timedOut: false, missing: false }],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  await assert.rejects(
    () => driver.updateCgroup('demo', { memory: '256m' }),
    /memory\.max 没变/,
  )
})

test('create 带 memory 但没真生效时给 warning，而不是装作成功', async () => {
  const exec = fakeExec([
    ['podman run', { code: 0, stdout: 'deadbeef\n', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT_NO_LIMIT])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.create({ name: 'demo', image: 'alpine', memory: '256m' })
  assert.equal(created.warnings.length, 1)
  assert.match(created.warnings[0], /cgroup 没真的设限/)
})

test('create 带 memory 且真生效时不给 warning', async () => {
  const exec = fakeExec([
    ['podman run', { code: 0, stdout: 'deadbeef\n', stderr: '', timedOut: false, missing: false }],
    ['podman inspect', json([INSPECT])],
  ])
  const driver = createPodmanDriver({ id: 'p', kind: 'podman', transport: 'local' }, { exec })
  const created = await driver.create({ name: 'demo', image: 'alpine', memory: '256m' })
  assert.deepEqual(created.warnings, [])
})
