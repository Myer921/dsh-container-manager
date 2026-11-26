import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyConnectionPatch,
  backupConnection,
  connectionPatchArgs,
  describeConnectionPatch,
  diagnose,
  firewallSummary,
  hostNetwork,
  normalizeInterface,
  parseAddrJson,
  parseConnectionFields,
  parseNmcliConnections,
  parseNftTables,
  parseResolvConf,
  parseRouteJson,
  parseSsListen,
  parseTerseAll,
  splitList,
  normalizeConnection,
  formatRoute,
  connectionAddArgs,
  createConnection,
  deleteConnection,
  parseNeighbors,
  parseWgDump,
  readWireguardPeers,
  readConnection,
  setConnectionState,
} from '../lib/net.js'

/** 假 exec：按命令名返回预置结果，顺便记录调用。 */
function fakeExec(table, calls = []) {
  return async (file, args) => {
    calls.push([file, ...args])
    const key = [file, ...args].join(' ')
    for (const [pattern, value] of Object.entries(table)) {
      if (key.includes(pattern)) return typeof value === 'function' ? value() : value
    }
    return { code: 127, stdout: '', stderr: 'not found', missing: true }
  }
}

const ok = (stdout) => ({ code: 0, stdout, stderr: '' })

const ADDR_JSON = JSON.stringify([
  {
    ifindex: 2,
    ifname: 'enp125s0f0',
    flags: ['BROADCAST', 'UP'],
    mtu: 1500,
    operstate: 'UP',
    link_type: 'ether',
    address: 'a0:d8:07:75:8a:6c',
    addr_info: [
      { family: 'inet', local: '192.0.2.10', prefixlen: 24, scope: 'global', dynamic: true },
      { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' },
    ],
  },
  {
    ifindex: 3,
    ifname: 'wgjump',
    flags: ['UP'],
    mtu: 1420,
    operstate: 'UNKNOWN',
    link_type: 'none',
    linkinfo: { info_kind: 'wireguard' },
    address: '',
    addr_info: [{ family: 'inet', local: '198.51.100.2', prefixlen: 24, scope: 'global' }],
  },
  {
    ifindex: 4,
    ifname: 'lxcbr0',
    link_type: 'ether',
    linkinfo: { info_kind: 'bridge' },
    operstate: 'DOWN',
    mtu: 1500,
    address: '00:16:3e:00:00:00',
    addr_info: [{ family: 'inet', local: '10.0.3.1', prefixlen: 24, scope: 'global' }],
  },
])

test('normalizeInterface：类型、地址、动态标记', () => {
  const rows = parseAddrJson(ADDR_JSON)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].name, 'enp125s0f0')
  assert.equal(rows[0].type, 'ethernet')
  assert.equal(rows[0].state, 'up')
  assert.equal(rows[0].addresses[0].address, '192.0.2.10')
  assert.equal(rows[0].addresses[0].dynamic, true)
  // inet6 的 link-local 也留着，界面按 family 自己筛
  assert.equal(rows[0].addresses.length, 2)
  assert.equal(rows[1].type, 'wireguard')
  assert.equal(rows[2].type, 'bridge')
})

test('normalizeInterface：坏数据返回 null 而不是抛', () => {
  assert.equal(normalizeInterface(null), null)
  assert.equal(normalizeInterface({}), null)
  assert.equal(normalizeInterface({ ifname: 'x' }).type, 'ethernet')
})

test('parseAddrJson：不是 JSON 就给空数组', () => {
  assert.deepEqual(parseAddrJson('nope'), [])
  assert.deepEqual(parseAddrJson(''), [])
  assert.deepEqual(parseAddrJson('{"a":1}'), [])
})

test('parseRouteJson：默认路由与直连都在', () => {
  const rows = parseRouteJson(JSON.stringify([
    { dst: 'default', gateway: '192.0.2.1', dev: 'enp125s0f0', protocol: 'dhcp', metric: 100 },
    { dst: '10.0.3.0/24', dev: 'lxcbr0', protocol: 'kernel', scope: 'link', flags: ['linkdown'] },
  ]))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].destination, 'default')
  assert.equal(rows[0].gateway, '192.0.2.1')
  assert.equal(rows[1].gateway, '')
  assert.deepEqual(rows[1].flags, ['linkdown'])
})

