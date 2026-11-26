import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 可视化与安全层回归：
 *  - 状态色四档，退出码非 0 必须与「正常停止」区分开
 *  - CPU 只给趋势符号，不做 sparkline（10 秒采样画折线是撒谎）
 *  - 内存水位线只在上限 > 0 时出现
 *  - 环境变量按键名逐条打码；只有「全部隐藏」，没有「一键全显」
 *  - 打码不吃 TOKEN_EXPIRY / AUTH_MODE 这类「像秘密但不是」的键
 *  - 端口胶囊只对常见 web 口出链接（SSH/数据库口点了只会报错）
 *  - 窄屏（≤600px）有一组自己的规则，tab 栏与列表行不许溢出
 *  - 重建按钮在无改动时是灰的，且带变更项数
 *  - 字号只走 5 档令牌，不出现散值
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src/client.css'), 'utf8')

function slice(from, to) {
  const start = CLIENT.indexOf(from)
  assert.ok(start >= 0, '找不到：' + from)
  const end = CLIENT.indexOf(to, start + from.length)
  assert.ok(end > start, '找不到结束标记：' + to)
  return CLIENT.slice(start, end)
}

test('状态色只有四档，没有 idle', () => {
  const block = slice('function stateTone(state) {', 'function containerTone')
  for (const tone of ["'on'", "'bad'", "'warn'", "'off'"]) {
    assert.ok(block.includes('return ' + tone), 'stateTone 少了 ' + tone)
  }
  assert.ok(!block.includes("'idle'"), 'stateTone 不该再返回 idle')
  assert.ok(!CLIENT.includes('[data-idle]'), 'CSS 里不该还留着 data-idle')
})

test('退出码非 0 的已退出容器按异常处理', () => {
  const block = slice('function containerTone(container) {', 'function exitCodeHint')
  assert.match(block, /Number\(code\) !== 0\) return 'bad'/)
})

test('退出码有解释，只说确定的', () => {
  const block = slice('function exitCodeHint(code) {', 'const STATE_LABELS')
  for (const code of ['137', '139', '143']) {
    assert.ok(block.includes('n === ' + code), 'exitCodeHint 少了 ' + code)
  }
})

