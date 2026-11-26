import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * LXC 页三件事：
 * 1. 「＋ 新建」在 LXC 页必须建 LXC 容器（usable 要按 kind 过滤）
 * 2. 两个跳转辅助函数必须住在 Panel 内部 —— 放模块级就是 ReferenceError，点了毫无反应
 * 3. 网络只默认推 NAT（lxcbr0）；别的桥照样可选，但下拉选项不带任何说明后缀，
 *    桥接要自建这件事写成正文说明
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('新建表单只列当前页那一类节点', () => {
  assert.match(CLIENT, /const pageKind = view === 'lxc' \? 'lxc' : 'podman'/)
  assert.match(CLIENT, /const usable = nodes\.filter\(item => item\.available && item\.kind === pageKind\)/)
  assert.ok(!/const usable = nodes\.filter\(item => item\.available\)\n/.test(CLIENT), 'usable 还漏了 kind 过滤')
})

test('新建默认网桥固定 lxcbr0，不再回落到第一块网桥', () => {
  assert.match(CLIENT, /const defaultBridge = 'lxcbr0'/)
  assert.ok(!/bridgeList\.length > 0 \? bridgeList\[0\]\.name/.test(CLIENT), '还会抓 bridgeList[0] 当默认')
})

test('跳转辅助函数必须定义在 Panel 内部（否则 setter 取不到）', () => {
  const panelStart = CLIENT.indexOf('function Panel() {')
  const panelEnd = CLIENT.indexOf('function expiryText', panelStart)
  assert.ok(panelStart > 0 && panelEnd > panelStart, '没找到 Panel 的起止位置')

  for (const name of ['function startCreate()', 'function openNodeNetworks(node)']) {
    const at = CLIENT.indexOf(name)
    assert.ok(at > 0, '找不到 ' + name)
    assert.ok(
      at > panelStart && at < panelEnd,
      name + ' 定义在 Panel 外面（' + at + ' 不在 ' + panelStart + '~' + panelEnd + ' 之间）—— ' +
      '它要用 Panel 里的 useState setter，放外面点下去就是 ReferenceError',
    )
  }
})

test('网桥下拉的选项不带说明后缀，但所有桥仍然列出来', () => {
  // 后缀全部拆掉
  for (const suffix of ['· 默认 NAT', '· 你自己搭的', '· 主网段']) {
    assert.ok(!CLIENT.includes("'" + suffix), '下拉里还留着后缀：' + suffix)
  }
  // 但没有把别的桥过滤掉：非 lxcbr0 的那批照样 map 成 option
  assert.match(
    CLIENT,
    /bridgeList\.filter\(item => item\.name !== 'lxcbr0'\)\.map\(item => h\('option'/,
    '除了 lxcbr0 之外的桥被过滤掉了，应该照常可选',
  )
  // 选项文本是「名字（地址）」
  assert.match(CLIENT, /item\.name \+ \(item\.address \? '（' \+ item\.address \+ '）' : ''\)/)
  // 宿主没启用 lxcbr0 时也要留这一项，否则默认值选不中
  assert.match(CLIENT, /\[h\('option', \{ key: 'lxcbr0', value: 'lxcbr0' \}, 'lxcbr0'\)\]/)
})

test('网络页只列 lxcbr0，并说明桥接要自己建', () => {
  assert.match(CLIENT, /'LXC 的默认网络'/)

  const cardAt = CLIENT.indexOf("'LXC 的默认网络'")
  const cardEnd = CLIENT.indexOf("nat ? '重建 lxcbr0' : '启用 lxcbr0'", cardAt)
  assert.ok(cardAt > 0 && cardEnd > cardAt, '没找到网络卡片这一段')
  const card = CLIENT.slice(cardAt, cardEnd)

  // 段落里不能再出现 br0（先剥掉注释行，注释里提到名字不算展示）
  const cardCode = card.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  // 用词边界：lxcbr0 里也含 "br0" 子串，不能误伤
  assert.ok(!/\bbr0\b/.test(cardCode), '网络页卡片里还提到 br0')

  // 桥接说明必须在
  assert.ok(card.includes('要桥接得自己建桥'), '缺「要桥接得自己建桥」这句话')
  assert.ok(card.includes('插件不会替你在宿主上建桥'), '缺「插件不会替你建桥」的解释')
  assert.ok(card.includes('宿主网络 → 网卡 → ＋ 新建连接'), '缺「去哪建桥」的指引')
})

test('NAT 网桥的按钮文案区分启用与重建', () => {
  assert.match(CLIENT, /nat \? '重建 lxcbr0' : '启用 lxcbr0'/)
})
