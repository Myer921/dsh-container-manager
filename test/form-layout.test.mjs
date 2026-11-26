import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 表单排版的三条硬约束：
 * 1. 网格列宽不能太小（不然宽屏会排成十几列，字段挤成一条线）
 * 2. 说明文字必须走 fieldWide 独占整行，不能当普通格子占位
 * 3. 条件字段隐藏时返回 null，不能留空 div 占位（空 div 照样占一格）
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'src/client.template.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src/client.css'), 'utf8')

test('表单网格有合理的列宽与宽度上限', () => {
  const css = CSS.match(/\[data-cm-form\]\{([^}]*)\}/)
  assert.ok(css, '找不到 [data-cm-form] 的样式')
  const body = css[1]
  const minmax = body.match(/minmax\((\d+)px/)
  assert.ok(minmax, '列宽没用 minmax')
  assert.ok(Number(minmax[1]) >= 200, '列宽 ' + minmax[1] + 'px 太窄，宽屏会排成一长条')
  assert.match(body, /max-width:/, '缺 max-width，表单会铺满整个页面')
})

test('分区标题在网格里独占整行', () => {
  const css = CSS.match(/\[data-cm-sec\]\{([^}]*)\}/)
  assert.ok(css, '找不到 [data-cm-sec] 的样式')
  assert.match(css[1], /grid-column:\s*1\s*\/\s*-1/, '分区标题没有跨整行，会挤进一个格子里')
})

test('说明文字全部走 fieldWide，不当普通字段占位', () => {
  // 这两句都是纯说明，必须独占整行
  for (const hint of ['意味着容器直接进这个网段', 'DHCPv6 不在 LXC 配置里写死地址']) {
    const at = CLIENT.indexOf(hint)
    assert.ok(at > 0, '找不到这句说明：' + hint)
    const before = CLIENT.slice(Math.max(0, at - 220), at)
    assert.ok(
      before.includes('fieldWide('),
      '「' + hint + '」没有走 fieldWide，会占掉一个格子把后面的字段顶歪',
    )
  }
})

test('条件字段隐藏时用 null，不留空 div 占位', () => {
  assert.ok(!/\? h\('div', null\)/.test(CLIENT), '还有条件分支返回空 div（会占一格）')
  // 新的写法
  assert.match(CLIENT, /ipMode === 'static'\s*\n\s*\? field\('IPv4 地址'/)
  assert.match(CLIENT, /ip6Mode === 'static'\s*\n\s*\? field\('IPv6 地址'/)
})

test('新建表单分成基本信息 / 网络 / 资源 / 磁盘', () => {
  for (const label of ["sec('基本信息')", "sec('网络')", "sec('资源')", "sec('磁盘')"]) {
    assert.ok(CLIENT.includes(label), '缺少分区 ' + label)
  }
  // Podman 那边也有分区
  assert.ok(CLIENT.includes("sec('端口与挂载')"), 'Podman 表单缺少「端口与挂载」分区')
})

test('操作行会换行，按钮不会被挤出去', () => {
  const css = CSS.match(/\[data-cm-actions\]\{([^}]*)\}/)
  assert.ok(css, '找不到 [data-cm-actions] 的样式')
  assert.match(css[1], /flex-wrap:\s*wrap/, '操作行不会换行')
})
