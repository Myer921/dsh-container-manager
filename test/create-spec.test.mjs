import test from 'node:test'
import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'

import {
  LXC_TEMPLATE_SUGGESTIONS,
  normalizeCreate,
  normalizeLxcCreate,
  normalizePodmanCreate,
} from '../lib/create-spec.js'

// 网卡 MAC 由 create-spec 缺省自动生成（随机），比较结构时先剥掉它。
const withoutMac = net => { const { hwaddr, hwaddrAuto, ...rest } = net || {}; return rest }

const image = 'docker.io/library/alpine:3.22'

test('Podman：最小参数就能过，端口缺省 hostPort 等于 containerPort', () => {
  const spec = normalizePodmanCreate({ image, ports: [{ containerPort: 80 }] })
  assert.equal(spec.image, image)
  assert.deepEqual(spec.ports, [{ hostPort: 80, containerPort: 80, protocol: 'tcp' }])
  assert.deepEqual(spec.env, {})
  assert.deepEqual(spec.volumes, [])
  assert.deepEqual(spec.command, [])
  assert.equal(spec.name, undefined)
})

test('Podman：端口协议只认 tcp/udp，重复映射要报错', () => {
  const udp = normalizePodmanCreate({ image, ports: [{ hostPort: 5353, containerPort: 53, protocol: 'UDP' }] })
  assert.equal(udp.ports[0].protocol, 'udp')
  assert.throws(() => normalizePodmanCreate({ image, ports: [{ containerPort: 53, protocol: 'sctp' }] }), /协议只支持 tcp\/udp/)
  assert.throws(
    () => normalizePodmanCreate({ image, ports: [{ hostPort: 8080, containerPort: 80 }, { hostPort: 8080, containerPort: 81 }] }),
    /端口重复/,
  )
})

test('Podman：端口号越界与缺 containerPort 都会被拒', () => {
  assert.throws(() => normalizePodmanCreate({ image, ports: [{ hostPort: 8080 }] }), /containerPort/)
  assert.throws(() => normalizePodmanCreate({ image, ports: [{ containerPort: 70000 }] }), /1\.\.65535/)
  assert.throws(() => normalizePodmanCreate({ image, ports: [{ hostPort: 0, containerPort: 80 }] }), /hostPort/)
})

test('Podman：hostIp 必须是合法 IPv4', () => {
  const spec = normalizePodmanCreate({ image, ports: [{ hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80 }] })
  assert.equal(spec.ports[0].hostIp, '127.0.0.1')
  assert.throws(() => normalizePodmanCreate({ image, ports: [{ hostIp: 'nope', containerPort: 80 }] }), /IPv4/)
})

test('Podman：环境变量键名要合法，值统一成字符串', () => {
  const spec = normalizePodmanCreate({ image, env: { TZ: 'Asia/Shanghai', NUM: 42 } })
  assert.deepEqual(spec.env, { TZ: 'Asia/Shanghai', NUM: '42' })
  assert.throws(() => normalizePodmanCreate({ image, env: { '1BAD': 'x' } }), /环境变量名不合法/)
  assert.throws(() => normalizePodmanCreate({ image, env: { OK: 'x'.repeat(5000) } }), /太长/)
})

test('Podman：挂载拒绝 .. 穿越，目标必须绝对路径', () => {
  const spec = normalizePodmanCreate({ image, volumes: [{ source: '/srv/data', destination: '/data', ro: true }] })
  assert.deepEqual(spec.volumes, [{ source: '/srv/data', destination: '/data', ro: true }])
  assert.throws(() => normalizePodmanCreate({ image, volumes: [{ source: '/srv/../etc', destination: '/data' }] }), /\.\./)
  assert.throws(() => normalizePodmanCreate({ image, volumes: [{ source: '/srv/data', destination: 'data' }] }), /绝对路径/)
  assert.throws(() => normalizePodmanCreate({ image, volumes: [{ source: '/srv/data' }] }), /source 与 destination/)
})

test('Podman：重启策略走白名单', () => {
  assert.equal(normalizePodmanCreate({ image, restart: 'unless-stopped' }).restart, 'unless-stopped')
  assert.equal(normalizePodmanCreate({ image, restart: 'no' }).restart, 'no')
  assert.throws(() => normalizePodmanCreate({ image, restart: 'sometimes' }), /重启策略只支持/)
})

test('Podman：内存格式与 CPU 上界', () => {
  assert.equal(normalizePodmanCreate({ image, memory: '256M' }).memory, '256m')
  assert.throws(() => normalizePodmanCreate({ image, memory: '256 mb' }), /内存上限/)
  assert.equal(normalizePodmanCreate({ image, cpus: 1.5 }).cpus, 1.5)
  assert.throws(() => normalizePodmanCreate({ image, cpus: 0 }), /正数/)
  const ceiling = Math.max(1, availableParallelism()) * 4
  assert.throws(() => normalizePodmanCreate({ image, cpus: ceiling + 1 }), /太大/)
})

