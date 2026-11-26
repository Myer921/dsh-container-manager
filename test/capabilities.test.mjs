import test from 'node:test'
import assert from 'node:assert/strict'

import { createCapabilityProbe } from '../lib/capabilities.js'

const PODMAN_INFO = JSON.stringify({
  version: { Version: '4.3.1' },
  host: {
    security: { rootless: true },
    cgroupManager: 'systemd',
    cgroupVersion: 'v2',
    networkBackend: 'netavark',
    idMappings: { uidmap: [{ container_id: 0, host_id: 1000, size: 1 }], gidmap: [{ container_id: 0, host_id: 1000, size: 1 }] },
  },
  store: { graphDriverName: 'overlay' },
})

function fakeExec(map) {
  const calls = []
  const exec = async (command, args) => {
    calls.push([command, ...(args || [])].join(' '))
    const key = command
    const canned = map[key]
    if (canned === undefined) return { code: 127, stdout: '', stderr: 'not found', missing: true, timedOut: false }
    if (typeof canned === 'function') return canned(args)
    return { code: 0, stdout: canned, stderr: '', missing: false, timedOut: false }
  }
  return { exec, calls }
}

function which(all) {
  return all.map(name => name + '=1').join('\n')
}

test('rootless 且缺 subuid 时报 missing，并给出修复命令', async () => {
  const { exec } = fakeExec({
    '/bin/sh': which(['podman', 'pasta', 'btrfs', 'systemctl', 'loginctl']),
    podman: PODMAN_INFO,
    loginctl: 'Linger=yes\n',
  })
  const probe = createCapabilityProbe({
    exec,
    user: { name: 'icecat', uid: 1000 },
    readFile: file => (file === '/etc/subuid' ? '' : ''),
    exists: () => true,
  })
  const cap = await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  const subid = cap.checks.find(check => check.id === 'subid')
  assert.equal(subid.state, 'missing')
  assert.match(subid.fix, /usermod --add-subuids/)
  const uidmap = cap.checks.find(check => check.id === 'uidmap')
  assert.equal(uidmap.state, 'missing')
  assert.equal(cap.podman.rootless, true)
  assert.equal(cap.podman.graphDriver, 'overlay')
})

test('齐活了就是全 ok，并且给出 LXC 后端选项', async () => {
  const { exec } = fakeExec({
    '/bin/sh': which(['podman', 'newuidmap', 'newgidmap', 'fuse-overlayfs', 'pasta', 'skopeo', 'btrfs', 'zfs', 'systemctl', 'loginctl', 'lxc-export']),
    podman: PODMAN_INFO,
    loginctl: 'Linger=yes\n',
  })
  const probe = createCapabilityProbe({
    exec,
    user: { name: 'icecat', uid: 1000 },
    readFile: file => (file === '/etc/subuid' ? 'icecat:100000:65536\n' : 'icecat:100000:65536\n'),
    exists: () => true,
  })
  const cap = await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  assert.equal(cap.ok, true)
  assert.deepEqual(cap.lxcBackends, ['dir', 'btrfs', 'zfs'])
  assert.equal(cap.checks.find(check => check.id === 'subid').state, 'ok')
  assert.equal(cap.checks.find(check => check.id === 'linger').state, 'ok')
  assert.equal(cap.checks.find(check => check.id === 'storage').state, 'ok')
  assert.equal(cap.checks.find(check => check.id === 'cgroup').state, 'ok')
})

test('没开 linger 是 degraded，vfs 驱动也降级', async () => {
  const info = JSON.stringify({
    version: { Version: '4.3.1' },
    host: { security: { rootless: true }, idMappings: { uidmap: [{ size: 1 }], gidmap: [{ size: 1 }] } },
    store: { graphDriverName: 'vfs' },
  })
  const { exec } = fakeExec({
    '/bin/sh': which(['podman', 'newuidmap', 'newgidmap', 'pasta', 'slirp4netns']),
    podman: info,
    loginctl: 'Linger=no\n',
  })
  const probe = createCapabilityProbe({
    exec,
    user: { name: 'icecat', uid: 1000 },
    readFile: () => 'icecat:100000:65536\n',
    exists: () => true,
  })
  const cap = await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  assert.equal(cap.checks.find(check => check.id === 'linger').state, 'degraded')
  assert.equal(cap.checks.find(check => check.id === 'driver').state, 'degraded')
})

test('60 秒内复用缓存，只探一次', async () => {
  const { exec, calls } = fakeExec({
    '/bin/sh': which(['podman', 'pasta']),
    podman: PODMAN_INFO,
    loginctl: 'Linger=yes\n',
  })
  let clock = 1000
  const probe = createCapabilityProbe({
    exec,
    user: { name: 'icecat', uid: 1000 },
    readFile: () => 'icecat:100000:65536\n',
    exists: () => true,
    now: () => clock,
  })
  await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  const afterFirst = calls.length
  clock += 1000
  await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  assert.equal(calls.length, afterFirst)
  clock += 61_000
  await probe.probe({ id: 'local-podman', kind: 'podman', transport: 'local' })
  assert.ok(calls.length > afterFirst)
})

test('ssh 节点如实说探不到，不假装有结果', async () => {
  const probe = createCapabilityProbe({ exec: async () => ({ code: 0, stdout: '', stderr: '' }) })
  const cap = await probe.probe({ id: 'remote', kind: 'podman', transport: 'ssh', host: '10.0.0.9' })
  assert.equal(cap.ok, false)
  assert.match(cap.reason, /本机/)
  assert.deepEqual(cap.checks, [])
})
