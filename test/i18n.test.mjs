import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
let React
let renderToStaticMarkup
try {
  React = req('react')
  ;({ renderToStaticMarkup } = req('react-dom/server'))
} catch {
  const fallback = createRequire('/home/icecat/.dsh-next/profiles/web/package.json')
  React = fallback('react')
  ;({ renderToStaticMarkup } = fallback('react-dom/server'))
}

const captured = {}
globalThis.window = { __ModuleLoader__: { load(spec) { captured.spec = spec } } }
globalThis.document = {
  documentElement: { lang: 'en-US' },
  createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
  head: { appendChild() {} },
}

await import(new URL('../client.js?i18n-en', import.meta.url).href)
const plugin = captured.spec.factory(name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const registered = {}
plugin.apply({
  get(name) {
    return name === 'slots' ? {
      inject(_name, fn) { return fn && fn() },
      register(config, component) { registered[config.name] = component; return { dispose() {} } },
    } : undefined
  },
  effect(fn) { return fn() },
})

test('英文 locale 下主面板导航完成本地化', () => {
  const html = renderToStaticMarkup(React.createElement(registered.main))
  assert.match(html, /Containers/)
  assert.match(html, /Host network/)
  assert.match(html, /Containers/)
  assert.doesNotMatch(html, /容器台/)
})

test('技术标识与未知文案保持原样', () => {
  const html = renderToStaticMarkup(React.createElement(registered.main))
  assert.match(html, /data-cm-page/)
  assert.match(html, /data-cm-nav/)
})
