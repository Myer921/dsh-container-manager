import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 终端显示改良的回归：字号、全屏、复制粘贴、断线浮层。
 * 这些都在 client.js 的 TerminalPane 与 CSS 里，用源码断言钉住，防止哪天被顺手删掉。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
function cssBlock() {
  return readFileSync(join(ROOT, 'src/client.css'), 'utf8')
}

function pane() {
  const start = CLIENT.indexOf('    function TerminalPane({ nodeId, name }) {')
  assert.ok(start >= 0, '找不到 TerminalPane')
  const end = CLIENT.indexOf('\n    function ', start + 10)
  assert.ok(end > start, 'TerminalPane 后面应还有别的函数')
  return CLIENT.slice(start, end)
}

test('字号可调且落在合理区间，默认 13', () => {
  const src = pane()
  assert.match(src, /TERM_MIN_SIZE = 11/)
  assert.match(src, /TERM_MAX_SIZE = 20/)
  assert.match(src, /TERM_DEFAULT_SIZE = 13/)
  assert.match(src, /const \[fontSize, setFontSize\] = React\.useState/)
})

test('字号写进 localStorage，刷新后还在', () => {
  const src = pane()
  assert.match(src, /const TERM_SIZE_KEY = 'cm-terminal-font-size'/)
  assert.match(src, /window\.localStorage\.getItem\(TERM_SIZE_KEY\)/)
  assert.match(src, /window\.localStorage\.setItem\(TERM_SIZE_KEY, String\(size\)\)/)
  // 读写都包了 try：localStorage 被禁、或者 SSR 没有 window，都不能把页面带崩
  assert.match(src, /try \{[\s\S]{0,120}?localStorage\.getItem[\s\S]{0,160}?\} catch/)
})

test('改字号只动 options，不重建终端（否则连接会断）', () => {
  const src = pane()
  assert.match(src, /try \{ term\.options\.fontSize = fontSize \} catch/)
  assert.match(src, /try \{ fitRef\.current\?\.fit\(\) \} catch/)
  // 主 effect 的依赖里不能有 fontSize
  assert.match(src, /\}, \[nodeId, name, tick\]\)/)
  assert.ok(!/\}, \[nodeId, name, tick, fontSize\]\)/.test(src), 'fontSize 不该进主 effect 依赖')
})

test('全屏靠 data-cm-full，Esc 退出，CSS 铺满视口', () => {
  const src = pane()
  assert.match(src, /const \[full, setFull\] = React\.useState\(false\)/)
  assert.match(src, /'data-cm-full': ''/)
  assert.match(src, /event\.key !== 'Escape'/, '应当监听 Esc')
  assert.match(src, /window\.addEventListener\('keydown', onKey\)/)
  assert.match(src, /window\.removeEventListener\('keydown', onKey\)/, '监听要记得摘掉')
  const css = cssBlock()
  assert.match(css, /\[data-cm-term-wrap\]\[data-cm-full\]\{position:fixed;inset:0/)
  assert.match(css, /\[data-cm-term-wrap\]\[data-cm-full\] \[data-cm-term\]\{flex:1;height:auto;\}/)
})

test('Ctrl+Shift+C / V 自己接管，不喂给 PTY', () => {
  const src = pane()
  assert.match(src, /term\.attachCustomKeyEventHandler/)
  assert.match(src, /event\.ctrlKey && event\.shiftKey && key === 'c'/)
  assert.match(src, /event\.ctrlKey && event\.shiftKey && key === 'v'/)
  assert.match(src, /term\.getSelection\(\)/, '复制要拿选中内容')
  assert.match(src, /navigator\.clipboard\.readText\(\)/, '粘贴要读剪贴板')
  // 两条分支都得 return false，否则按键还会继续传给终端
  // 从复制分支开始截，别从 handler 开头 —— 那里有个 if 类型判断的 return true 会提前截断
  const handlerStart = src.indexOf("key === 'c'")
  const handlerEnd = src.indexOf('return true', handlerStart)
  assert.ok(handlerEnd > handlerStart, 'handler 末尾应有兜底的 return true')
  const handler = src.slice(handlerStart, handlerEnd)
  assert.equal((handler.match(/return false/g) || []).length, 2, '复制与粘贴两个分支都要拦下来')
})

test('连接中 / 断线时浮一层，不用滚回顶部找重连', () => {
  const src = pane()
  assert.match(src, /data-cm-term-overlay/)
  assert.match(src, /state === 'ready' \? null : h\('div'/, '只在非 ready 时浮')
  assert.match(src, /data-cm-overlay-title/)
  assert.match(src, /data-cm-overlay-msg/)
  assert.match(src, /重新连接/)
  // 浮层挂在终端宿主里面，才能 absolute 铺满它
  assert.match(src, /h\('div', \{ 'data-cm-term': '', ref: hostRef \}, overlay\)/)
  assert.match(cssBlock(), /\[data-cm-term-overlay\]\{position:absolute;inset:0;z-index:10/)
})

test('工具栏有字号、清屏、全屏、重连', () => {
  const src = pane()
  assert.match(src, /'data-cm-term-bar'/)
  assert.match(src, /'data-cm-term-bar-group'/)
  assert.match(src, /'data-cm-term-size'/)
  assert.match(src, /termRef\.current\?\.clear\(\)/, '清屏按钮')
  assert.match(src, /'A−'/)
  assert.match(src, /'A＋'/)
  assert.match(src, /'清屏'/)
  assert.match(src, /'重连'/)
  assert.match(src, /full \? '还原' : '全屏'/, '全屏按钮文案随状态切换')
})

test('终端外框：聚焦有 ring，视口背景透明交给主题', () => {
  const css = cssBlock()
  assert.match(css, /\[data-cm-term\]:focus-within\{border-color:var\(--cm-accent-line\)/)
  assert.match(css, /\[data-cm-term\] \.xterm-viewport\{background:transparent!important;\}/)
  assert.match(css, /\[data-cm-term\] \.xterm\{height:100%;\}/)
})

test('滚轮/滚动条：终端视口也在统一规范里', () => {
  const css = cssBlock()
  assert.match(css, /\[data-cm-term\] \.xterm-viewport\{[^}]*scrollbar-width:thin/)
  assert.match(css, /\[data-cm-term\] \.xterm-viewport::-webkit-scrollbar\{width:9px;height:9px;\}/)
  assert.match(css, /\[data-cm-term\] \.xterm-viewport::-webkit-scrollbar-thumb\{/)
})

test('主题切换时字号与配色都不丢', () => {
  const src = pane()
  assert.ok(src.includes('theme: readTermTheme()'), 'new Terminal 应带上 theme')
  assert.match(src, /term\.options\.theme = readTermTheme\(\)/)
  // 字号只在建实例时从 ref 读，之后靠 effect 改，避免重建
  assert.match(src, /fontSize: sizeRef\.current/)
})
