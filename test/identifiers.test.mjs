import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 「被调用但从未定义」审计。
 *
 * 由来：v0.9.0 的概览重写里写了 `uptime = formatUptime(seconds)`，而这个函数
 * 从来没被定义过 —— 380 条源码切片断言全绿，`node --check` 也绿，
 * 一直到用户点开概览才炸 ReferenceError。语法检查查不到这个，只有真跑才查得到；
 * 既然这个单文件 bundle 没法真跑组件，就用静态审计守住这一类。
 *
 * 误报是这道测试的头号敌人：React 的 setter（`const [x, setX] = useState()`）、
 * 对象/类的方法简写（`apply(ctx) {`）、解构参数（`function P({ onToast })`）
 * 都必须被认成「已定义」，否则一屏一百多条噪声，没人会去看它。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RAW = readFileSync(join(ROOT, 'client.js'), 'utf8')

/** 语言关键字 + 宿主/内置全局：这些不需要在文件里定义。 */
const GLOBALS = new Set([
  'async', 'await', 'var', 'function', 'if', 'for', 'while', 'switch', 'catch',
  'return', 'typeof', 'delete', 'void', 'new', 'do', 'else', 'try', 'finally',
  'throw', 'case', 'default', 'break', 'continue', 'instanceof', 'in', 'of', 'yield',
  'super', 'import', 'export', 'this', 'true', 'false', 'null', 'undefined',
  'h', 'require', 'React',
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Intl', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'fetch', 'alert', 'confirm', 'prompt', 'console',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData',
  'TextDecoder', 'TextEncoder', 'AbortController', 'WebSocket', 'Event', 'CustomEvent',
  // 二进制进出：文件面板把容器里的字节转成 Blob 下载时用到（都是浏览器原生全局）
  'atob', 'btoa', 'Uint8Array', 'ArrayBuffer', 'DataView',
  'arguments', 'eval', 'getComputedStyle', 'matchMedia',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver',
])

/** 去掉注释与字符串字面量：里面的 `foo(` 不是调用。 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 把一个参数列表拆成名字：处理解构、默认值、剩余参数。 */
function paramNames(list) {
  const out = []
  let depth = 0
  let buf = ''
  const push = (raw) => {
    const text = raw.split('=')[0].trim().replace(/^\.\.\./, '')
    const bare = text.replace(/[{}[\]]/g, ' ').trim()
    for (const piece of bare.split(/[\s,]+/)) {
      const name = piece.split(':').pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name)
    }
  }
  for (const ch of list) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { push(buf); buf = '' } else buf += ch
  }
  if (buf.trim()) push(buf)
  return out
}

/** 文件里所有「有名字被定义/赋值」的地方。 */
function collectDefined(code) {
  const defined = new Set()
  const add = (name) => { if (name) defined.add(name) }

  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1])

  // const { a, b: c } = ... / const [x, setX] = React.useState()
  for (const m of code.matchAll(/(?:const|let|var)\s*([\[{][^\]}]*[\]}])\s*=/g)) {
    for (const name of paramNames(m[1])) add(name)
  }

  // 函数形参（含解构）
  for (const m of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const name of paramNames(m[1])) add(name)
  }
  // 箭头函数形参
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of paramNames(m[1])) add(name)
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1])

  // 对象字面量/类里的方法简写：apply(ctx) { / render() { / componentDidCatch(e, i) {
  for (const m of code.matchAll(/(?:^|[{,])\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) add(m[1])
  // 赋给对象属性的函数：foo: function / foo: async () => / foo: (a) =>
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)) add(m[1])

  return defined
}

/** 代码里所有 `name(` 形式的调用名（排除属性访问与关键字）。 */
function collectCalls(code) {
  const calls = new Map()
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2]
    if (GLOBALS.has(name)) continue
    calls.set(name, (calls.get(name) || 0) + 1)
  }
  return calls
}

const defined = collectDefined(strip(RAW))
const calls = collectCalls(strip(RAW))
const missing = [...calls.entries()].filter(([name]) => !defined.has(name))

test('client.js 里没有被调用却没有定义的标识符', () => {
  assert.deepEqual(
    missing,
    [],
    '这些名字被调用了但文件里找不到定义（ReferenceError 会在真机上炸）：' +
      JSON.stringify(missing),
  )
})

test('审计本身能认出 setter / 方法简写 / 解构参数（防止测试自己失效）', () => {
  // 如果这几条断了，上面的断言会因为「什么都算已定义」而形同虚设
  assert.ok(defined.has('setTick'), '数组解构里的 setter 应算已定义')
  assert.ok(defined.has('apply'), '对象方法简写应算已定义')
  assert.ok(defined.has('componentDidCatch'), '类方法应算已定义')
  assert.ok(defined.has('render'), '类方法应算已定义')
  assert.ok(defined.has('onToast'), '解构形参应算已定义')
  assert.ok(calls.has('sizeText'), '调用收集应认出 sizeText(')
  assert.ok(calls.has('jget'), '调用收集应认出 jget(')
  assert.ok(!calls.has('map'), '属性访问 .map( 不该被当成裸调用')
})

/**
 * 从单文件 bundle 里把某个函数源码抠出来真跑。
 *
 * 这个 client.js 是自注册的非 ESM bundle，函数全在 factory 闭包里、导不出来，
 * 所以「真跑一下」只能这么来：按大括号配平截取源码，再 new Function 求值。
 * 只用于纯函数（不碰 hooks / DOM），别拿它去测组件。
 */
function extractFunction(name) {
  const start = RAW.indexOf('function ' + name + '(')
  assert.ok(start >= 0, '找不到函数：' + name)
  const braceAt = RAW.indexOf('{', start)
  assert.ok(braceAt > start, '找不到函数体：' + name)
  let depth = 0
  for (let i = braceAt; i < RAW.length; i += 1) {
    if (RAW[i] === '{') depth += 1
    else if (RAW[i] === '}') {
      depth -= 1
      if (depth === 0) return new Function('return ' + RAW.slice(start, i + 1))()
    }
  }
  throw new Error('函数体没配平：' + name)
}

test('formatUptime 的边界：0 秒、负数、NaN、跨天', () => {
  const formatUptime = extractFunction('formatUptime')
  assert.equal(formatUptime(0), '0秒')
  assert.equal(formatUptime(42), '42秒')
  assert.equal(formatUptime(300), '5分')
  assert.equal(formatUptime(3600), '1小时')
  assert.equal(formatUptime(12000), '3小时20分')
  assert.equal(formatUptime(86400), '1天')
  assert.equal(formatUptime(223200), '2天14小时')
  // 拿不到合法值就空串，让调用方整段不显示，不编一个「0秒」出来
  assert.equal(formatUptime(undefined), '')
  assert.equal(formatUptime(null), '')
  assert.equal(formatUptime(NaN), '')
  assert.equal(formatUptime(-5), '')
  assert.equal(formatUptime('abc'), '')
})
