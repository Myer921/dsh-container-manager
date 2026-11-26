import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 已建容器的网络：以前只有一个 JSON 输入框，要懂 lxc.net.* 的字段名才能改。
 * 现在主路径是表单（网桥 / IPv4 / IPv6），原始 JSON 退到「高级」里折叠。
 * 后端接口没变：POST /containers/:node/:name/network，body { nics, restart }，走 pending。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('容器网络编辑有表单：网桥 / IPv4 / IPv6', () => {
  assert.match(CLIENT, /'网络与地址'/)
  assert.match(CLIENT, /field\('网桥', h\('select'/)
  assert.match(CLIENT, /field\('IPv4', h\('select'/)
  assert.match(CLIENT, /field\('IPv6', h\('select'/)
  assert.match(CLIENT, /field\('IPv4 地址'/)
  assert.match(CLIENT, /field\('IPv6 地址'/)
})

test('表单会构造出 helper 认的 nic 结构', () => {
  assert.match(CLIENT, /function nicsFromForm\(\)/)
  assert.match(CLIENT, /const nic = \{ type: 'veth', link: nicLink \}/)
  // 静态才带 ipv4/ipv6，网关可选
  assert.match(CLIENT, /if \(nicIpMode === 'static'\)/)
  assert.match(CLIENT, /if \(nic6Mode === 'static'\)/)
  assert.match(CLIENT, /if \(nicGw\.trim\(\)\) nic\.ipv4\.gateway = nicGw\.trim\(\)/)
})

test('原始 JSON 还在，但退成高级选项', () => {
  assert.match(CLIENT, /直接编辑原始 JSON/)
  assert.match(CLIENT, /收起原始 JSON/)
  assert.match(CLIENT, /const \[nicRawMode, setNicRawMode\] = React\.useState\(false\)/)
  // 多网卡 / macvlan / mtu 这些表单认不全的，读进来时自动开高级
  assert.match(CLIENT, /const exotic = nics\.length > 1 \|\| nics\.some/)
  assert.match(CLIENT, /if \(exotic\) setNicRawMode\(true\)/)
})

test('hwaddr 不能被当成「表单表达不了」—— 否则老容器一进来就进原始模式', () => {
  const line = CLIENT.split('\n').find(one => one.includes('const exotic ='))
  assert.ok(line, '找不到 exotic 判定')
  assert.ok(!line.includes('hwaddr'), 'exotic 条件里还有 hwaddr：有 MAC 的容器会被塞进原始模式，表单改动会被静默丢弃')
})

test('原始模式下表单置灰，两种模式不互相误导', () => {
  assert.match(CLIENT, /h\('fieldset', \{[\s\S]{0,120}disabled: nicRawMode/)
  assert.ok(CLIENT.includes('当前以原始 JSON 为准，上面的字段不参与保存'), '缺模式说明')
})

test('切换模式时双向同步，不会看到旧快照', () => {
  assert.match(CLIENT, /function toggleRawMode\(\)/)
  // 表单 → JSON：用当前表单值生成
  assert.ok(CLIENT.includes('setNicText(JSON.stringify(nicsFromForm(), null, 2))'), '切到 JSON 时没带表单值')
  // JSON → 表单：反解回去
  assert.match(CLIENT, /applyNicToForm\(first\)/)
  assert.ok(CLIENT.includes('JSON 解析失败，先改好再收起来'), '解析失败没有提示')
})

test('保存仍然走原来那条接口，并带 restart', () => {
  // 路径拼的是 /containers/<node>/<name>/network
  assert.ok(
    CLIENT.includes('${encodeURIComponent(container.nodeId)}/') &&
      CLIENT.includes('${encodeURIComponent(container.name)}/network'),
    '保存没走容器网络接口',
  )
  assert.match(CLIENT, /\{ nics, restart: true \}/)
})

test('表单模式下会先挡住明显写错的地址', () => {
  assert.match(CLIENT, /静态 IPv4 要给地址/)
  assert.match(CLIENT, /静态 IPv6 要给地址/)
})
