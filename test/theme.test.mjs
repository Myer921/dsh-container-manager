import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
function cssBlock() {
  return readFileSync(join(ROOT, 'src/client.css'), 'utf8')
}

/** 语义层里 --cm-*: var(--dsw-…, 兜底) 的兜底允许写死色值，其余一律不许。 */
function cssWithoutFallbacks() {
  return cssBlock()
    .split('\n')
    .filter((line) => !line.trim().startsWith('--cm-'))
    .join('\n')
}

test('面板 CSS 不写死颜色，全部走主题令牌', () => {
  const css = cssWithoutFallbacks()
  const raw = css.match(/(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g) || []
  assert.deepEqual(raw, [], 'CSS 里不该有颜色字面量：' + raw.join(', '))
})

test('内联 style 里也不写死颜色（var 兜底与终端兜底色除外）', () => {
  const withoutTerm = CLIENT.replace(/function readTermTheme\(\)[\s\S]*?\n    \}/, '')
  const inline = withoutTerm.match(/style:\s*\{[^}]*\}/g) || []
  const bad = inline.filter((text) => {
    const stripped = text.replace(/var\([^)]*\)/g, '')
    return /#[0-9a-fA-F]{3,8}|rgba?\(/.test(stripped)
  })
  assert.deepEqual(bad, [], '内联样式里写死了颜色：' + bad.join(' | '))
})

test('引用的每个 --dsw-* 令牌都必须真实存在', (t) => {
  const candidates = [
    process.env.DSH_THEME_CSS,
    join(homedir(), '.dsh-next/runtime/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'),
    join(homedir(), '.dsh/runtime/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'),
  ].filter(Boolean)
  const themeFile = candidates.find((file) => existsSync(file))
  if (!themeFile) {
    t.skip('找不到 DSH 主题 CSS，跳过令牌存在性检查')
    return
  }
  const theme = readFileSync(themeFile, 'utf8')
  const used = [...new Set(CLIENT.match(/--dsw-(?:alias|static)-[a-z0-9][a-z0-9-]*/g) || [])]
  assert.ok(used.length > 5, '应该引用了一批令牌，实际 ' + used.length)
  const missing = used.filter((name) => !theme.includes(name + ':'))
  assert.deepEqual(missing, [], '这些令牌在 DSH 主题里不存在：' + missing.join(', '))
})

test('终端配色跟着主题走，不写死黑底', () => {
  assert.match(CLIENT, /function readTermTheme\(\)/, '应该有一个 readTermTheme()')
  assert.match(CLIENT, /new window\.Terminal\(\{[\s\S]{0,400}?theme: readTermTheme\(\)/, 'new Terminal 应该带上 theme')
  assert.match(CLIENT, /MutationObserver/, '应该监听主题切换')
  assert.match(CLIENT, /data-ds-dark-theme/, '应该盯 data-ds-dark-theme 这个属性')
})

test('语义层覆盖文本 / 线条 / 面 / 状态四类', () => {
  const css = cssBlock()
  const required = [
    '--cm-text', '--cm-text-dim',
    '--cm-line', '--cm-line-soft', '--cm-line-strong',
    '--cm-base', '--cm-surface', '--cm-surface-hover', '--cm-layer-2',
    '--cm-hover', '--cm-active', '--cm-selected',
    '--cm-accent', '--cm-accent-hover', '--cm-on-accent',
    '--cm-ok', '--cm-warn', '--cm-warn-text', '--cm-danger',
  ]
  const missing = required.filter((name) => !css.includes(name + ':'))
  assert.deepEqual(missing, [], '语义层缺：' + missing.join(', '))
})

test('三层结构立起来了：底 + 环境光 / 凹槽 / 玻璃卡', () => {
  const css = cssBlock()
  // 深空 HUD 的层次不是「越亮越上」，而是：画布带两团冷光 → 左栏沉进去 → 卡片是半透明玻璃。
  assert.match(css, /\[data-cm-page\][^}]*background:var\(--cm-canvas-glow\),var\(--cm-base\)/, 'page 应该有底 + 环境光')
  assert.match(css, /\[data-cm-list\][^}]*background:var\(--cm-layer-2\)/, '左栏应该沉一层（凹槽）')
  assert.match(css, /\[data-cm-card\][^}]*background:var\(--cm-surface\)/, '卡片应该是玻璃面')
  assert.match(css, /\[data-cm-card\][^}]*backdrop-filter:var\(--cm-blur\)/, '卡片必须真的磨砂，不只是半透明')
})