test('parseNmcliConnections：名字里带冒号也不切坏', () => {
  const rows = parseNmcliConnections([
    'Ethernet connection 1:enp125s0f0:802-3-ethernet:activated',
    'lo:lo:loopback:activated',
    'Wired connection 1::802-3-ethernet:',
    'odd:name:with:colons:eth9:802-3-ethernet:activated',
  ].join('\n'))
  assert.equal(rows.length, 4)
  assert.equal(rows[0].name, 'Ethernet connection 1')
  assert.equal(rows[0].device, 'enp125s0f0')
  assert.equal(rows[2].device, '')
  assert.equal(rows[2].state, '')
  assert.equal(rows[3].name, 'odd:name:with:colons')
  assert.equal(rows[3].device, 'eth9')
})

test('parseResolvConf：只要 nameserver', () => {
  const servers = parseResolvConf('# x\nnameserver 203.0.113.53\nsearch lan\nnameserver 1.1.1.1\n')
  assert.deepEqual(servers, ['203.0.113.53', '1.1.1.1'])
  assert.deepEqual(parseResolvConf(''), [])
})

test('parseSsListen：端口升序，非法行丢掉', () => {
  const rows = parseSsListen([
    'LISTEN 0 511 127.0.0.1:8791 0.0.0.0:*',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
    'ESTAB 0 0 1.2.3.4:80 5.6.7.8:9',
    'garbage',
  ].join('\n'))
  assert.deepEqual(rows.map(row => row.port), [22, 8791])
  assert.equal(rows[0].address, '0.0.0.0')
})

test('parseNftTables：表 / 链数 / 谁在管', () => {
  const tables = parseNftTables([
    'table ip nat {',
    '\tchain PREROUTING {',
    '\t}',
    '\tchain POSTROUTING {',
    '\t}',
    '}',
    'table inet lxc {',
    '\tchain input {',
    '\t}',
    '}',
    '# Warning: table ip filter is managed by iptables-nft, do not touch!',
  ].join('\n'))
  assert.equal(tables.length, 2)
  assert.equal(tables[0].family, 'ip')
  assert.equal(tables[0].name, 'nat')
  assert.equal(tables[0].chains, 2)
  assert.equal(tables[1].chains, 1)
  // 告警行里的名字对不上表名，不会被误挂
  assert.equal(tables[0].managedBy, '')
})

test('parseConnectionFields：按下标对，空行也是空值', () => {
  const fields = parseConnectionFields([
    'Ethernet connection 1',
    '60c2c4a0-1111-2222-3333-444444444444',
    'yes',
    'enp125s0f0',
    'auto',
    '',
    '',
    '203.0.113.53',
    'no',
    'auto',
    '',
    '',
    '1500',
  ].join('\n'))
  assert.equal(fields['connection.id'], 'Ethernet connection 1')
  assert.equal(fields['ipv4.method'], 'auto')
  assert.equal(fields['ipv4.dns'], '203.0.113.53')
  assert.equal(fields['802-3-ethernet.mtu'], '1500')
})

test('connectionPatchArgs：只翻有值的项', () => {
  assert.deepEqual(connectionPatchArgs({}), [])
  assert.deepEqual(
    connectionPatchArgs({ method: 'manual', addresses: ['10.0.0.5/24'], gateway: '10.0.0.1' }),
    ['ipv4.method', 'manual', 'ipv4.addresses', '10.0.0.5/24', 'ipv4.gateway', '10.0.0.1'],
  )
  assert.deepEqual(connectionPatchArgs({ dns: ['1.1.1.1', '8.8.8.8'] }), ['ipv4.dns', '1.1.1.1 8.8.8.8'])
  assert.deepEqual(connectionPatchArgs({ dns: [] }), ['ipv4.dns', ''])
  assert.deepEqual(connectionPatchArgs({ neverDefault: true }), ['ipv4.never-default', 'yes'])
})

