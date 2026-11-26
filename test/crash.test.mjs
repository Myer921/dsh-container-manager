import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

/**
 * 回归：点「终端」时整个页面消失。
 * 根因不止一个（渲染期异常会卸载整棵树 + 终端高度写死 420px 可能撑破面板），
 * 这里把两条防线都钉住。
 */

test('有一个能接住渲染崩溃的边界组件', () => {
  assert.match(CLIENT, /class PaneBoundary extends React\.Component/)
  assert.match(CLIENT, /static getDerivedStateFromError\(error\)/)
  assert.match(CLIENT, /componentDidCatch\(error, info\)/)
})

test('详情区每个 tab 和整个 Panel 都被边界包住', () => {
  assert.match(CLIENT, /h\('div', \{ 'data-cm-dbody': '' \},[\s\S]{0,260}?h\(PaneBoundary, \{ key: activeTab/, 'tab 内容应被边界包住')
  assert.match(CLIENT, /return h\(PaneBoundary, \{ label: '容器台' \}/, 'Panel 整体应再包一层')
})

test('终端高度自适应，不再写死 420px', () => {
  assert.match(CLIENT, /\[data-cm-term\]\{[^}]*height:clamp\(/, '终端高度应走 clamp 自适应')
  assert.ok(!/\[data-cm-term\]\{[^}]*height:\s*\d+px/.test(CLIENT), '别再写死固定高度')
  // 全屏时高度必须交出去，否则 clamp 会把终端卡在 560px
  assert.match(CLIENT, /\[data-cm-term-wrap\]\[data-cm-full\] \[data-cm-term\]\{flex:1;height:auto;\}/, '全屏时高度应放开')
})

test('xterm 的关键调用都有防护，出错走 fail 而不是抛到全局', () => {
  assert.match(CLIENT, /try \{\s*\n\s*term\.open\(hostRef\.current\)/, 'term.open 应在 try 里')
  assert.match(CLIENT, /try \{ term\.write\(frame\.data\) \} catch/, 'term.write 应有 catch')
  // 输入统一走 sendInput：先查 readyState，再 try/catch 包 send
  assert.match(CLIENT, /const sendInput = \(data\) => \{[\s\S]{0,200}?readyState !== 1\) return/, '发输入前应检查连接状态')
  assert.match(CLIENT, /try \{ live\.send\(JSON\.stringify\(\{ type: 'input', data \}\)\) \} catch/, 'socket.send 应有 catch')
  assert.match(CLIENT, /term\.onData\(sendInput\)/, 'term.onData 应接到统一入口')
})

test('终端视图在未选中 / 未运行时不渲染 TerminalPane', () => {
  const view = CLIENT.slice(CLIENT.indexOf('function terminalView()'), CLIENT.indexOf('function configView()'))
  assert.match(view, /if \(!selectedContainer\) return h\('div', \{ 'data-cm-empty'/, '没选容器时应给空态')
  assert.match(view, /selectedContainer\.state !== 'running'/, '没跑时不应连终端')
})
