import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertDiagTarget,
  buildDiagnoseScript,
  DIAG_STEPS,
  judgeIfaces,
  parseDiagnoseOutput,
  readDiagnose,
} from '../helper/diagnose.mjs'

test('目标值只允许安全字符（它要拼进 shell 脚本）', () => {
  assert.equal(assertDiagTarget('1.1.1.1'), '1.1.1.1')
  assert.equal(assertDiagTarget('example.com'), 'example.com')
  assert.equal(assertDiagTarget('fd00::1'), 'fd00::1')
  assert.equal(assertDiagTarget(''), '')
  for (const bad of ['a; rm -rf /', '$(id)', 'a b', 'a\'b', 'a|b']) {
    assert.throws(() => assertDiagTarget(bad), /只能由/)
  }
})

test('脚本为每一步都打了标记，缺命令时说话而不是留白', () => {
  const script = buildDiagnoseScript({ host: 'example.com', port: 8443 })
  for (const step of DIAG_STEPS) {
    assert.match(script, new RegExp('@@cm:' + step.id))
    assert.match(script, new RegExp('command -v ' + step.bin))
  }
  assert.match(script, /getent hosts example\.com/)
  assert.match(script, /nc -w 3 example\.com 8443/)
  assert.match(script, /@@cm:end/)
})

test('端口越界或缺失时退回 443，不把怪值塞进命令', () => {
  assert.match(buildDiagnoseScript({ port: 0 }), /nc -w 3 1\.1\.1\.1 443/)
  assert.match(buildDiagnoseScript({ port: 'abc' }), /nc -w 3 1\.1\.1\.1 443/)
  assert.match(buildDiagnoseScript({ port: 70000 }), /nc -w 3 1\.1\.1\.1 443/)
})

test('解析按 @@cm 标记切段，标签用人话', () => {
  const raw = [
    '@@cm:ifaces',
    'lo               UNKNOWN        127.0.0.1/8',
    'eth0             UP             10.0.2.15/24',
    '@@cm:routes',
    'default via 10.0.2.2 dev eth0',
    '@@cm:end',
  ].join('\n')
  const sections = parseDiagnoseOutput(raw)
  assert.equal(sections.length, 2)
  assert.equal(sections[0].id, 'ifaces')
  assert.equal(sections[0].label, '网卡与地址')
  assert.match(sections[0].text, /10\.0\.2\.15/)
  assert.equal(sections[1].id, 'routes')
})

test('没有 default 路由、DNS 指 127.0.0.53、解析失败都会被点出来', () => {
  const sections = [
    { id: 'ifaces', label: '网卡与地址', text: 'eth0 UP 10.0.2.15/24' },
    { id: 'routes', label: '路由表', text: '10.0.2.0/24 dev eth0' },
    { id: 'resolv', label: 'DNS 配置', text: 'nameserver 127.0.0.53' },
    { id: 'resolve', label: '域名解析', text: '' },
    { id: 'tcp', label: 'TCP 连通', text: '连不上 1.1.1.1:443（nc exit 1）' },
  ]
  const { notes } = readDiagnose(sections, { host: '1.1.1.1', port: 443 })
  const text = notes.map(note => note.text).join(' | ')
  assert.match(text, /没有 default/)
  assert.match(text, /127\.0\.0\.53/)
  assert.match(text, /TCP|连 1\.1\.1\.1/)
  assert.ok(notes.every(note => ['ok', 'warn', 'unknown'].includes(note.level)))
})

test('一切正常时不硬造问题', () => {
  const sections = [
    { id: 'ifaces', label: '网卡与地址', text: 'eth0 UP 10.0.2.15/24' },
    { id: 'routes', label: '路由表', text: 'default via 10.0.2.2 dev eth0' },
    { id: 'resolv', label: 'DNS 配置', text: 'nameserver 9.9.9.9' },
    { id: 'resolve', label: '域名解析', text: '93.184.216.34 example.com' },
    { id: 'tcp', label: 'TCP 连通', text: 'Connection to 1.1.1.1 443 port [tcp/https] succeeded!' },
  ]
  const { notes } = readDiagnose(sections, { host: 'example.com', port: 443 })
  assert.equal(notes.filter(note => note.level === 'warn').length, 0, JSON.stringify(notes))
})

test('网卡判读认 ip addr 的 flags，而不是 grep UP/DOWN 字样', () => {
  const real = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN',
    '    inet 127.0.0.1/8 scope host lo',
    '2: eth0@if5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP',
    '    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0',
  ].join('\n')
  const notes = judgeIfaces(real)
  assert.equal(notes.filter(note => note.level === 'warn').length, 0, JSON.stringify(notes))
  assert.match(notes[0].text, /1 块网卡 UP/)

  const down = '2: eth0@if5: <BROADCAST,MULTICAST> mtu 1500 qdisc noqueue state DOWN'
  assert.match(judgeIfaces(down)[0].text, /没联网|不是 UP/)
})

test('BusyBox 的 ip 打了用法说明时不当成故障（这是真踩到的坑）', () => {
  const busybox = [
    'BusyBox v1.37.0 (2025-11-21 22:40:56 UTC) multi-call binary.',
    '',
    'Usage: ip [OPTIONS] address|route|link|tunnel|neigh|rule [ARGS]',
    'OPTIONS := -f[amily] inet|inet6|link | -o[neline]',
    'ip link set IFACE [up|down] [arp on|off]',
  ].join('\n')
  const notes = judgeIfaces(busybox)
  assert.equal(notes[0].level, 'unknown')
  assert.match(notes[0].text, /精简版|认不出来/)
})

test('容器里没有 ip / nc 时给 unknown，不当成故障', () => {
  const sections = [
    { id: 'ifaces', label: '网卡与地址', text: '(容器里没有 ip)' },
    { id: 'tcp', label: 'TCP 连通', text: '(容器里没有 nc)' },
  ]
  const { notes } = readDiagnose(sections, {})
  assert.equal(notes.filter(note => note.level === 'warn').length, 0)
  assert.ok(notes.some(note => note.level === 'unknown' && /nc/.test(note.text)))
})