test('describeConnectionPatch：说人话', () => {
  assert.equal(describeConnectionPatch({}), '无改动')
  const text = describeConnectionPatch({ method: 'manual', addresses: ['10.0.0.5/24'], dns: ['1.1.1.1'] })
  assert.match(text, /IPv4 方式改 manual/)
  assert.match(text, /地址 10\.0\.0\.5\/24/)
  assert.match(text, /DNS 1\.1\.1\.1/)
})

test('hostNetwork：一次取齐，全部只读', async () => {
  const calls = []
  const exec = fakeExec({
    'ip -j -d addr show': ok(ADDR_JSON),
    'ip -j route show': ok(JSON.stringify([{ dst: 'default', gateway: '1.2.3.4', dev: 'enp125s0f0' }])),
    'nmcli -t -f NAME,DEVICE,TYPE,STATE con show': ok('Ethernet connection 1:enp125s0f0:802-3-ethernet:activated'),
    'ss -tlnH': ok('LISTEN 0 128 0.0.0.0:22 0.0.0.0:*'),
  }, calls)
  const data = await hostNetwork({
    exec,
    readFile: async () => 'nameserver 203.0.113.53\n',
    readStats: (name) => ({ rxBytes: name === 'enp125s0f0' ? 10 : 0, txBytes: 5 }),
  })
  assert.equal(data.ok, true)
  assert.equal(data.interfaces.length, 3)
  assert.equal(data.interfaces[0].stats.rxBytes, 10)
  assert.equal(data.routes.length, 1)
  assert.deepEqual(data.dns, ['203.0.113.53'])
  assert.equal(data.connections[0].name, 'Ethernet connection 1')
  assert.equal(data.listeners[0].port, 22)
  // 一条写命令都没有
  assert.equal(calls.filter(call => call[0] === 'sudo').length, 0)
})

test('hostNetwork：命令缺失时给空数组，不抛', async () => {
  const exec = fakeExec({})
  const data = await hostNetwork({ exec, readFile: async () => '', readStats: () => ({ rxBytes: 0, txBytes: 0 }) })
  assert.deepEqual(data.interfaces, [])
  assert.deepEqual(data.routes, [])
  assert.deepEqual(data.connections, [])
  assert.deepEqual(data.listeners, [])
})

test('firewallSummary：成功时给表、失败时说清原因', async () => {
  const good = await firewallSummary({
    exec: fakeExec({ 'nft list ruleset': ok('table ip nat {\n\tchain POSTROUTING {\n\t}\n}\n') }),
  })
  assert.equal(good.ok, true)
  assert.equal(good.tables.length, 1)
  assert.match(good.raw, /table ip nat/)

  const denied = await firewallSummary({
    exec: fakeExec({ 'nft list ruleset': { code: 1, stdout: '', stderr: 'sudo: a password is required' } }),
  })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /password/)

  const missing = await firewallSummary({ exec: fakeExec({}) })
  assert.equal(missing.ok, false)

  const slow = await firewallSummary({ exec: fakeExec({ 'nft list ruleset': { timedOut: true, code: null } }) })
  assert.equal(slow.ok, false)
  assert.match(slow.reason, /超时/)
})

test('diagnose：通的、不通的、乱填的都分开', async () => {
  const good = await diagnose('127.0.0.1', {
    count: 2,
    exec: fakeExec({
      'ping -c 2 -W 2 127.0.0.1': ok(
        'PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.\n'
        + '2 packets transmitted, 2 received, 0% packet loss, time 1000ms\n'
        + 'rtt min/avg/max/mdev = 0.021/0.031/0.041/0.010 ms\n',
      ),
    }),
  })
  assert.equal(good.ok, true)
  assert.equal(good.lossPercent, 0)
  assert.equal(good.rtt.avg, 0.031)

  const dead = await diagnose('10.99.99.99', {
    exec: fakeExec({
      'ping': ok('10 packets transmitted, 0 received, 100% packet loss, time 9000ms\n'),
    }),
  })
  assert.equal(dead.ok, false)
  assert.equal(dead.lossPercent, 100)

  const injected = await diagnose('8.8.8.8; rm -rf /', { exec: fakeExec({}) })
  assert.equal(injected.ok, false)
  assert.match(injected.reason, /主机名或 IP/)
})

