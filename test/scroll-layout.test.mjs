import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 滚动链路：data-cm-page → data-cm-stack → data-cm-detail → data-cm-dbody。
 * 中间任何一层漏了 min-height:0，它就会被内容撑高，
 * 最里层的 overflow:auto 拿不到可滚的高度 —— 表现就是「页面没有滚轮」。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CSS = readFileSync(join(ROOT, 'src/client.css'), 'utf8')

function rule(selector) {
  const at = CSS.indexOf(selector + '{')
  assert.ok(at >= 0, '找不到规则：' + selector)
  const end = CSS.indexOf('}', at)
  assert.ok(end > at, '规则没有闭合：' + selector)
  return CSS.slice(at, end)
}

test('data-cm-detail 必须能收缩，否则整页被内容顶出屏幕', () => {
  const body = rule('[data-cm-detail]')
  assert.match(body, /min-height:0/, '缺 min-height:0 —— flex 子项默认 auto，会被内容撑高')
  assert.match(body, /flex:1/)
  assert.match(body, /flex-direction:column/)
})

test('data-cm-dbody 仍然是内部滚动区', () => {
  const body = rule('[data-cm-dbody]')
  assert.match(body, /overflow:auto/)
  assert.match(body, /min-height:0/)
})

test('data-cm-page 不外漏，滚动条归正文区', () => {
  const body = rule('[data-cm-page]')
  assert.match(body, /height:100%/)
  assert.match(body, /min-height:0/)
  assert.match(body, /overflow:hidden/)
})

test('整份样式表里，带 flex:1 的纵向 flex 容器都写了 min-height:0', () => {
  const css = CSS
  const rules = css.split('}')
  const bad = []
  for (const one of rules) {
    if (!one.includes('flex-direction:column')) continue
    if (!one.includes('flex:1')) continue
    if (one.includes('min-height:0')) continue
    const selector = (one.split('{')[0] || '').trim().split('\n').pop()
    bad.push(selector)
  }
  assert.deepEqual(bad, [], '这些纵向 flex 容器会装滚动区却缺 min-height:0：' + bad.join(', '))
})