test('Podman：镜像与名字非法直接拒', () => {
  assert.throws(() => normalizePodmanCreate({ image: '-bad' }), /镜像/)
  assert.throws(() => normalizePodmanCreate({ image, name: 'a/b' }), /容器名/)
  assert.throws(() => normalizePodmanCreate({}), /镜像/)
})

test('Podman：command 可以是字符串或数组', () => {
  assert.deepEqual(normalizePodmanCreate({ image, command: 'sleep infinity' }).command, ['sleep', 'infinity'])
  assert.deepEqual(normalizePodmanCreate({ image, command: ['sh', '-c', 'true'] }).command, ['sh', '-c', 'true'])
  assert.throws(() => normalizePodmanCreate({ image, command: [''] }), /非空字符串/)
})

test('LXC：默认值是 debian bookworm arm64，默认启动不自启', () => {
  const spec = normalizeLxcCreate({ name: 'web-01' })
  assert.deepEqual(spec, {
    name: 'web-01',
    distro: 'debian',
    release: 'bookworm',
    arch: 'arm64',
    start: true,
    autostart: false,
    backend: 'loop',
    diskSize: '8G',
    network: null,
  })
})

test('LXC：rootfs 后端可选 loop / dir，别的一律拒绝并说清原因', () => {
  assert.equal(normalizeLxcCreate({ name: 'a' }).backend, 'loop')
  const dir = normalizeLxcCreate({ name: 'a', backend: 'dir' })
  assert.equal(dir.backend, 'dir')
  // dir 后端长在宿主文件系统上，diskSize 对它没意义 —— 不许留着误导人
  assert.equal(dir.diskSize, undefined)
  for (const bad of ['btrfs', 'zfs', 'lvm', 'overlayfs']) {
    assert.throws(() => normalizeLxcCreate({ name: 'a', backend: bad }), /只支持 loop 或 dir/)
  }
})

test('LXC：rootfs 默认 8G，可自定义，太小要拒', () => {
  assert.equal(normalizeLxcCreate({ name: 'a' }).diskSize, '8G')
  assert.equal(normalizeLxcCreate({ name: 'a', diskSize: '16G' }).diskSize, '16G')
  assert.equal(normalizeLxcCreate({ name: 'a', diskSize: '512m' }).diskSize, '512M')
  assert.throws(() => normalizeLxcCreate({ name: 'a', diskSize: '100M' }), /太小/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', diskSize: '8T' }), /写 8G/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', diskSize: 'abc' }), /写 8G/)
})

test('LXC：数据盘按 -1、-2 编号，挂载点归一成相对路径', () => {
  const spec = normalizeLxcCreate({ name: 'a', dataDisks: [{ size: '20G', mount: '/data' }, { size: '5G', mount: 'mnt/x/' }] })
  assert.deepEqual(spec.dataDisks, [{ size: '20G', mount: 'data' }, { size: '5G', mount: 'mnt/x' }])
  assert.throws(() => normalizeLxcCreate({ name: 'a', dataDisks: [{ size: '5G' }] }), /挂载点/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', dataDisks: [{ size: '5G', mount: '../etc' }] }), /不能是绝对路径或带/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', dataDisks: 'nope' }), /要是数组/)
  const tooMany = Array.from({ length: 8 }, (_, i) => ({ size: '5G', mount: 'd' + i }))
  assert.throws(() => normalizeLxcCreate({ name: 'a', dataDisks: tooMany }), /最多 7 块/)
})

test('LXC：network 支持 none / 网桥名 / 对象', () => {
  assert.equal(normalizeLxcCreate({ name: 'a', network: 'none' }).network, null)
  assert.deepEqual(normalizeLxcCreate({ name: 'a', network: 'lxcbr0' }).network, { type: 'veth', link: 'lxcbr0' })
  const dhcp = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0' } })
  assert.deepEqual(withoutMac(dhcp.network), { type: 'veth', link: 'lxcbr0' })
  const fixed = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv4: { mode: 'static', address: '10.0.3.200/24' } } })
  assert.deepEqual(withoutMac(fixed.network), { type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.200/24' } })
  // IPv4 网关是可选的，给了才写进去
  const gated = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv4: { mode: 'static', address: '10.0.3.200/24', gateway: '10.0.3.1' } } })
  assert.deepEqual(withoutMac(gated.network), { type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.200/24', gateway: '10.0.3.1' } })
})