test('backupConnection：读不到配置就不写文件', async () => {
  const writes = []
  const nothing = await backupConnection('gone', {
    exec: fakeExec({}),
    writeFile: async (file, body) => { writes.push([file, body]) },
    mkdir: async () => {},
    backupDir: '/tmp/x',
  })
  assert.equal(nothing, null)
  assert.equal(writes.length, 0)

  const saved = await backupConnection('Ethernet connection 1', {
    exec: fakeExec({ 'cat /etc/NetworkManager': ok('[connection]\nid=x\n') }),
    writeFile: async (file, body) => { writes.push([file, body]) },
    mkdir: async () => {},
    backupDir: '/tmp/cm-backup',
  })
  assert.match(saved, /^\/tmp\/cm-backup\/backups\/nm-Ethernet_connection_1-\d+\.nmconnection$/)
  assert.equal(writes.length, 1)
  assert.match(writes[0][1], /\[connection\]/)
})

test('readConnection：成功与找不到', async () => {
  const one = await readConnection('Ethernet connection 1', {
    exec: fakeExec({ 'nmcli -g': ok('Ethernet connection 1\nuuid-1\nyes\nenp125s0f0\n') }),
  })
  assert.equal(one.name, 'Ethernet connection 1')
  assert.equal(one.fields['connection.id'], 'Ethernet connection 1')
  assert.equal(one.fields['connection.uuid'], 'uuid-1')
  assert.equal(one.fields['ipv4.method'], '')

  await assert.rejects(
    () => readConnection('nope', { exec: fakeExec({ 'nmcli -g': { code: 10, stdout: '', stderr: '未知的连接' } }) }),
    /未知的连接/,
  )
})

test('applyConnectionPatch：先备份，再 modify + up', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    const key = [file, ...args].join(' ')
    if (key.startsWith('sudo -n cat')) return ok('[connection]\nid=x\n')
    if (key.startsWith('sudo -n nmcli con modify')) return ok('')
    if (key.startsWith('sudo -n nmcli con up')) return ok('Connection successfully activated')
    return { code: 127, stdout: '', stderr: '', missing: true }
  }
  const result = await applyConnectionPatch(
    { name: 'Ethernet connection 1', patch: { dns: ['1.1.1.1'] } },
    { exec, writeFile: async () => {}, mkdir: async () => {}, backupDir: '/tmp/cm-b2' },
  )
  assert.equal(result.activated, true)
  assert.match(result.backup, /nm-Ethernet_connection_1/)
  assert.equal(calls.filter(call => call[4] === 'modify').length, 1)
  assert.equal(calls.filter(call => call[4] === 'up').length, 1)
})

