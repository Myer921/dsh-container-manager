/**
 * 浏览器半的渲染冒烟：在 Node 里把 client.js 自注册脚本跑起来，
 * 用 react-dom/server 渲一遍首屏 —— 抓语法过了但渲染期会炸的那类问题。
 *
 * 依赖宿主 profile 里的 react：这是本机验收入口，不随插件发布。
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

// 插件目录里有本地 react/react-dom 时优先用它；没有就退回宿主 profile 的 react。
// createRequire 要一个「文件」路径当基准；传目录会被当成 noop.js 解析。
const selfRequire = createRequire(import.meta.url)
let React
let renderToStaticMarkup
let hasRenderer = true
try {
  React = selfRequire('react')
  ;({ renderToStaticMarkup } = selfRequire('react-dom/server'))
} catch {
  const PROFILE_ROOT = process.env.CM_PROFILE_ROOT || '/home/icecat/.dsh-next/profiles/web'
  const fallback = createRequire(join(PROFILE_ROOT, 'package.json'))
  React = fallback('react')
  try {
    ;({ renderToStaticMarkup } = fallback('react-dom/server'))
  } catch {
    hasRenderer = false
  }
}

const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured.spec = spec
    },
  },
}
const styles = []
const styleNode = () => {
  const node = {
    setAttribute() {},
    remove() {},
    _text: '',
    get textContent() { return node._text },
    set textContent(value) { node._text = value; styles.push(value) },
  }
  return node
}
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  createElement() { return styleNode() },
  head: { appendChild() {} },
}

await import(new URL('../client.js', import.meta.url).href)

assert.ok(captured.spec, 'client.js 没有向 __ModuleLoader__ 注册')
assert.equal(captured.spec.id, 'dsh-container-manager')

const plugin = captured.spec.factory((name) => {
  if (name === 'react') return React
  throw new Error('没预料到的 require：' + name)
})

const registered = {}
const slots = {
  // 真实的 slots.inject(name, fn) 会把 fn 跑一遍并拿回 disposer。
  inject(name, fn) {
    return typeof fn === 'function' ? fn() : undefined
  },
  register(config, component) {
    registered[config.name] = component
    return { dispose() {} }
  },
}

plugin.apply({
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  effect(fn) {
    return fn()
  },
})

test('主面板首屏能渲染，默认落在 Podman 页的容器子 tab', () => {
  const Panel = registered.main
  assert.equal(typeof Panel, 'function')
  const html = renderToStaticMarkup(React.createElement(Panel))
  assert.ok(html.includes('容器台'), '没有标题')
  // 顶部四段：两套运行时各占一页
  for (const label of ['Podman', 'LXC', '宿主网络', '活动']) {
    assert.ok(html.includes(label), '顶层导航里没有「' + label + '」')
  }
  // Podman 页自己的子 tab
  for (const label of ['项目', '容器', '镜像', '卷', '网络']) {
    assert.ok(html.includes(label), 'Podman 子 tab 里没有「' + label + '」')
  }
  assert.ok(!html.includes('undefined'), '渲染里出现了 undefined')
  assert.ok(!/NaN/.test(html), '渲染里出现了 NaN')
})

test('侧栏图标能渲染', () => {
  const Icon = registered['sidebar.panellist']
  assert.equal(typeof Icon, 'function')
  const html = renderToStaticMarkup(React.createElement(Icon, { size: 18 }))
  assert.ok(html.includes('<svg'), '图标不是 svg')
})

test('样式真的注入了，而且带项目视图的规则', () => {
  assert.ok(styles.length > 0, 'apply 时没注入样式')
  const css = styles.join('\n')
  assert.ok(css.includes('data-cm-projcard'), '样式里没有项目卡片规则')
  assert.ok(css.includes('data-cm-editor'), '样式里没有 YAML 编辑器规则')
})