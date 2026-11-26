import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 新建 LXC 表单的地址栏：IPv4 要能 DHCP/静态（含网关），IPv6 要能关闭/DHCPv6/静态。
 * 静态时后端会写进 lxc.net.0.ipv4.* / lxc.net.0.ipv6.*，所以前端得把值原样交上去。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('IPv4 有 DHCP 与静态两档，静态时出地址和网关', () => {
  assert.match(CLIENT, /field\('IPv4', h\('select'/)
  assert.match(CLIENT, /h\('option', \{ value: 'dhcp' \}, 'DHCP'\)/)
  assert.match(CLIENT, /h\('option', \{ value: 'static' \}, '静态'\)/)
  assert.match(CLIENT, /field\('IPv4 地址', h\('input'/)
  assert.match(CLIENT, /field\('IPv4 网关', h\('input'/)
})

test('IPv6 是三档：关闭 / DHCPv6 / 静态', () => {
  assert.match(CLIENT, /field\('IPv6', h\('select'/)
  for (const label of ["'关闭'", "'DHCPv6'", "'静态'"]) {
    assert.ok(CLIENT.includes(label), '缺少选项 ' + label)
  }
  // 默认关闭
  assert.match(CLIENT, /const \[ip6Mode, setIp6Mode\] = React\.useState\(d\.ip6Mode \|\| 'off'\)/)
})

test('IPv6 静态时出地址和网关，DHCPv6 时给一句前提说明', () => {
  assert.match(CLIENT, /field\('IPv6 地址', h\('input'/)
  assert.match(CLIENT, /field\('IPv6 网关', h\('input'/)
  assert.match(CLIENT, /DHCPv6 不在 LXC 配置里写死地址/)
  assert.match(CLIENT, /宿主那边得有 RA 或 DHCPv6 服务/)
})

test('提交时 ipv4 带 gateway、ipv6 带自己的 mode', () => {
  assert.match(CLIENT, /network: \{/)
  assert.match(CLIENT, /ipv4: ipMode === 'static'/)
  assert.match(CLIENT, /\? \{ mode: 'static', address: ipAddress\.trim\(\), gateway: ipGateway\.trim\(\) \}/)
  assert.match(CLIENT, /ipv6: ip6Mode === 'static'/)
  assert.match(CLIENT, /\? \{ mode: 'static', address: ip6Address\.trim\(\), gateway: ip6Gateway\.trim\(\) \}/)
  assert.match(CLIENT, /: \{ mode: ip6Mode \}/)
})

test('不接网络时把 IPv4 / IPv6 两栏一起藏掉', () => {
  // 网桥选 none → 直接返回 null，不留占位的空 div
  assert.match(CLIENT, /lxcNet === 'none'\s*\n\s*\? null\s*\n\s*: field\('IPv4'/)
  // 静态地址/网关两栏也要跟着 none 一起消失
  assert.match(CLIENT, /lxcNet !== 'none' && ipMode === 'static'/)
  assert.match(CLIENT, /lxcNet !== 'none' && ip6Mode === 'static'/)
})