test('applyConnectionPatch：modify 失败时如实报，含 externally 的提示', async () => {
  const exec = async (file, args) => {
    const key = [file, ...args].join(' ')
    if (key.startsWith('sudo -n cat')) return ok('x')
    if (key.startsWith('sudo -n nmcli con modify')) {
      return { code: 1, stdout: '', stderr: 'Error: failed to modify lxcbr0: connection is externally managed.' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    () => applyConnectionPatch(
      { name: 'lxcbr0', patch: { dns: ['1.1.1.1'] } },
      { exec, writeFile: async () => {}, mkdir: async () => {}, backupDir: '/tmp/cm-b3' },
    ),
    (error) => {
      assert.match(error.message, /externally managed/)
      assert.match(error.hint, /externally/)
      return true
    },
  )
})

test('applyConnectionPatch：激活失败自动恢复旧配置', async () => {
  const calls = []
  let upCount = 0
  const exec = async (file, args) => {
    calls.push([file, ...args])
    const key = [file, ...args].join(' ')
    if (key.startsWith('sudo -n cat')) return ok('[connection]\nid=x\n')
    if (key.startsWith('sudo -n nmcli con modify')) return ok('')
    if (key.startsWith('sudo -n install')) return ok('')
    if (key.startsWith('sudo -n nmcli con up')) {
      upCount += 1
      return upCount === 1 ? { code: 1, stdout: '', stderr: 'activation failed' } : ok('restored')
    }
    return { code: 127, stdout: '', stderr: '', missing: true }
  }
  await assert.rejects(
    () => applyConnectionPatch(
      { name: 'Ethernet connection 1', patch: { dns: ['1.1.1.1'] } },
      { exec, writeFile: async () => {}, mkdir: async () => {}, backupDir: '/tmp/cm-b4' },
    ),
    /已恢复旧配置/,
  )
  assert.equal(calls.filter(call => call[2] === 'install').length, 1)
  assert.equal(upCount, 2)
})

test('applyConnectionPatch：空 patch 直接拒，不去动命令', async () => {
  const calls = []
  await assert.rejects(
    () => applyConnectionPatch({ name: 'x', patch: {} }, { exec: fakeExec({}, calls) }),
    /没有要改的项/,
  )
  assert.equal(calls.length, 0)
})

test('setConnectionState：up / down 走对应子命令', async () => {
  const calls = []
  const exec = fakeExec({ 'sudo -n nmcli con': ok('') }, calls)
  await setConnectionState({ name: 'wgjump', up: false }, { exec })
  assert.equal(calls[0].join(' '), 'sudo -n nmcli con down wgjump')
  calls.length = 0
  await setConnectionState({ name: 'wgjump', up: true }, { exec })
  assert.equal(calls[0].join(' '), 'sudo -n nmcli con up wgjump')
})

/* ───────────────── 连接管理 ───────────────── */

test('parseTerseAll：值里的冒号（IPv6）留在值里', () => {
  const map = parseTerseAll([
    'connection.id:eth0',
    'ipv4.addresses:10.0.0.5/24',
    'ipv6.addresses:fd00::5/64',
    'wireguard.private-key:<hidden>',
  ].join('\n'))
  assert.equal(map['connection.id'], 'eth0')
  assert.equal(map['ipv6.addresses'], 'fd00::5/64')
  assert.equal(map['wireguard.private-key'], '<hidden>')
})

test('splitList：逗号切，去空', () => {
  assert.deepEqual(splitList('10.0.0.1/24, 10.0.0.2/24'), ['10.0.0.1/24', '10.0.0.2/24'])
  assert.deepEqual(splitList(''), [])
  assert.deepEqual(splitList(' , '), [])
})

test('normalizeConnection：IPv4 / IPv6 / 设备项全解析', () => {
  const conn = normalizeConnection({
    'connection.id': 'br-lab',
    'connection.type': 'bridge',
    'connection.interface-name': 'br-lab',
    'connection.autoconnect': 'yes',
    'connection.autoconnect-priority': '10',
    'connection.zone': 'public',
    'ipv4.method': 'manual',
    'ipv4.addresses': '10.99.0.1/24',
    'ipv4.gateway': '10.99.0.254',
    'ipv4.dns': '1.1.1.1 8.8.8.8',
    'ipv4.routes': '10.0.0.0/8 10.99.0.254 100',
    'ipv4.never-default': 'yes',
    'ipv6.method': 'auto',
    'ipv6.addresses': 'fd00::1/64',
    '802-3-ethernet.mtu': '1400',
    'bridge.stp': 'yes',
    'bridge.priority': '4096',
  })
  assert.equal(conn.name, 'br-lab')
  assert.equal(conn.type, 'bridge')
  assert.equal(conn.autoconnect, true)
  assert.equal(conn.autoconnectPriority, 10)
  assert.equal(conn.zone, 'public')
  assert.equal(conn.ipv4.method, 'manual')
  assert.deepEqual(conn.ipv4.addresses, ['10.99.0.1/24'])
  assert.deepEqual(conn.ipv4.dns, ['1.1.1.1', '8.8.8.8'])
  assert.equal(conn.ipv4.neverDefault, true)
  assert.deepEqual(conn.ipv6.addresses, ['fd00::1/64'])
  assert.equal(conn.ethernet.mtu, 1400)
  assert.equal(conn.bridge.stp, true)
  assert.equal(conn.bridge.priority, 4096)
})

test('normalizeConnection：WireGuard 对端按下标聚合', () => {
  const conn = normalizeConnection({
    'connection.type': 'wireguard',
    'wireguard.private-key': '<hidden>',
    'wireguard.listen-port': '59211',
    'wireguard.peers[0].public-key': 'PUB1',
    'wireguard.peers[0].endpoint': '1.2.3.4:51820',
    'wireguard.peers[0].allowed-ips': '198.51.100.0/24,203.0.113.0/24',
  })
  assert.equal(conn.wireguard.listenPort, 59211)
  assert.equal(conn.wireguard.peers.length, 1)
  assert.equal(conn.wireguard.peers[0].publicKey, 'PUB1')
  assert.deepEqual(conn.wireguard.peers[0].allowedIps, ['198.51.100.0/24', '203.0.113.0/24'])
})

test('formatRoute：数组与对象都认', () => {
  assert.equal(formatRoute(['10.0.0.0/8', '10.1.1.1', 50]), '10.0.0.0/8 10.1.1.1 50')
  assert.equal(formatRoute(['10.0.0.0/8', '10.1.1.1']), '10.0.0.0/8 10.1.1.1')
  assert.equal(formatRoute({ destination: '10.0.0.0/8', gateway: '10.1.1.1', metric: 50 }), '10.0.0.0/8 10.1.1.1 50')
  assert.equal(formatRoute('10.0.0.0/8 10.1.1.1'), '10.0.0.0/8 10.1.1.1')
})

test('connectionPatchArgs：IPv6 / 路由 / 网桥 / 聚合 / WireGuard', () => {
  assert.deepEqual(
    connectionPatchArgs({ ipv6: { method: 'manual', addresses: ['fd00::1/64'], gateway: 'fd00::ff' } }),
    ['ipv6.method', 'manual', 'ipv6.addresses', 'fd00::1/64', 'ipv6.gateway', 'fd00::ff'],
  )
  assert.deepEqual(
    connectionPatchArgs({ routes: [['10.0.0.0/8', '10.1.1.1', 50]] }),
    ['ipv4.routes', '10.0.0.0/8 10.1.1.1 50'],
  )
  assert.deepEqual(
    connectionPatchArgs({ bridge: { stp: true, priority: 4096 } }),
    ['bridge.stp', 'yes', 'bridge.priority', '4096'],
  )
  assert.deepEqual(
    connectionPatchArgs({ bond: { mode: '802.3ad', miimon: 100 } }),
    ['bond.options', 'mode=802.3ad,miimon=100'],
  )
  assert.deepEqual(
    connectionPatchArgs({ wireguard: { listenPort: 51820 } }),
    ['wireguard.listen-port', '51820'],
  )
  assert.deepEqual(connectionPatchArgs({ zone: 'public' }), ['connection.zone', 'public'])
  assert.deepEqual(connectionPatchArgs({ autoconnectPriority: 5 }), ['connection.autoconnect-priority', '5'])
})

test('connectionAddArgs：各类型该带的参数', () => {
  assert.deepEqual(
    connectionAddArgs({ type: 'bridge', name: 'br-lab', interfaceName: 'br-lab' }),
    ['con', 'add', 'type', 'bridge', 'con-name', 'br-lab', 'ifname', 'br-lab'],
  )
  assert.deepEqual(
    connectionAddArgs({ type: 'vlan', name: 'vlan10', parent: 'enp125s0f0', vlanId: 10 }),
    ['con', 'add', 'type', 'vlan', 'con-name', 'vlan10', 'dev', 'enp125s0f0', 'id', '10'],
  )
  assert.deepEqual(
    connectionAddArgs({ type: 'dummy', name: 'd0' }),
    ['con', 'add', 'type', 'dummy', 'con-name', 'd0', 'ifname', 'd0'],
  )
  assert.throws(() => connectionAddArgs({ type: 'team', name: 'x' }), /不支持的类型/)
  assert.throws(() => connectionAddArgs({ type: 'vlan', name: 'x' }), /parent/)
  assert.throws(() => connectionAddArgs({ type: 'vlan', name: 'x', parent: 'p', vlanId: 9999 }), /1\.\.4094/)
  assert.throws(() => connectionAddArgs({ type: 'bridge' }), /需要连接名/)
})

test('createConnection：add → modify → up 三步', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '))
    const key = [file, ...args].join(' ')
    if (key.includes('con add')) return ok("Connection 'br-lab' (abc-123) successfully added.")
    if (key.includes('con modify')) return ok('')
    if (key.includes('con up')) return ok('Connection successfully activated')
    return { code: 127, stdout: '', stderr: '', missing: true }
  }
  const result = await createConnection({
    type: 'bridge',
    name: 'br-lab',
    interfaceName: 'br-lab',
    patch: { method: 'manual', addresses: ['10.99.0.1/24'] },
  }, { exec })
  assert.equal(result.name, 'br-lab')
  assert.equal(result.activated, true)
  assert.equal(calls.length, 3)
  assert.match(calls[0], /con add type bridge con-name br-lab ifname br-lab/)
  assert.match(calls[1], /con modify br-lab ipv4.method manual ipv4.addresses 10\.99\.0\.1\/24/)
  assert.match(calls[2], /con up br-lab/)
})

