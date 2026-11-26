import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HelperError,
  normalizeNic,
  parseConfigNet,
  renderNetConfig,
  replaceNetSection,
} from '../helper/net-config.mjs'

const SAMPLE = `# Distribution configuration
lxc.include = /usr/share/lxc/config/debian.common.conf

# Network configuration
lxc.net.0.type = veth
lxc.net.0.link = lxcbr0
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:aa:bb:cc
lxc.net.0.ipv4.address = 10.0.3.10/24
lxc.net.0.ipv4.gateway = 10.0.3.1

# Console
lxc.cgroup2.devices.allow = c 5:1 rwm
`

test('parseConfigNet 读出结构化网卡', () => {
  const nics = parseConfigNet(SAMPLE)
  assert.equal(nics.length, 1)
  assert.equal(nics[0].type, 'veth')
  assert.equal(nics[0].link, 'lxcbr0')
  assert.deepEqual(nics[0].flags, ['up'])
  assert.equal(nics[0].hwaddr, '00:16:3e:aa:bb:cc')
  assert.equal(nics[0].ipv4.address, '10.0.3.10/24')
  assert.equal(nics[0].ipv4.gateway, '10.0.3.1')
})

test('macvlan 网卡解析', () => {
  const text = `lxc.net.0.type = macvlan
lxc.net.0.macvlan.mode = bridge
lxc.net.0.link = enp125s0f0
lxc.net.0.flags = up
`
  const [nic] = parseConfigNet(text)
  assert.equal(nic.type, 'macvlan')
  assert.equal(nic.macvlan.mode, 'bridge')
  assert.equal(nic.link, 'enp125s0f0')
})

test('normalizeNic 校验', () => {
  const veth = normalizeNic({ type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.5/24', gateway: '10.0.3.1' } })
  assert.equal(veth.type, 'veth')
  assert.equal(veth.link, 'lxcbr0')
  assert.equal(veth.ipv4.address, '10.0.3.5/24')
  assert.deepEqual(veth.flags, ['up'])

  assert.throws(() => normalizeNic({ type: 'veth' }), /必须给 link/)
  assert.throws(() => normalizeNic({ type: 'macvlan' }), /必须给 link/)
  assert.throws(() => normalizeNic({ type: 'bogus', link: 'x' }), /只支持/)
  assert.throws(() => normalizeNic({ type: 'veth', link: 'lxcbr0', hwaddr: 'zz:zz' }), /MAC 不合法/)
  assert.throws(() => normalizeNic({ type: 'veth', link: 'lxcbr0', mtu: 10 }), /MTU 不合法/)
  assert.throws(() => normalizeNic({ type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.5' } }), /必须是/)
  assert.throws(() => normalizeNic({ type: 'macvlan', link: 'enp125s0f0', macvlan: { mode: 'weird' } }), /mode 不合法/)
})

test('renderNetConfig → parseConfigNet 往返一致', () => {
  const nics = [
    normalizeNic({ type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.7/24', gateway: '10.0.3.1' } }),
    normalizeNic({ type: 'macvlan', link: 'enp125s0f0', macvlan: { mode: 'bridge' } }),
  ]
  const text = renderNetConfig(nics).join('\n')
  const parsed = parseConfigNet(text)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].link, 'lxcbr0')
  assert.equal(parsed[0].ipv4.address, '10.0.3.7/24')
  assert.equal(parsed[1].type, 'macvlan')
  assert.equal(parsed[1].macvlan.mode, 'bridge')
})

test('replaceNetSection 只动网络段', () => {
  const nics = [normalizeNic({ type: 'veth', link: 'lxcbr0' })]
  const out = replaceNetSection(SAMPLE, nics)
  assert.match(out, /lxc\.include = \/usr\/share\/lxc\/config\/debian\.common\.conf/)
  assert.match(out, /lxc\.cgroup2\.devices\.allow/)
  assert.match(out, /lxc\.net\.0\.type = veth/)
  assert.match(out, /managed by dsh-container-manager/)
  assert.doesNotMatch(out, /00:16:3e:aa:bb:cc/)
  assert.equal(parseConfigNet(out).length, 1)
})

test('HelperError 带 code', () => {
  const error = new HelperError('BAD_ARGS', 'x', 'hint')
  assert.equal(error.code, 'BAD_ARGS')
  assert.equal(error.hint, 'hint')
})