test('LXC：IPv6 三态 —— off / dhcp 不写配置，static 才落地址', () => {
  const off = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'off' } } })
  assert.deepEqual(withoutMac(off.network), { type: 'veth', link: 'lxcbr0' })

  const dhcp6 = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'dhcp' } } })
  assert.deepEqual(withoutMac(dhcp6.network), { type: 'veth', link: 'lxcbr0' })
  assert.ok(!('ipv6' in dhcp6.network), 'DHCPv6 不该往 LXC 配置里写 ipv6')

  const fixed6 = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'static', address: '2408:8207::5/64' } } })
  assert.deepEqual(withoutMac(fixed6.network), { type: 'veth', link: 'lxcbr0', ipv6: { address: '2408:8207::5/64' } })

  const gated6 = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'static', address: '2408:8207::5/64', gateway: 'fe80::1' } } })
  assert.deepEqual(withoutMac(gated6.network), { type: 'veth', link: 'lxcbr0', ipv6: { address: '2408:8207::5/64', gateway: 'fe80::1' } })

  // 双栈同时给
  const dual = normalizeLxcCreate({
    name: 'a',
    network: {
      type: 'veth', link: 'lxcbr0',
      ipv4: { mode: 'static', address: '10.0.3.200/24' },
      ipv6: { mode: 'static', address: '2408:8207::5/64' },
    },
  })
  assert.deepEqual(withoutMac(dual.network), {
    type: 'veth', link: 'lxcbr0',
    ipv4: { address: '10.0.3.200/24' },
    ipv6: { address: '2408:8207::5/64' },
  })
})

test('LXC：网卡 MAC 一律写死，不给就生成一个', () => {
  const auto = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0' } })
  assert.match(auto.network.hwaddr, /^00:16:3e:([0-9a-f]{2}:){2}[0-9a-f]{2}$/, '没给 MAC 时应该自动生成一个 00:16:3e 前缀的')

  const given = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', hwaddr: '00:16:3E:AA:BB:CC' } })
  assert.equal(given.network.hwaddr, '00:16:3e:aa:bb:cc', '给了 MAC 要原样用，并转小写')

  assert.throws(
    () => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', hwaddr: '00:16:3e:xx' } }),
    /MAC 地址 不合法/,
  )
})

test('LXC：IPv6 参数写错要报清楚', () => {
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'static' } } }), /静态 IPv6 要给 ipv6\.address/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'static', address: '2408:8207::5' } } }), /前缀长度/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'weird' } } }), /off \/ dhcp \/ static/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv6: { mode: 'static', address: '2408:8207::5/64', gateway: 'not-an-ip' } } }), /IPv6 网关/)
})

test('LXC：网络参数写错要报清楚', () => {
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth' } }), /网桥名/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'macvlan', link: 'eth0' } }), /只支持 veth/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv4: { mode: 'static' } } }), /静态地址/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv4: { mode: 'static', address: '10.0.3.9' } } }), /前缀长度/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', ipv4: { mode: 'weird' } } }), /dhcp \/ static/)
})

test('LXC：发行版/版本/架构白名单', () => {
  assert.throws(() => normalizeLxcCreate({ name: 'a', distro: 'Debian' }), /发行版不合法/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', release: '../x' }), /版本不合法/)
  assert.throws(() => normalizeLxcCreate({ name: 'a', arch: 'sparc' }), /架构只支持/)
  assert.throws(() => normalizeLxcCreate({}), /容器名/)
})

test('LXC：swapMax / cores 会带进 spec，空值不带', () => {
  const s = normalizeLxcCreate({ name: 'a', swap: '512m', cores: '2' })
  assert.equal(s.swapMax, '512m')
  assert.equal(s.cores, '2')
  assert.equal(normalizeLxcCreate({ name: 'a', swapMax: '1g' }).swapMax, '1g')
  assert.equal(normalizeLxcCreate({ name: 'a', cpus: '4' }).cores, '4')
  assert.equal(normalizeLxcCreate({ name: 'a' }).swapMax, undefined)
  assert.equal(normalizeLxcCreate({ name: 'a' }).cores, undefined)
})

test('LXC：cores 只接受正整数，越界/非数字要报错', () => {
  assert.throws(() => normalizeLxcCreate({ name: 'a', cores: '0' }))
  assert.throws(() => normalizeLxcCreate({ name: 'a', cores: '2.5' }))
  assert.throws(() => normalizeLxcCreate({ name: 'a', cores: 'abc' }))
  assert.throws(() => normalizeLxcCreate({ name: 'a', cores: '-1' }))
  assert.throws(() => normalizeLxcCreate({ name: 'a', cores: '99999' }))
})

test('LXC：memoryMax 会带进 spec，空值不带', () => {
  assert.equal(normalizeLxcCreate({ name: 'a', memoryMax: '256m' }).memoryMax, '256m')
  assert.equal(normalizeLxcCreate({ name: 'a', memory: '1g' }).memoryMax, '1g')
  assert.equal(normalizeLxcCreate({ name: 'a' }).memoryMax, undefined)
})

test('normalizeCreate 按 kind 分派，未知 kind 报错', () => {
  assert.equal(normalizeCreate('podman', { image }).image, image)
  assert.equal(normalizeCreate('lxc', { name: 'a' }).distro, 'debian')
  assert.throws(() => normalizeCreate('docker', { image }), /不支持创建容器到这个节点类型/)
})

test('建议清单是一个能直接用的小集合', () => {
  assert.ok(LXC_TEMPLATE_SUGGESTIONS.length >= 4)
  for (const item of LXC_TEMPLATE_SUGGESTIONS) {
    assert.match(item.distro, /^[a-z][a-z0-9.+-]+$/)
    assert.ok(Array.isArray(item.releases) && item.releases.length > 0)
  }
})