test('createConnection：add 失败就说 add 失败', async () => {
  await assert.rejects(
    () => createConnection({ type: 'bridge', name: 'br' }, {
      exec: fakeExec({ 'con add': { code: 1, stdout: '', stderr: 'Error: br already exists.' } }),
    }),
    /already exists/,
  )
})

test('createConnection：IP 配失败要说清连接已经建好了', async () => {
  const exec = async (file, args) => {
    const key = [file, ...args].join(' ')
    if (key.includes('con add')) return ok("Connection 'br-lab' (abc-123) successfully added.")
    if (key.includes('con modify')) return { code: 2, stdout: '', stderr: 'bad address' }
    return ok('')
  }
  await assert.rejects(
    () => createConnection({ type: 'bridge', name: 'br-lab', patch: { addresses: ['oops'] } }, { exec }),
    /连接已创建.*配置 IP 失败.*bad address/,
  )
})

test('deleteConnection：先备份再删', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args].join(' '))
    const key = [file, ...args].join(' ')
    if (key.startsWith('sudo -n cat')) return ok('[connection]\nid=x\n')
    if (key.includes('con delete')) return ok('Connection deleted.')
    return { code: 0, stdout: '', stderr: '' }
  }
  const result = await deleteConnection('br-lab', {
    exec,
    writeFile: async () => {},
    mkdir: async () => {},
    backupDir: '/tmp/cm-del',
  })
  assert.equal(result.deleted, true)
  assert.match(result.backup, /nm-br-lab/)
  assert.ok(calls.some(call => call.includes('con delete')))
})