test('容器 CPU 只给趋势符号；折线只给宿主负载', () => {
  assert.match(CLIENT, /const CPU_HISTORY = new Map\(\)/)
  assert.match(CLIENT, /const CPU_SAMPLES = 3/)
  assert.match(CLIENT, /function trendOf\(series\)/)
  assert.match(CLIENT, /'data-cm-trend': ''/)
  assert.ok(!CLIENT.includes('sparkPath'), '不该有 sparkline 路径函数')
  // 容器的三采样曲线仍然不许出现：10 秒一个点，折线的起伏大半来自采样间隔。
  assert.ok(!/h\('polyline'[\s\S]{0,120}?CPU_HISTORY/.test(CLIENT), '容器 CPU 不该画折线')
  // 但宿主负载是「一台机一个数、x 轴等距」，20 点封顶、少于两点不画，这条折线说的是真话。
  const spark = slice('function HostSpark({ series }) {', 'function RowBars')
  assert.match(spark, /if \(list\.length < 2\) return null/, '少于两点不画线')
  assert.match(CLIENT, /const LOAD_SAMPLES = 20/, '负载窗口封顶 20 点')
  assert.match(CLIENT, /while \(LOAD_HISTORY\.length > LOAD_SAMPLES\) LOAD_HISTORY\.shift\(\)/)
  // v0.12.0：有服务端历史就画历史（真曲线），没有才退回内存环 —— 但两条都只喂宿主负载。
  assert.match(CLIENT, /h\(HostSpark, \{ series: sparkSeries \}\)/, '折线只吃宿主负载')
  const sparkChoice = slice('const historyPoints =', 'const sparkLabel')
  assert.match(sparkChoice, /historyPoints\.length >= 2 \? historyPoints : LOAD_HISTORY\.slice\(\)/,
    '历史不足两点时才退回内存环')
  // 容器那边仍然只有趋势符号，不许接历史
  assert.ok(!/metrics[\s\S]{0,200}?container/i.test(CLIENT), '容器不接历史曲线')
})

test('趋势窗口只有三个采样点', () => {
  const block = slice('function pushCpuSamples(byNode) {', 'function trendOf')
  assert.match(block, /while \(series\.length > CPU_SAMPLES\) series\.shift\(\)/)
})

test('内存水位线只在上限存在时渲染', () => {
  const block = slice('const memLimited = usage', 'const identity =')
  assert.match(block, /const memLimited = usage && Number\(usage\.memLimit\) > 0/)
  assert.match(block, /memLimited \? h\(Meter, \{ percent: usage\.memPercent, tall: true \}\) : null/)
  assert.match(block, /'未设上限'/)
})

test('Meter 的阈值是 75 / 90，且刻度可选', () => {
  const block = slice('function Meter({ percent, tick, tall }) {', 'function TabContent')
  assert.match(block, /value >= 90/)
  assert.match(block, /value >= 75/)
  assert.match(block, /Number\(tick\) > 0 && Number\(tick\) < 100/)
  // 没有第二阈值时不能画刻度：画在 100% 位置是装饰
  assert.match(block, /: null\n      return h\('div', props/)
})

test('端口映射拆成结构化胶囊，不再是整行字符串', () => {
  assert.match(CLIENT, /'data-cm-ports': ''/)
  assert.match(CLIENT, /'data-cm-portpill': ''/)
  assert.ok(!CLIENT.includes("'→'),\n          h('td'"), '端口不该还是表格行')
})

test('环境变量按键名逐条打码，没有一键全显', () => {
  assert.match(CLIENT, /const SECRET_ENV_KEY = \/\(SECRET\|KEY\|PASS\|TOKEN\|PWD\|AUTH\|CREDENTIAL\)\/i/)
  assert.match(CLIENT, /function isSecretKey\(key\)/)
  assert.match(CLIENT, /const plain = !secret \|\| Boolean\(revealedEnv\[index\]\)/)
  assert.ok(!CLIENT.includes('setRevealEnv'), '不该再有全局「显示变量值」开关')
})

test('重建按钮无改动时是灰的，并带变更项数', () => {
  assert.match(CLIENT, /function diffDraft\(baseline, draft\)/)
  assert.match(CLIENT, /disabled: coldBusy \|\| changes\.length === 0/)
  assert.match(CLIENT, /'审查变更并重建（' \+ changes\.length \+ ' 项）'/)
  assert.match(CLIENT, /'无参数变更'/)
  // 后端也要拦一道：没改动不发请求
  assert.match(CLIENT, /if \(diffDraft\(baseline, draft\)\.length === 0\) \{/)
})

test('字号只有 6 档，没有 px 散值', () => {
  for (const token of ['--cm-f-xs:12px', '--cm-f-sm:13px', '--cm-f-md:14px', '--cm-f-lg:16px', '--cm-f-xl:22px', '--cm-f-2xl:28px']) {
    assert.ok(CSS.includes(token), '缺字号令牌：' + token)
  }
  assert.ok(!/font-size:\s*\d/.test(CSS), 'CSS 里不该再有 font-size 字面量')
  assert.ok(!/fontSize: '\d/.test(CLIENT), '内联样式里不该再有 fontSize 字面量')
})

test('圆角：卡片 14、分区 12、列表项与输入框 10、标签 6（四档不重复）', () => {
  assert.ok(CSS.includes('--cm-r-lg:14px'), '卡片圆角应为 14px')
  assert.ok(CSS.includes('--cm-r-md:12px'), '分区圆角应为 12px')
  assert.ok(CSS.includes('--cm-r-sm:10px'), '列表项 / 输入框圆角应为 10px')
  assert.ok(CSS.includes('--cm-r-xs:6px'), '标签胶囊圆角应为 6px')
})

test('折叠面板用原生 details，靠轮询重绘也不会被关上', () => {
  assert.match(CLIENT, /h\('details', \{ 'data-cm-details': '' \}/)
})

test('CSS 转义使用单反斜杠，构建后仍是合法 Unicode 转义', () => {
  assert.ok(CSS.includes('\\25B8'), '折叠箭头要用 \\25B8')
  assert.ok(CSS.includes('\\25BE'), '展开箭头要用 \\25BE')
  assert.ok(!CSS.includes('\\\\25B8'), 'CSS 源文件不该多转义一层')
  assert.ok(!/[\u0000-\u0008\u000b\u000e-\u001f]/.test(CSS), 'CSS 里不该有控制字节')
})

test('端口胶囊：只有常见 web 口做成链接，SSH/数据库口保持纯文本', () => {
  const m = CLIENT.match(/const WEB_PORTS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(m, 'WEB_PORTS 应该存在')
  const ports = m[1].split(',').map(part => Number(part.trim())).filter(Number.isFinite)
  for (const p of [80, 443, 8080, 8443]) assert.ok(ports.includes(p), p + ' 应该可点')
  for (const p of [22, 3306, 5432, 6379]) assert.ok(!ports.includes(p), p + ' 不该做成链接')
  assert.ok(/target: '_blank'/.test(CLIENT), '链接要在新标签打开')
  assert.ok(CSS.includes('a[data-cm-portpill]'), '链接样式要跟着补')
})

test('打码不吃「明显不是口令」的键名', () => {
  const secretSrc = CLIENT.match(/const SECRET_ENV_KEY = (.+)/)[1].trim()
  const notSrc = CLIENT.match(/const NOT_SECRET_KEY = (.+)/)[1].trim()
  const secret = new Function('return ' + secretSrc)()
  const notSecret = new Function('return ' + notSrc)()
  const isSecretKey = key => {
    const text = String(key || '')
    if (notSecret.test(text)) return false
    return secret.test(text)
  }
  for (const k of ['TOKEN_EXPIRY', 'AUTH_MODE', 'PASSWORD_MIN_LEN', 'SMTP_URL']) {
    assert.equal(isSecretKey(k), false, k + ' 不是口令，不该打码')
  }
  for (const k of ['DB_PASSWORD', 'API_KEY', 'CLIENT_SECRET', 'SESSION_TOKEN']) {
    assert.equal(isSecretKey(k), true, k + ' 是口令，必须打码')
  }
})

test('窄屏有自己的一组规则，tab 栏与列表行不许溢出', () => {
  assert.ok(CSS.includes('@media (max-width:600px)'), '要有手机宽度规则')
  assert.match(CSS, /@media \(max-width:600px\)\{[\s\S]*?\[data-cm-tabs\]\{overflow-x:auto/)
  assert.match(CSS, /@media \(max-width:600px\)\{[\s\S]*?\[data-cm-row\]\{flex-wrap:wrap/)
})

test('调色板全部派生自 DSH 主题令牌，一个色值都不焊死', () => {
  for (const token of [
    '--cm-base:var(--dsw-alias-bg-base',
    '--cm-surface:var(--dsw-alias-card-fill',
    '--cm-surface-hover:var(--dsw-alias-card-fill-hover',
    '--cm-text:var(--dsw-alias-label-primary',
    '--cm-text-2:var(--dsw-alias-label-secondary',
    '--cm-text-dim:var(--dsw-alias-label-secondary',
    '--cm-active:var(--dsw-alias-button-elevated-fill',
    '--cm-hover:var(--dsw-alias-interactive-bg-hover',
    '--cm-selected:var(--dsw-alias-border-selected',
    '--cm-ok:var(--dsw-alias-state-success-primary',
    '--cm-warn:var(--dsw-alias-state-warn-primary',
    '--cm-danger:var(--dsw-alias-state-error-primary',
  ]) {
    assert.ok(CSS.includes(token), '缺派生：' + token)
  }
  // 线条从文字色派生：亮色得黑 8%、暗色得白 8%，一条公式两套成立
  assert.match(CSS, /--cm-line-soft:color-mix\(in srgb,var\(--cm-text\) 8%/)
  assert.match(CSS, /--cm-line-strong:color-mix\(in srgb,var\(--cm-text\) 20%/)
  // 卡片仍然是真的磨砂，材质不因为换主题而丢
  assert.match(CSS, /\[data-cm-card\][^}]*backdrop-filter:var\(--cm-blur\)/)
})

test('写死的深空配色不许回来', () => {
  // 这些是 v0.10.x 焊死的色值，任何一个回来都说明又脱离主题了
  for (const gone of [
    '#090C10', 'rgba(17,22,31', '#0D1117', '#38BDF8', '#10B981',
    '#F59E0B', '#E6EDF6', '#1E293B', '#04121B',
  ]) {
    assert.ok(!CSS.includes(gone), '面板 CSS 里不该再有 ' + gone)
  }
})

test('明暗两套都在，只有暗色才发光', () => {
  assert.match(CSS, /body\[data-ds-dark-theme\] \[data-cm-page\]\{/, '暗色分支要挂在 body 属性上')
  const dark = slice('body[data-ds-dark-theme] [data-cm-page]{', '/* ── 顶栏 ── */')
  assert.match(dark, /--cm-accent:var\(--dsw-static-blue-400/, '暗色强调色用 DSH 静态蓝 400')
  assert.match(dark, /--cm-canvas-glow:radial-gradient/, '暗色才铺环境光')
  assert.match(dark, /--cm-glow-accent:0 0 12px/, '暗色才发光')
  // 浅色基线反过来：不铺光、不发光，改用细描边
  assert.match(CSS, /--cm-canvas-glow:linear-gradient\(transparent,transparent\)/)
  assert.match(CSS, /--cm-glow-accent:0 0 0 1px var\(--cm-accent-line\)/)
})

test('强调色是 DSH 静态蓝，不是品牌反色', () => {
  assert.match(CSS, /--cm-accent:var\(--dsw-static-blue-600/)
  assert.ok(!CSS.includes('--cm-accent:var(--dsw-alias-brand-primary'),
    'brand-primary 是反色令牌（亮色近黑/暗色近白），不能当强调色')
  assert.match(CSS, /--cm-on-accent:var\(--dsw-static-neutral-bluish-00/)
})

test('容器行底部有双色微进度，没有内存上限就不画内存那条', () => {
  const bars = slice('function RowBars({ usage }) {', 'function Meter({ percent, tick, tall }) {')
  assert.match(bars, /const limit = Number\(usage\.memLimit\) \|\| 0/)
  assert.match(bars, /const mem = limit > 0[\s\S]{0,160}?: null/, '没有上限时 mem 必须是 null')
  assert.match(bars, /if \(mem !== null\) \{/, '内存条只在有上限时才 push')
  assert.match(CLIENT, /h\(RowBars, \{ usage \}\)/)
  assert.match(CLIENT, /'data-cm-bars': ''/)
  assert.match(CSS, /\[data-cm-bars\]>i\[data-kind='cpu'\]>b\{background:var\(--cm-accent\)/)
})

test('顶部「待确认」只有 > 0 才点亮成琥珀胶囊', () => {
  assert.match(CLIENT, /'data-cm-pendingbadge': ''/)
  assert.match(CLIENT, /pending\.length > 0 \? \{ 'data-on': '' \} : \{\}/)
  assert.match(CSS, /\[data-cm-pendingbadge\]\[data-on\][^}]*color:var\(--cm-warn\)/)
})

test('节点技术栈拆成等宽徽章，不再拼成一行灰字', () => {
  const fn = slice('function techBadges(node) {', 'function overviewView() {')
  assert.match(fn, /'podman ' \+ \(detail\.version \?\? '\?'\)/)
  assert.match(fn, /detail\.rootless \? 'rootless' : 'rootful'/)
  assert.match(CLIENT, /'data-cm-tech': ''/)
  assert.match(CSS, /\[data-cm-tip\][^}]*font-family:var\(--cm-mono\)/)
})

test('右侧是 Bento 三格 + 三格信息矩阵，窄屏退成单列', () => {
  assert.match(CSS, /\[data-cm-bento\]\{display:grid;grid-template-columns:repeat\(3,1fr\)/)
  assert.match(CSS, /\[data-cm-matrix\]\{display:grid;grid-template-columns:repeat\(3,1fr\)/)
  assert.match(CLIENT, /h\(InfoCell, \{ icon: 'shield'/)
  assert.match(CSS, /\[data-cm-bento\],\[data-cm-matrix\],\[data-cm-nodes\]\{grid-template-columns:1fr;\}/)
})

test('二级 tab 用下划线发光指示器，不再靠整块底色', () => {
  assert.match(CSS, /\[data-cm-tab\]\[data-on\]::after\{[^}]*background:var\(--cm-accent\)/)
  assert.match(CSS, /\[data-cm-tab\]\[data-on\]::after\{[^}]*box-shadow:var\(--cm-glow-accent\)/)
})

test('一个数字只走一种排版：详情页三块与宿主 Bento 同材质', () => {
  const fn = slice('function DataTile({ icon, label, value, unit, sub, trail, extra }) {', '/** 三格信息位')
  assert.match(fn, /'data-cm-tile': ''/, '必须借 tile 的材质')
  assert.match(fn, /'data-cm-big': ''/, '数字走 28px 的 big 档')
  assert.match(fn, /'data-cm-bigunit': ''/, '单位要小一号')
  const used = (CLIENT.match(/h\(DataTile, \{/g) || []).length
  assert.equal(used, 3, 'CPU / 内存 / 进程 三块都得走 DataTile')
  // 两套材质不许并存：旧的 numblock 家族一个字都不该留
  for (const gone of ['data-cm-numblock', 'data-cm-numlabel', 'data-cm-numvalue', 'data-cm-numsub']) {
    assert.ok(!CLIENT.includes(gone), '旧的 ' + gone + ' 应该彻底删掉')
  }
})

test('双色进度条有最小可见宽度，空轨也读得出来', () => {
  // CPU 0.77% 在 98px 轨道上是 0.75px，没有下限就是不可见
  assert.match(CSS, /\[data-cm-bars\]>i>b\{[^}]*min-width:3px/)
  assert.match(CSS, /\[data-cm-bars\]>i\{[^}]*background:var\(--cm-line-strong\)/)
})
