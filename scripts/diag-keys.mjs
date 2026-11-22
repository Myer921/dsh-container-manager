import { createRequire } from 'node:module'
import { join } from 'node:path'

const req = createRequire(import.meta.url)
const React = req('react')
const { renderToStaticMarkup } = req('react-dom/server')

const missing = new Set()
const patched = Object.create(React)
patched.createElement = (...args) => {
  const kids = args.slice(2)
  if (kids.length > 1) {
    kids.forEach((child, index) => {
      if (React.isValidElement(child) && child.key === null) {
        const owner = typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].name || args[0].displayName)) || '?'
        const marker = JSON.stringify(args[1] && Object.keys(args[1]).filter(k => k.startsWith('data-cm')).slice(0, 2))
        missing.add(owner + ' [' + marker + '] child#' + index + ' -> ' + (typeof child.type === 'string' ? child.type : (child.type && child.type.name) || '?'))
      }
    })
  }
  return React.createElement(...args)
}

const captured = {}
globalThis.window = { __ModuleLoader__: { load(spec) { captured.spec = spec } } }
globalThis.document = {
  createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
  head: { appendChild() {} },
}
await import('../client.js')
const plugin = captured.spec.factory((name) => { if (name === 'react') return patched; throw new Error(name) })
const registered = {}
const slots = { inject(n, fn) { return typeof fn === 'function' ? fn() : undefined }, register(config, component) { registered[config.name] = component; return {} } }
plugin.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn() })
renderToStaticMarkup(React.createElement(registered.main))
console.log(missing.size === 0 ? 'NO MISSING KEYS' : Array.from(missing).join('\n'))