test('parseNeighbors：状态数组拼成文本', () => {
  const rows = parseNeighbors(JSON.stringify([
    { dst: '192.0.2.1', dev: 'enp125s0f0', lladdr: 'aa:bb:cc:dd:ee:ff', state: ['REACHABLE'] },
    { dst: '192.0.2.99', dev: 'enp125s0f0', state: ['FAILED'] },
    { dst: '' },
  ]))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].mac, 'aa:bb:cc:dd:ee:ff')
  assert.equal(rows[0].state, 'REACHABLE')
  assert.equal(rows[1].mac, '')
})

test('parseWgDump：接口行跳过，对端逐行解析', () => {
  const peers = parseWgDump([
    'privkey\tpubkey\t51820\toff',
    'PEER1\t(none)\t198.51.100.79:51820\t198.51.100.0/24,203.0.113.0/24\t1795250615\t449308\t1663252\t25',
  ].join('\n'))
  assert.equal(peers.length, 1)
  assert.equal(peers[0].publicKey, 'PEER1')
  assert.equal(peers[0].endpoint, '198.51.100.79:51820')
  assert.deepEqual(peers[0].allowedIps, ['198.51.100.0/24', '203.0.113.0/24'])
  assert.equal(peers[0].rxBytes, 449308)
  assert.equal(peers[0].persistentKeepalive, 25)
})

test('readWireguardPeers：wg 不在或失败时如实说', async () => {
  const missing = await readWireguardPeers('wg0', { exec: fakeExec({}) })
  assert.equal(missing.ok, false)
  const denied = await readWireguardPeers('wg0', {
    exec: fakeExec({ 'wg show': { code: 1, stdout: '', stderr: 'Unable to access interface' } }),
  })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /Unable to access/)
})
