import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 回归：点终端时整个页面消失 —— 真凶是把容器名当字符串 ref 传给 TerminalPane（React #290）。
 *
 * 修的时候踩过第二个坑：只改签名、没改函数体里的 ref，于是变成
 * ReferenceError: ref is not defined。
 * 所以这里不只 grep 字符串 —— 直接把 TerminalPane 整段源码抽出来，用真 React
 * 渲染一遍：渲染期任何未定义变量都会当场炸出来。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROFILE_ROOT = process.env.CM_PROFILE_ROOT || '/home/icecat/.dsh-next/profiles/web'
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

const selfRequire = createRequire(import.meta.url)
let React
let renderToStaticMarkup
try {
  React = selfRequire('react')
  ;({ renderToStaticMarkup } = selfRequire('react-dom/server'))
} catch {
  const fallback = createRequire(join(PROFILE_ROOT, 'package.json'))
  React = fallback('react')
  ;({ renderToStaticMarkup } = fallback('react-dom/server'))
}

/** 从 client.js 里把某个顶层函数整段抠出来。 */
function extractFunction(name) {
  const marker = '    function ' + name + '('
  const start = CLIENT.indexOf(marker)
  assert.ok(start >= 0, 'client.js 里找不到函数 ' + name)
  const next = CLIENT.indexOf('\n    function ', start + marker.length)
  assert.ok(next > start, name + ' 后面没有别的函数，抽不出来')
  return CLIENT.slice(start, next)
}

test('react-dom 客户端里确实有字符串 ref 的 #290 校验', () => {
  const candidates = [
    join(ROOT, 'node_modules', 'react-dom', 'cjs', 'react-dom.development.js'),
    join(PROFILE_ROOT, 'node_modules', 'react-dom', 'cjs', 'react-dom.development.js'),
    join(ROOT, 'node_modules', 'react-dom', 'cjs', 'react-dom.production.min.js'),
  ]
  let found = ''
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (readFileSync(candidate, 'utf8').includes('Element ref was specified as a string')) {
      found = candidate
      break
    }
  }
  assert.ok(found, 'react-dom 里应当有「Element ref was specified as a string」这条校验（#290）')
})

test('TerminalPane 能真的渲染出来，函数体里没有未定义变量', () => {
  const source = extractFunction('TerminalPane')
  // 只依赖 React 与 h；socket / xterm 全在 effect 里，SSR 不会执行。
  const factory = new Function('React', 'h', source + '\nreturn TerminalPane')
  const TerminalPane = factory(React, React.createElement)
  const html = renderToStaticMarkup(React.createElement(TerminalPane, {
    nodeId: 'local-podman',
    name: 'catstar-next-smokeping',
  }))
  assert.match(html, /data-cm-term/, '应当渲染出终端宿主 div')
  assert.match(html, /catstar-next-smokeping/, '容器名应当显示在状态行里')
})

test('TerminalPane 的 prop 叫 name 不叫 ref', () => {
  assert.match(CLIENT, /function TerminalPane\(\{ nodeId, name \}\)/)
  assert.match(CLIENT, /terminalSocketUrl\(nodeId, name\)/)
  assert.ok(!/ref: selectedContainer\.name/.test(CLIENT), '不该再把容器名当 ref 传进去')
})

test('剩下的 ref 只有 DOM ref 与普通数据对象', () => {
  const refs = CLIENT.match(/\bref:\s*[^,}\n]+/g) ?? []
  assert.ok(refs.length > 0, '至少应该还能找到 DOM ref 那一处')
  for (const line of refs) {
    assert.ok(
      /ref:\s*(hostRef|boxRef)/.test(line) ||
      /ref:\s*(container|created)\.name/.test(line) ||
      /ref:\s*next/.test(line) ||
      /ref:\s*action/.test(line) ||
      // 文件面板：REST 里的字段就叫 ref，值是组件的 name prop —— 数据对象，不是字符串 ref
      /ref:\s*name/.test(line),
      '意外的 ref 用法：' + line,
    )
  }
})

test('tab 内容在子组件里求值，边界才拦得住', () => {
  assert.match(CLIENT, /function TabContent\(\{ render \}\)/)
  assert.match(CLIENT, /h\(TabContent, \{ render: body \}\)/)
})
