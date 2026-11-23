/**
 * dsh-container-manager —— 浏览器半：左侧「容器」主面板
 *
 * 约定（与 dsh-fish-tone 相同）：
 *   1. client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 *   2. 进左侧主面板靠 slots.inject('main') + slots.inject('sidebar.panellist')
 *   3. 数据全走 /api/container-manager，页面只做渲染与确认
 *
 * 危险操作（删除容器、改网络）在这里才真正确认：POST /actions/confirm 带
 * x-cm-principal: panel —— AI 工具永远拿不到这个通道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-container-manager',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/container-manager'
    const PANEL_ID = 'containers'
    const REFRESH_MS = 4000

    const CSS = `
/* ══════════════════════════════════════════════════════════
   设计令牌层
   所有组件只从这一层取值：改一处，全局跟着变。
   色彩全部映射 DSH 的 --dsw-alias-*，亮/暗主题自动切换。
   ══════════════════════════════════════════════════════════ */
[data-cm-page]{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;box-sizing:border-box;
  padding-top:var(--dsh-frame-top-clearance,0px);color:var(--cm-text);
  background:var(--cm-canvas-glow),var(--cm-base);
  font-size:var(--cm-f-md);line-height:1.5;-webkit-font-smoothing:antialiased;
  /* ── 颜色全部派生自 DSH 主题令牌 ──
     这里写的是**亮色基线**；暗色只覆盖 6 个会发光的令牌，见下面 body[data-ds-dark-theme] 那一块。
     宿主换主题 = 换这套 alias 令牌，面板自动跟上，不需要再改一次。
     色值只允许写在这一批 --cm-* 定义行里（test/theme.test.mjs 会过滤这些行）。 */
  --cm-text:var(--dsw-alias-label-primary,currentColor);
  --cm-text-2:var(--dsw-alias-label-secondary,currentColor);
  --cm-text-dim:var(--dsw-alias-label-tertiary,#8b9096);
  --cm-base:var(--dsw-alias-bg-base,transparent);
  --cm-surface:var(--dsw-alias-card-fill,rgba(128,128,128,.08));
  --cm-surface-hover:var(--dsw-alias-card-fill-hover,rgba(128,128,128,.12));
  /* 凹槽 / 子卡 / 左栏：在底色与卡面之间取一档，亮暗两边都能分层 */
  --cm-layer-2:color-mix(in srgb,var(--cm-surface) 55%,var(--cm-base));
  --cm-active:var(--dsw-alias-button-elevated-fill,#e6e7ea);
  --cm-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));
  --cm-selected:var(--dsw-alias-border-selected,#adb2b8);
  /* 强调色用 DSH 自己的静态蓝（和终端 readTermTheme() 同一套），不用 brand-primary ——
     那是反色令牌（亮色近黑、暗色近白），拿它当强调色会得到黑药丸 / 白药丸。 */
  --cm-accent:var(--dsw-static-blue-600,#2563eb);
  --cm-accent-hover:color-mix(in srgb,var(--cm-accent) 82%,var(--cm-text));
  --cm-on-accent:var(--dsw-static-neutral-bluish-00,#ffffff);
  --cm-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --cm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --cm-warn-text:var(--dsw-alias-state-warn-label,#dd8629);
  --cm-danger:var(--dsw-alias-state-error-primary,#ef4444);
  --cm-idle:var(--dsw-alias-label-tertiary,#8b9096);
  /* 线条由文字色派生：亮色得「黑 8%」、暗色得「白 8%」，一条公式两套成立 */
  --cm-line-soft:color-mix(in srgb,var(--cm-text) 8%,transparent);
  --cm-line:color-mix(in srgb,var(--cm-text) 12%,transparent);
  --cm-line-strong:color-mix(in srgb,var(--cm-text) 20%,transparent);
  --cm-hairline:1px solid var(--cm-line-soft);
  /* 亮色不发光：用一圈强调色细描边代替光晕，同一个令牌名，两套视觉 */
  --cm-edge-light:color-mix(in srgb,var(--cm-text) 10%,transparent);
  --cm-toplight:linear-gradient(90deg,transparent,var(--cm-edge-light),transparent);
  --cm-glass:color-mix(in srgb,var(--cm-base) 84%,transparent);
  --cm-canvas-glow:linear-gradient(transparent,transparent);
  --cm-glow-accent:0 0 0 1px var(--cm-accent-line);
  --cm-glow-ok:0 0 0 1px var(--cm-ok-line);
  --cm-glow-warn:0 0 0 1px var(--cm-warn-line);
  --cm-glow-top:inset 0 1px 0 color-mix(in srgb,var(--cm-text) 4%,transparent);
  --cm-inset-groove:inset 0 1px 2px color-mix(in srgb,var(--cm-text) 6%,transparent);
  --cm-blur:blur(12px);
  /* ── 派生柔色：徽标、选中底、hover 都用它，避免满屏实心色块 ── */
  --cm-accent-soft:color-mix(in srgb,var(--cm-accent) 14%,transparent);
  --cm-accent-line:color-mix(in srgb,var(--cm-accent) 42%,transparent);
  --cm-danger-soft:color-mix(in srgb,var(--cm-danger) 14%,transparent);
  --cm-danger-line:color-mix(in srgb,var(--cm-danger) 42%,transparent);
  --cm-ok-soft:color-mix(in srgb,var(--cm-ok) 14%,transparent);
  --cm-ok-line:color-mix(in srgb,var(--cm-ok) 42%,transparent);
  --cm-warn-soft:color-mix(in srgb,var(--cm-warn) 16%,transparent);
  --cm-warn-line:color-mix(in srgb,var(--cm-warn) 42%,transparent);
  /* ── 间距刻度：8px 基准（4 / 8 / 12 / 16 / 20 / 24 / 32），卡片内边距 20、外边距 16 ── */
  --cm-s1:4px;--cm-s2:8px;--cm-s3:12px;--cm-s4:16px;--cm-s5:20px;--cm-s6:24px;--cm-s7:32px;
  /* ── 圆角刻度：大卡片 14、列表项与输入框 10、标签胶囊 6 ── */
  --cm-r-xs:6px;--cm-r-sm:10px;--cm-r-md:10px;--cm-r-lg:14px;--cm-r-full:999px;
  /* ── 字号刻度：封死 6 档（11 / 12 / 13 / 16 / 22 / 28），2xl 只给 Bento 大号指标 ── */
  --cm-f-xs:11px;--cm-f-sm:12px;--cm-f-md:13px;--cm-f-lg:16px;--cm-f-xl:22px;--cm-f-2xl:28px;
  /* ── 动效：一条曲线走到底，时长克制 ── */
  --cm-ease:cubic-bezier(.2,.7,.3,1);
  --cm-fast:.14s;--cm-slow:.24s;
  /* ── 阴影：亮色是轻灰影，暗色靠分层暗影托起来（见分支） ── */
  --cm-shadow-sm:0 1px 2px rgba(0,0,0,.06);
  --cm-shadow-md:0 4px 14px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);
  --cm-shadow-lg:0 12px 32px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.06);
  --cm-ring:0 0 0 3px var(--cm-accent-soft);}

/* ── 暗色分支：只换这 9 个令牌，其余全部由上面派生 ──
   DSH 用 body[data-ds-dark-theme] 表示暗色（client.js 的 MutationObserver 已经在盯它给终端用），
   面板 CSS 注入在 document.head，所以这个后代选择器能命中面板根节点。 */
body[data-ds-dark-theme] [data-cm-page]{
  --cm-accent:var(--dsw-static-blue-400,#60a5fa);
  --cm-on-accent:#08131F;
  --cm-edge-light:rgba(255,255,255,.14);
  --cm-canvas-glow:radial-gradient(1100px 520px at 88% -12%,color-mix(in srgb,var(--cm-accent) 7%,transparent),transparent 68%),radial-gradient(900px 480px at 6% 108%,color-mix(in srgb,var(--cm-ok) 5%,transparent),transparent 70%);
  --cm-glow-accent:0 0 12px color-mix(in srgb,var(--cm-accent) 35%,transparent);
  --cm-glow-ok:0 0 8px color-mix(in srgb,var(--cm-ok) 50%,transparent);
  --cm-glow-warn:0 0 10px color-mix(in srgb,var(--cm-warn) 40%,transparent);
  --cm-glow-top:inset 0 1px 0 rgba(255,255,255,.06);
  --cm-inset-groove:inset 0 1px 3px rgba(0,0,0,.35);
  --cm-shadow-sm:0 1px 2px rgba(0,0,0,.35);
  --cm-shadow-md:0 6px 20px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.4);
  --cm-shadow-lg:0 18px 48px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);
}

/* ── 顶栏 ── */
[data-cm-top]{display:flex;align-items:center;gap:var(--cm-s3);padding:var(--cm-s4) var(--cm-s6);
  border-bottom:1px solid var(--cm-line-soft);flex:none;position:relative;z-index:2;
  background:var(--cm-glass);backdrop-filter:var(--cm-blur);-webkit-backdrop-filter:var(--cm-blur);}
/* 顶栏底缘一道渐隐高光，把标题区和内容区切开，而不是靠一条实线 */
[data-cm-top]::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;
  background:var(--cm-toplight);pointer-events:none;}
[data-cm-title]{font-size:var(--cm-f-lg);font-weight:650;letter-spacing:-.01em;line-height:1.3;}
[data-cm-sub]{font-size:var(--cm-f-xs);color:var(--cm-text-dim);letter-spacing:.01em;}
[data-cm-grow]{flex:1;min-width:0;}

/* ── 按钮：软底 + 细描边 + focus ring，按下有 0.5px 位移 ── */
[data-cm-btn]{display:inline-flex;align-items:center;justify-content:center;gap:var(--cm-s2);
  border:1px solid var(--cm-line-strong);background:var(--cm-base);color:inherit;
  border-radius:var(--cm-r-sm);padding:5px 11px;font-size:var(--cm-f-sm);line-height:1.4;
  cursor:pointer;font-family:inherit;white-space:nowrap;
  transition:background-color var(--cm-fast) var(--cm-ease),border-color var(--cm-fast) var(--cm-ease),
    color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease),
    transform var(--cm-fast) var(--cm-ease);}
[data-cm-btn]:hover{background:var(--cm-hover);}
[data-cm-btn]:active{transform:translateY(.5px);background:var(--cm-active);}
[data-cm-btn]:focus-visible{outline:none;border-color:var(--cm-accent);box-shadow:var(--cm-ring);}
[data-cm-btn][data-primary]{background:var(--cm-accent);border-color:transparent;
  color:var(--cm-on-accent);box-shadow:var(--cm-shadow-sm);}
[data-cm-btn][data-primary]:hover{background:var(--cm-accent-hover);box-shadow:var(--cm-shadow-md);}
[data-cm-btn][data-danger]{border-color:var(--cm-danger-line);color:var(--cm-danger);background:transparent;}
[data-cm-btn][data-danger]:hover{background:var(--cm-danger-soft);border-color:var(--cm-danger);}
[data-cm-btn][disabled]{opacity:.42;cursor:not-allowed;box-shadow:none;transform:none;}

/* ── 两栏骨架 ── */
[data-cm-body]{display:flex;flex:1;min-height:0;}
[data-cm-stack]{display:flex;flex-direction:column;flex:1;min-height:0;}
/* 子 tab 条横跨整页，下面再接正文（容器页是左列表+右详情，其余是单页）。 */
[data-cm-subbar]{flex:none;min-width:0;}
[data-cm-subbar]:empty{display:none;}
[data-cm-subbar] [data-cm-tabs]{margin-bottom:0;}
[data-cm-list]{width:300px;flex:none;border-right:1px solid var(--cm-line-soft);
  background:var(--cm-layer-2);display:flex;flex-direction:column;min-height:0;}
[data-cm-search]{padding:var(--cm-s3) var(--cm-s3);border-bottom:1px solid var(--cm-line-soft);flex:none;}
/* 放大镜是装饰，不抢焦点：绝对定位压在输入框左侧，input 自己加左内边距让位 */
[data-cm-searchwrap]{position:relative;display:flex;align-items:center;}
[data-cm-sicon]{position:absolute;left:9px;top:50%;transform:translateY(-50%);
  display:flex;color:var(--cm-text-dim);pointer-events:none;}
[data-cm-search] input{width:100%;box-sizing:border-box;background:var(--cm-base);
  border:1px solid var(--cm-line-strong);border-radius:var(--cm-r-sm);color:inherit;
  padding:7px 10px 7px 30px;font-size:var(--cm-f-sm);font-family:inherit;outline:none;
  transition:border-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease),
    background-color var(--cm-fast) var(--cm-ease);}
[data-cm-search] input::placeholder{color:var(--cm-text-dim);}
[data-cm-search] input:focus{border-color:var(--cm-accent);box-shadow:var(--cm-ring),var(--cm-glow-accent);
  background:var(--cm-layer-2);}
[data-cm-scroll]{overflow:auto;min-height:0;flex:1;padding:var(--cm-s2) var(--cm-s3) var(--cm-s6);}

/* ── 滚动条：细、半透明、hover 才显形 ── */
[data-cm-scroll],[data-cm-dbody],[data-cm-logbox],[data-cm-pre],[data-cm-pending],
[data-cm-editor],[data-cm-term] .xterm-viewport{scrollbar-width:thin;
  scrollbar-color:var(--cm-line-strong) transparent;}
[data-cm-scroll]::-webkit-scrollbar,[data-cm-dbody]::-webkit-scrollbar,
[data-cm-logbox]::-webkit-scrollbar,[data-cm-pre]::-webkit-scrollbar,
[data-cm-pending]::-webkit-scrollbar,[data-cm-editor]::-webkit-scrollbar,
[data-cm-term] .xterm-viewport::-webkit-scrollbar{width:9px;height:9px;}
[data-cm-scroll]::-webkit-scrollbar-track,[data-cm-dbody]::-webkit-scrollbar-track,
[data-cm-logbox]::-webkit-scrollbar-track,[data-cm-pre]::-webkit-scrollbar-track,
[data-cm-pending]::-webkit-scrollbar-track,[data-cm-editor]::-webkit-scrollbar-track,
[data-cm-term] .xterm-viewport::-webkit-scrollbar-track{background:transparent;}
[data-cm-scroll]::-webkit-scrollbar-thumb,[data-cm-dbody]::-webkit-scrollbar-thumb,
[data-cm-logbox]::-webkit-scrollbar-thumb,[data-cm-pre]::-webkit-scrollbar-thumb,
[data-cm-pending]::-webkit-scrollbar-thumb,[data-cm-editor]::-webkit-scrollbar-thumb,
[data-cm-term] .xterm-viewport::-webkit-scrollbar-thumb{
  background:var(--cm-line-strong);border-radius:var(--cm-r-full);
  border:2px solid transparent;background-clip:content-box;}
[data-cm-scroll]::-webkit-scrollbar-thumb:hover,[data-cm-dbody]::-webkit-scrollbar-thumb:hover,
[data-cm-logbox]::-webkit-scrollbar-thumb:hover,[data-cm-pre]::-webkit-scrollbar-thumb:hover,
[data-cm-term] .xterm-viewport::-webkit-scrollbar-thumb:hover{
  background:var(--cm-text-dim);background-clip:content-box;}

/* ── 分组标题 ── */
[data-cm-group]{margin-top:var(--cm-s3);}
[data-cm-ghead]{display:flex;align-items:center;gap:var(--cm-s2);padding:var(--cm-s1) var(--cm-s2);
  font-size:var(--cm-f-xs);font-weight:650;color:var(--cm-text-dim);letter-spacing:.06em;}



/* ── 分段控件：同一页里几组性质相近、量级不同的配置 ── */
[data-cm-seg]{display:inline-flex;gap:2px;padding:2px;margin-bottom:var(--cm-s4);
  background:var(--cm-base);border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);}
[data-cm-segitem]{appearance:none;border:0;background:transparent;cursor:pointer;
  font-family:inherit;font-size:var(--cm-f-sm);font-weight:500;color:var(--cm-text-dim);
  padding:5px 12px;border-radius:var(--cm-r-sm);
  transition:background-color var(--cm-fast) var(--cm-ease),color var(--cm-fast) var(--cm-ease);}
[data-cm-segitem]:hover{color:var(--cm-text-2);}
[data-cm-segitem][data-active]{background:var(--cm-surface);color:var(--cm-text);
  box-shadow:inset 0 0 0 1px var(--cm-line);}

/* ── 概览页：状态头 / 数字块 / 折叠 / 危险区 ── */
[data-cm-hero]{display:flex;flex-direction:column;gap:var(--cm-s2);}
[data-cm-heroline]{display:flex;gap:var(--cm-s3);align-items:center;flex-wrap:wrap;}
[data-cm-heroname]{font-size:var(--cm-f-lg);font-weight:600;color:var(--cm-text);letter-spacing:-.01em;}
[data-cm-herosub]{font-size:var(--cm-f-md);color:var(--cm-text-2);font-variant-numeric:tabular-nums;}

/* 状态词本身带色 —— 色只在「状态 / 可交互 / 危险」三个语义上出现。 */
[data-cm-statelabel]{font-size:var(--cm-f-sm);font-weight:600;letter-spacing:.02em;}
[data-cm-statelabel][data-tone="on"]{color:var(--cm-ok);}
[data-cm-statelabel][data-tone="warn"]{color:var(--cm-warn-text);}
[data-cm-statelabel][data-tone="off"]{color:var(--cm-text-dim);}
[data-cm-statelabel][data-tone="bad"]{color:var(--cm-danger);}

/* CPU / 内存 / 进程 三块并排：这是首屏最该被看见的数字。
   2026-11-23 起它们不再自带一套样式，直接复用 Bento 的 [data-cm-tile]，
   免得同一屏上出现两种材质、两种字号。 */
[data-cm-numbers]{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:var(--cm-s3);margin:var(--cm-s3) 0;}
/* 趋势符号：三次轮询的走向。代替 sparkline —— 4 秒采一个点画折线，
   线条的抖动来自轮询间隔而不是负载，那是撒谎。 */
[data-cm-trend]{font-size:var(--cm-f-md);font-weight:600;margin-left:var(--cm-s1);
  vertical-align:2px;}
[data-cm-trend][data-dir="up"]{color:var(--cm-warn-text);}
[data-cm-trend][data-dir="down"]{color:var(--cm-ok);}
[data-cm-trend][data-dir="flat"]{color:var(--cm-text-dim);}
/* 退出码徽标：只在对得上退出码非 0 时出现，红色但不铺满。 */
[data-cm-exitbad]{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;
  border-radius:var(--cm-r-xs);font-size:var(--cm-f-xs);font-weight:600;
  color:var(--cm-danger);background:var(--cm-danger-soft);border:1px solid var(--cm-danger-line);
  font-variant-numeric:tabular-nums;}
/* 端口胶囊：把 0.0.0.0:8080->80/tcp 拆成能一眼扫的几段，而不是一整行字符串。 */
[data-cm-ports]{display:flex;flex-direction:column;gap:var(--cm-s2);margin-top:var(--cm-s3);}
[data-cm-portrow]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;
  padding:var(--cm-s2) var(--cm-s3);border:1px solid var(--cm-line-soft);
  border-radius:var(--cm-r-sm);background:var(--cm-base);}
[data-cm-portpill]{display:inline-flex;align-items:center;padding:1px 7px;
  border-radius:var(--cm-r-xs);background:var(--cm-accent-soft);color:var(--cm-accent);
  border:1px solid var(--cm-accent-line);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-xs);
  font-variant-numeric:tabular-nums;}
[data-cm-portpill][data-muted]{background:transparent;color:var(--cm-text-2);
  border-color:var(--cm-line);}
[data-cm-portarrow]{color:var(--cm-text-dim);font-size:var(--cm-f-xs);}

/* 身份信息折叠：原生 details，零 JS。 */
[data-cm-details]{border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);
  padding:var(--cm-s3) var(--cm-s4);margin-bottom:var(--cm-s4);}
[data-cm-details] summary{cursor:pointer;font-size:var(--cm-f-sm);font-weight:600;
  color:var(--cm-text-dim);letter-spacing:.04em;list-style:none;}
[data-cm-details] summary::-webkit-details-marker{display:none;}
[data-cm-details] summary::before{content:"\\25B8 ";display:inline-block;
  transition:transform var(--cm-fast) var(--cm-ease);}
[data-cm-details][open] summary::before{content:"\\25BE ";}
[data-cm-details] summary:hover{color:var(--cm-text-2);}
[data-cm-details] [data-cm-kv]{margin-top:var(--cm-s3);}

/* 危险操作视觉后退：一条警示边框把它们圈住，不靠大红色块抢注意力。 */
[data-cm-dangerzone]{display:flex;gap:var(--cm-s2);align-items:center;flex-wrap:wrap;
  margin-top:var(--cm-s3);padding-top:var(--cm-s3);
  border-top:1px dashed var(--cm-danger-line);}

/* ── 状态点：带一圈同色光晕，比纯色点更有辨识度 ── */
[data-cm-dot]{width:8px;height:8px;border-radius:var(--cm-r-full);flex:none;
  background:var(--cm-text-dim);color:var(--cm-text-dim);
  box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent);
  transition:background-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-dot][data-on]{background:var(--cm-ok);color:var(--cm-ok);}
[data-cm-dot][data-off]{background:var(--cm-text-dim);color:var(--cm-text-dim);}
[data-cm-dot][data-warn]{background:var(--cm-warn);color:var(--cm-warn);}
/* 异常退出以前和「已停止」长得一模一样（都是灰点），这两个人必须分得开。 */
[data-cm-dot][data-bad]{background:var(--cm-danger);color:var(--cm-danger);}


/* ── 列表行：一张微遥测卡（左指示条 + 双色 2px 进度） ── */
[data-cm-row]{position:relative;display:flex;align-items:center;gap:var(--cm-s2);padding:9px 10px;
  margin-bottom:var(--cm-s1);border-radius:var(--cm-r-sm);cursor:pointer;
  border:var(--cm-hairline);background:var(--cm-surface);overflow:hidden;
  transition:background-color var(--cm-fast) var(--cm-ease),border-color var(--cm-fast) var(--cm-ease);}
[data-cm-row]:hover{background:var(--cm-surface-hover);border-color:var(--cm-line-strong);}
[data-cm-row][data-active]{border-color:var(--cm-accent-line);
  background:linear-gradient(90deg,var(--cm-accent-soft),transparent 68%),var(--cm-surface);}
/* 选中态：左侧 2px 电光青竖条，比整行变色更安静也更准 */
[data-cm-row][data-active]::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:2px;
  border-radius:0 2px 2px 0;background:var(--cm-accent);box-shadow:var(--cm-glow-accent);}
/* 双色微进度：CPU 青、内存绿；内存那条只在有上限时才渲染 */
[data-cm-bars]{display:flex;gap:4px;margin-top:6px;height:2px;}
/* 轨道用 line-strong：空轨也要能看出「这是一根条」，而不是一道卡片分隔线 */
[data-cm-bars]>i{display:block;flex:1;height:2px;border-radius:2px;
  background:var(--cm-line-strong);overflow:hidden;}
/* min-width 是关键：CPU 0.77% 在 98px 轨道上只有 0.75px，纯按比例画等于没有。
   给一个 3px 下限，「有一点负载」和「真的 0」才能靠眼睛分开，比例仍由 width 决定。 */
[data-cm-bars]>i>b{display:block;height:100%;border-radius:2px;min-width:3px;}
[data-cm-bars]>i[data-kind='cpu']>b{background:var(--cm-accent);}
[data-cm-bars]>i[data-kind='mem']>b{background:var(--cm-ok);}
[data-cm-rmain]{flex:1;min-width:0;}
[data-cm-rname]{font-size:var(--cm-f-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.45;}
[data-cm-rmeta]{font-size:var(--cm-f-xs);color:var(--cm-text-dim);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;line-height:1.45;}
[data-cm-live]{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-xs);
  color:var(--cm-text-2);font-variant-numeric:tabular-nums;}

/* ── 重建差量表：点之前得看清改了哪几项、原来是什么 ── */
[data-cm-diff]{margin-top:var(--cm-s4);padding-top:var(--cm-s3);
  border-top:1px dashed var(--cm-warn-line);display:flex;flex-direction:column;
  gap:var(--cm-s2);}
[data-cm-diff] [data-cm-portrow]{background:transparent;border-color:var(--cm-line);}
/* ── 占用条 ── */
/* 数据类元素只给「位移」一点过渡（0.22s，远小于 4 秒轮询，不会蠕动）；
   数字本身一律不加 transition —— 轮询重绘时数字滑动比瞬变更难读。 */
[data-cm-meter]{position:relative;height:3px;border-radius:var(--cm-r-full);
  background:var(--cm-line);margin-top:var(--cm-s1);}
[data-cm-meter][data-tall]{height:6px;}
[data-cm-meter] i{display:block;height:100%;background:var(--cm-ok);border-radius:inherit;
  transition:width .22s var(--cm-ease),background-color var(--cm-fast) var(--cm-ease);}
[data-cm-meter][data-warn] i{background:var(--cm-warn);}
[data-cm-meter][data-bad] i{background:var(--cm-danger);}
/* 第二阈值刻度：只在真有第二个上限（如 memory-reservation < memory）时才画。 */
[data-cm-meter] u{position:absolute;top:-2px;bottom:-2px;width:0;
  border-left:1px solid var(--cm-text-dim);pointer-events:none;}
[data-cm-host]{display:grid;grid-template-columns:1fr 1fr;gap:var(--cm-s4);margin-top:var(--cm-s2);}
[data-cm-formrow]{display:flex;gap:var(--cm-s2);align-items:center;margin:var(--cm-s3) 0;flex-wrap:wrap;}
[data-cm-check]{accent-color:var(--cm-accent);margin:0 2px 0 0;flex:none;width:13px;height:13px;cursor:pointer;}
[data-cm-bulk]{display:flex;gap:var(--cm-s2);align-items:center;padding:var(--cm-s2) var(--cm-s4);
  border-bottom:1px solid var(--cm-line);background:var(--cm-surface-hover);flex:none;font-size:var(--cm-f-xs);}
[data-cm-bulk] [data-cm-btn]{padding:2px 8px;font-size:var(--cm-f-xs);}
[data-cm-formrow] [data-cm-input]{flex:1;min-width:160px;}
[data-cm-nodehint]{font-size:var(--cm-f-xs);color:var(--cm-warn-text);padding:2px var(--cm-s2) var(--cm-s2);
  line-height:1.5;word-break:break-all;}

/* ── 详情区 ── */
/* min-height:0 不能少：flex 子项的 min-height 默认 auto，意思是「不许比内容矮」，
   于是 data-cm-detail 会被内容撑高，里面 data-cm-dbody 的 overflow:auto 就拿不到可滚的高度，
   整页被顶出屏幕、被宿主裁掉 —— 看着就是「没有滚轮」。 */
[data-cm-detail]{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
[data-cm-tabs]{display:flex;gap:var(--cm-s1);padding:var(--cm-s3) var(--cm-s5) 0;
  border-bottom:1px solid var(--cm-line-soft);flex:none;}
/* 二级 tab：不堆边框，只留一条发光下划线 —— 描边越少，界面越整齐 */
[data-cm-tab]{position:relative;padding:8px 14px;font-size:var(--cm-f-sm);border-radius:0;cursor:pointer;
  border:0;background:transparent;color:var(--cm-text-dim);
  font-family:inherit;line-height:1.4;
  transition:color var(--cm-fast) var(--cm-ease);}
[data-cm-tab]:hover{color:var(--cm-text);}
[data-cm-tab][data-on]{color:var(--cm-text);}
[data-cm-tab][data-on]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;
  height:2px;border-radius:2px;background:var(--cm-accent);box-shadow:var(--cm-glow-accent);}
[data-cm-dbody]{overflow:auto;min-height:0;flex:1;padding:var(--cm-s4) var(--cm-s6) var(--cm-s7);}

/* ── 卡片：深色微透玻璃 + 1px 切面高光（悬浮只换边色，不抬升、不缩放） ── */
[data-cm-card]{position:relative;border:var(--cm-hairline);border-radius:var(--cm-r-lg);
  background:var(--cm-surface);padding:var(--cm-s5);margin-bottom:var(--cm-s4);
  backdrop-filter:var(--cm-blur);-webkit-backdrop-filter:var(--cm-blur);
  box-shadow:var(--cm-shadow-md),var(--cm-glow-top);
  transition:border-color var(--cm-slow) var(--cm-ease);}
/* 顶缘中间亮、两头透明的细线：整块卡片的精致感就来自这一道 */
[data-cm-card]::before{content:'';position:absolute;top:0;left:12%;right:12%;height:1px;
  background:var(--cm-toplight);pointer-events:none;}
[data-cm-card]:hover{border-color:var(--cm-line-strong);}
[data-cm-kv]{display:grid;grid-template-columns:96px 1fr;gap:var(--cm-s2) var(--cm-s4);font-size:var(--cm-f-sm);}
[data-cm-kv] b{font-weight:500;color:var(--cm-text-dim);}
[data-cm-mono]{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-sm);word-break:break-all;}
[data-cm-pre]{background:var(--cm-base);border-radius:var(--cm-r-md);border:1px solid var(--cm-line-soft);
  padding:var(--cm-s3) var(--cm-s4);overflow:auto;max-height:60vh;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-sm);white-space:pre-wrap;
  word-break:break-word;margin:0;line-height:1.55;}
[data-cm-actions]{display:flex;flex-wrap:wrap;row-gap:var(--cm-s2);gap:var(--cm-s2);margin-top:var(--cm-s4);}

/* ── 表单控件：focus 用光晕而不是只换边框色 ── */
[data-cm-input],[data-cm-select]{background:var(--cm-base);border:1px solid var(--cm-line-strong);
  border-radius:var(--cm-r-sm);color:inherit;padding:5px 9px;font-size:var(--cm-f-sm);font-family:inherit;
  outline:none;box-sizing:border-box;
  transition:border-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-input]:focus,[data-cm-select]:focus{border-color:var(--cm-accent);box-shadow:var(--cm-ring);}
[data-cm-form]{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));
  gap:var(--cm-s3) var(--cm-s4);align-items:end;max-width:1000px;}
[data-cm-sec]{grid-column:1 / -1;margin:var(--cm-s5) 0 var(--cm-s1);font-size:var(--cm-f-xs);font-weight:650;
  color:var(--cm-text-dim);letter-spacing:.04em;text-transform:uppercase;}
[data-cm-field]{display:flex;flex-direction:column;gap:var(--cm-s1);min-width:0;}
[data-cm-field] label{font-size:var(--cm-f-xs);color:var(--cm-text-dim);}
[data-cm-checkline]{display:inline-flex;align-items:center;gap:var(--cm-s2);
  font-size:var(--cm-f-xs);color:var(--cm-text-2);cursor:pointer;margin-top:var(--cm-s2);}

/* ── 待确认区 ── */
[data-cm-pending]{flex:none;border-top:1px solid var(--cm-line);background:var(--cm-layer-2);
  max-height:34vh;overflow:auto;}
[data-cm-phead]{display:flex;align-items:center;gap:var(--cm-s3);padding:var(--cm-s3) var(--cm-s6);
  font-size:var(--cm-f-sm);font-weight:650;}
[data-cm-prow]{display:flex;align-items:center;gap:var(--cm-s4);padding:var(--cm-s2) var(--cm-s6);
  border-top:1px solid var(--cm-line-soft);
  transition:background-color var(--cm-fast) var(--cm-ease);}
[data-cm-prow]:hover{background:var(--cm-hover);}
[data-cm-psummary]{flex:1;min-width:0;font-size:var(--cm-f-sm);}
[data-cm-pexpiry]{font-size:var(--cm-f-xs);color:var(--cm-text-dim);font-variant-numeric:tabular-nums;}

/* 预演清单：确认之前把「会发生什么」摊开，危险项与保险项用不同色调区分 */
[data-cm-plan]{margin-top:var(--cm-s2);display:flex;flex-direction:column;gap:2px;
  font-size:var(--cm-f-xs);line-height:1.6;}
[data-cm-planitem]{color:var(--cm-text-2);}
[data-cm-planitem][data-tone='danger']{color:var(--cm-danger);}
[data-cm-planitem][data-tone='warn']{color:var(--cm-warn-text);}
[data-cm-planitem][data-tone='ok']{color:var(--cm-ok);}
[data-cm-planblock]{margin-top:var(--cm-s1);padding:2px 8px;border-radius:var(--cm-r-xs);
  color:var(--cm-warn-text);background:var(--cm-warn-soft);
  box-shadow:inset 0 0 0 1px var(--cm-warn-line);}

/* ── 任务抽屉：长操作在地板上排队，进度与尾部输出都在这里 ── */
[data-cm-jobs]{flex:none;border-top:1px solid var(--cm-line);background:var(--cm-layer-2);
  max-height:32vh;overflow:auto;}
[data-cm-jhead]{display:flex;align-items:center;gap:var(--cm-s3);padding:var(--cm-s3) var(--cm-s6);
  font-size:var(--cm-f-sm);font-weight:650;}
[data-cm-jrow]{display:flex;align-items:center;gap:var(--cm-s3);padding:var(--cm-s2) var(--cm-s6);
  border-top:1px solid var(--cm-line-soft);}
[data-cm-jmain]{flex:1;min-width:0;font-size:var(--cm-f-sm);}
[data-cm-jlabel]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-cm-jmeta]{font-size:var(--cm-f-xs);color:var(--cm-text-dim);font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-cm-jstate]{flex:none;font-size:var(--cm-f-xs);padding:1px 7px;border-radius:var(--cm-r-xs);
  color:var(--cm-text-2);background:var(--cm-surface);box-shadow:inset 0 0 0 1px var(--cm-line);}
[data-cm-jstate][data-tone='running']{color:var(--cm-accent);box-shadow:inset 0 0 0 1px var(--cm-accent-line);}
[data-cm-jstate][data-tone='failed']{color:var(--cm-danger);box-shadow:inset 0 0 0 1px var(--cm-danger-line);}
[data-cm-jstate][data-tone='done']{color:var(--cm-ok);box-shadow:inset 0 0 0 1px var(--cm-ok-line);}
[data-cm-jtail]{margin:0 var(--cm-s6) var(--cm-s3);max-height:22vh;}

/* ── 时间窗切换（1h / 6h / 24h）：只在负载卡上用 ── */
[data-cm-range]{display:inline-flex;gap:2px;flex:none;}
[data-cm-rangeitem]{border:0;background:none;padding:0 4px;font:inherit;font-size:var(--cm-f-xs);
  color:var(--cm-text-dim);cursor:pointer;border-radius:var(--cm-r-xs);}
[data-cm-rangeitem][data-on]{color:var(--cm-accent);background:var(--cm-accent-soft);
  box-shadow:inset 0 0 0 1px var(--cm-accent-line);}

/* ── 健康检查：状态徽章 + 最近几次输出 ── */
[data-cm-health]{margin-left:var(--cm-s2);padding:1px 7px;border-radius:var(--cm-r-xs);
  font-size:var(--cm-f-xs);font-weight:600;color:var(--cm-text-2);
  background:var(--cm-surface);box-shadow:inset 0 0 0 1px var(--cm-line);}
[data-cm-health][data-tone='healthy']{color:var(--cm-ok);background:var(--cm-ok-soft);
  box-shadow:inset 0 0 0 1px var(--cm-ok-line);}
[data-cm-health][data-tone='unhealthy']{color:var(--cm-danger);background:var(--cm-danger-soft);
  box-shadow:inset 0 0 0 1px var(--cm-danger-line);}
[data-cm-health][data-tone='starting']{color:var(--cm-warn-text);background:var(--cm-warn-soft);
  box-shadow:inset 0 0 0 1px var(--cm-warn-line);}
[data-cm-healthlog]{display:flex;flex-direction:column;gap:3px;font-size:var(--cm-f-xs);}
[data-cm-healthrow]{display:flex;gap:var(--cm-s2);align-items:baseline;min-width:0;
  color:var(--cm-text-2);}
[data-cm-healthrow][data-tone='bad']{color:var(--cm-danger);}
[data-cm-healthout]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Menlo,Consolas,monospace;}

/* ── 空态 / 提示条 ── */
[data-cm-empty]{padding:var(--cm-s7) var(--cm-s5);text-align:center;color:var(--cm-text-dim);
  font-size:var(--cm-f-sm);line-height:1.7;}
[data-cm-toast]{position:sticky;bottom:var(--cm-s4);margin:0 var(--cm-s6) var(--cm-s4);
  padding:var(--cm-s3) var(--cm-s4);border-radius:var(--cm-r-md);font-size:var(--cm-f-sm);line-height:1.5;
  background:var(--cm-layer-2);border:1px solid var(--cm-line-strong);
  box-shadow:var(--cm-shadow-lg);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}
[data-cm-toast][data-bad]{border-color:var(--cm-danger-line);color:var(--cm-danger);}
[data-cm-warn]{color:var(--cm-warn-text);}
[data-cm-dim]{color:var(--cm-text-dim);}

/* ── 胶囊标签 ── */
[data-cm-chips]{display:flex;gap:var(--cm-s2);flex-wrap:wrap;}
[data-cm-chip]{border:1px solid var(--cm-line-strong);border-radius:var(--cm-r-full);
  padding:3px 11px;font-size:var(--cm-f-xs);cursor:pointer;background:transparent;color:var(--cm-text-2);
  font-family:inherit;line-height:1.4;
  transition:background-color var(--cm-fast) var(--cm-ease),border-color var(--cm-fast) var(--cm-ease),
    color var(--cm-fast) var(--cm-ease);}
[data-cm-chip]:hover{background:var(--cm-hover);color:var(--cm-text);}
[data-cm-chip]:focus-visible{outline:none;box-shadow:var(--cm-ring);}
[data-cm-chip][data-on]{background:var(--cm-accent);border-color:transparent;color:var(--cm-on-accent);}

/* ── 顶部导航：分段控件质感 ── */
[data-cm-nav]{display:flex;gap:2px;align-items:center;padding:3px;
  border-radius:var(--cm-r-md);background:var(--cm-layer-2);
  border:1px solid var(--cm-line-soft);box-shadow:var(--cm-inset-groove);}
[data-cm-nav] button{border:1px solid transparent;background:transparent;color:var(--cm-text-dim);
  font-family:inherit;font-size:var(--cm-f-sm);border-radius:var(--cm-r-sm);padding:5px 12px;cursor:pointer;
  line-height:1.4;
  transition:background-color var(--cm-fast) var(--cm-ease),color var(--cm-fast) var(--cm-ease),
    box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-nav] button:hover{background:var(--cm-hover);color:var(--cm-text);}
[data-cm-nav] button[data-on]{background:var(--cm-active);color:var(--cm-text);
  border-color:var(--cm-accent-line);box-shadow:var(--cm-glow-top),var(--cm-glow-accent);}

/* ── compose 项目卡片 ── */
[data-cm-projgrid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--cm-s3);}
[data-cm-projcard]{border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);
  padding:var(--cm-s3) var(--cm-s4);cursor:pointer;background:var(--cm-surface);text-align:left;
  color:inherit;font-family:inherit;width:100%;box-shadow:var(--cm-shadow-sm);
  transition:background-color var(--cm-fast) var(--cm-ease),border-color var(--cm-fast) var(--cm-ease),
    box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-projcard]:hover{background:var(--cm-surface-hover);box-shadow:var(--cm-shadow-md);}
[data-cm-projcard][data-on]{border-color:var(--cm-accent-line);background:var(--cm-accent-soft);}

/* ── 表格：独立边框 + 行 hover ── */
[data-cm-table]{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--cm-f-sm);}
[data-cm-table] th{text-align:left;font-weight:650;font-size:var(--cm-f-xs);color:var(--cm-text-dim);
  padding:var(--cm-s2) var(--cm-s3);border-bottom:1px solid var(--cm-line-soft);
  white-space:nowrap;letter-spacing:.02em;}
[data-cm-table] td{padding:7px var(--cm-s3);border-bottom:1px solid var(--cm-line-soft);vertical-align:top;}
[data-cm-table] tbody tr{transition:background-color var(--cm-fast) var(--cm-ease);}
[data-cm-table] tbody tr:hover{background:var(--cm-hover);}
[data-cm-table] tbody tr:last-child td{border-bottom:0;}


[data-cm-netrow]{padding:var(--cm-s3) 0;border-top:1px solid var(--cm-line-soft);}
[data-cm-netrow]:first-of-type{border-top:0;}
[data-cm-editor]{width:100%;box-sizing:border-box;min-height:320px;resize:vertical;outline:none;
  background:var(--cm-base);color:inherit;border:1px solid var(--cm-line-strong);
  border-radius:var(--cm-r-md);padding:var(--cm-s3);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--cm-f-sm);line-height:1.6;
  transition:border-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-editor]:focus{border-color:var(--cm-accent);box-shadow:var(--cm-ring);}
[data-cm-logbox]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--cm-f-sm);
  line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:360px;overflow:auto;
  background:var(--cm-base);border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);
  padding:var(--cm-s3);margin:0;}
[data-cm-line]{display:flex;gap:var(--cm-s3);align-items:center;flex-wrap:wrap;}

/* ── 状态标签：柔色底 + 同色描边 ── */
/* 容器视图的返回入口：跟普通 tab 同形，但更暗一档，读起来像「往回」 */
[data-cm-back]{margin-right:var(--cm-s3);color:var(--cm-text-dim);}
[data-cm-back]:hover{color:var(--cm-accent);}
[data-cm-tag]{font-size:var(--cm-f-xs);border-radius:var(--cm-r-full);padding:2px 8px;line-height:1.5;
  border:1px solid var(--cm-line-strong);white-space:nowrap;
  transition:border-color var(--cm-fast) var(--cm-ease),color var(--cm-fast) var(--cm-ease),
    background-color var(--cm-fast) var(--cm-ease);}
[data-cm-tag][data-ok]{border-color:var(--cm-ok-line);color:var(--cm-ok);background:var(--cm-ok-soft);}
[data-cm-tag][data-bad]{border-color:var(--cm-danger-line);color:var(--cm-danger);background:var(--cm-danger-soft);}
[data-cm-tag][data-warn]{border-color:var(--cm-warn-line);color:var(--cm-warn-text);background:var(--cm-warn-soft);}
[data-cm-hintbox]{font-size:var(--cm-f-sm);color:var(--cm-text-dim);margin-top:var(--cm-s2);line-height:1.6;}
/* ── Podman secret：名字一行，值永不回显 ── */
[data-cm-secrets]{display:flex;flex-direction:column;gap:var(--cm-s3);min-height:0;flex:1;}
[data-cm-srow]{display:flex;align-items:flex-start;gap:var(--cm-s2);padding:6px 0;
  border-top:1px solid var(--cm-line-soft);}
[data-cm-srow]:first-child{border-top:0;}
[data-cm-srow] [data-cm-btn]{flex:none;}

/* ── Quadlet：一行一个 unit，状态点 + 文件 + 镜像 ── */
[data-cm-quadlet]{display:flex;flex-direction:column;gap:var(--cm-s3);min-height:0;flex:1;}
[data-cm-qrow]{display:flex;align-items:flex-start;gap:var(--cm-s2);padding:6px 0;
  border-top:1px solid var(--cm-line-soft);}
[data-cm-qrow]:first-child{border-top:0;}
[data-cm-qname]{font-size:var(--cm-f-sm);line-height:1.45;
  font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;}
[data-cm-qmeta]{font-size:var(--cm-f-xs);line-height:1.5;margin-top:1px;word-break:break-word;}

/* ── 能力体检：一条一条列，状态点用 Dot，修复命令可复制 ── */
[data-cm-cap]{display:flex;flex-direction:column;gap:var(--cm-s3);min-height:0;flex:1;}
[data-cm-chipwrap]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;}
[data-cm-capsum]{margin-bottom:var(--cm-s2);}
[data-cm-caplist]{display:flex;flex-direction:column;min-height:0;}
[data-cm-caprow]{display:flex;align-items:flex-start;gap:var(--cm-s2);
  padding:6px 0;border-top:1px solid var(--cm-line-soft);}
[data-cm-caprow]:first-child{border-top:0;}
[data-cm-capname]{font-size:var(--cm-f-sm);line-height:1.45;color:var(--cm-text);}
[data-cm-capdetail]{font-size:var(--cm-f-xs);line-height:1.5;margin-top:1px;word-break:break-word;}
[data-cm-caprow] [data-cm-btn]{flex:none;}

/* ── 容器内网络排障：判读在上，原始输出折在下面 ── */
[data-cm-diag]{display:flex;flex-direction:column;gap:var(--cm-s3);min-height:0;flex:1;}
[data-cm-diaghost]{width:150px;flex:none;padding:4px 8px;font-size:var(--cm-f-sm);box-sizing:border-box;}
[data-cm-diagport]{width:72px;flex:none;padding:4px 8px;font-size:var(--cm-f-sm);box-sizing:border-box;}
[data-cm-dnotes]{display:flex;flex-direction:column;gap:var(--cm-s1);}
[data-cm-dnote]{font-size:var(--cm-f-sm);line-height:1.5;padding:5px var(--cm-s2);
  border-left:2px solid var(--cm-line-strong);color:var(--cm-text);}
[data-cm-dnote][data-level='warn']{border-left-color:var(--cm-danger);color:var(--cm-danger);}
[data-cm-dnote][data-level='ok']{border-left-color:var(--cm-accent);}
[data-cm-dnote][data-level='unknown']{border-left-color:var(--cm-line-strong);color:var(--cm-text-dim);}
[data-cm-dsecs]{display:flex;flex-direction:column;gap:var(--cm-s1);min-height:0;}
[data-cm-dsec]{border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-sm);
  background:var(--cm-layer-2);overflow:hidden;}
[data-cm-dsec] summary{cursor:pointer;padding:5px var(--cm-s2);font-size:var(--cm-f-sm);
  color:var(--cm-text);list-style:none;}
[data-cm-dsec] summary::-webkit-details-marker{display:none;}
[data-cm-dsec] summary::before{content:'▸';display:inline-block;width:12px;
  color:var(--cm-text-dim);transition:transform var(--cm-fast) var(--cm-ease);}
[data-cm-dsec][open] summary::before{transform:rotate(90deg);}
[data-cm-dout]{margin:0;padding:var(--cm-s2);border-top:1px solid var(--cm-line-soft);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-xs);
  line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--cm-text);
  max-height:280px;overflow:auto;}

/* ── 容器内文件：左边目录树，右边编辑器（窄屏上下堆） ── */
[data-cm-files]{display:flex;flex-direction:column;gap:var(--cm-s3);min-height:0;flex:1;}
[data-cm-fhead]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;}
[data-cm-crumbs]{display:flex;align-items:center;gap:2px;flex:1;min-width:0;flex-wrap:wrap;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-sm);}
[data-cm-crumb]{border:0;background:none;color:var(--cm-text-dim);cursor:pointer;
  padding:2px 5px;border-radius:var(--cm-r-xs);font:inherit;
  transition:background-color var(--cm-fast) var(--cm-ease),color var(--cm-fast) var(--cm-ease);}
[data-cm-crumb]:hover{background:var(--cm-hover);color:var(--cm-text);}
[data-cm-crumb]:focus-visible{outline:none;box-shadow:var(--cm-ring);}
[data-cm-crumbsep]{color:var(--cm-text-dim);opacity:.6;}
[data-cm-facts]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;justify-content:flex-end;}
[data-cm-btn][data-cm-compact]{padding:3px 8px;font-size:var(--cm-f-xs);}
[data-cm-input][data-cm-fnew]{width:132px;flex:none;padding:4px 8px;font-size:var(--cm-f-sm);box-sizing:border-box;}
[data-cm-fgrid]{display:flex;gap:var(--cm-s4);min-height:0;flex:1;align-items:flex-start;}
[data-cm-fcol]{flex:0 0 300px;min-width:0;display:flex;flex-direction:column;
  border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);background:var(--cm-layer-2);
  overflow:hidden;max-height:520px;}
[data-cm-flist]{overflow:auto;min-height:0;}
[data-cm-frow]{display:flex;align-items:center;gap:var(--cm-s2);padding:4px var(--cm-s2);
  border-bottom:1px solid var(--cm-line-soft);
  transition:background-color var(--cm-fast) var(--cm-ease);}
[data-cm-frow]:last-child{border-bottom:0;}
[data-cm-frow]:hover{background:var(--cm-surface-hover);}
[data-cm-frow][data-on]{background:var(--cm-accent-soft);}
[data-cm-fopen]{display:flex;align-items:center;gap:var(--cm-s2);border:0;background:none;
  color:inherit;font:inherit;cursor:pointer;flex:1;min-width:0;text-align:left;padding:0;}
[data-cm-fopen]:focus-visible{outline:none;box-shadow:var(--cm-ring);border-radius:var(--cm-r-xs);}
[data-cm-ficon]{flex:none;width:12px;color:var(--cm-text-dim);font-size:var(--cm-f-xs);}
[data-cm-ficon][data-kind='dir']{color:var(--cm-accent);}
[data-cm-fname]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--cm-f-sm);}
[data-cm-fsize]{flex:none;color:var(--cm-text-dim);font-size:var(--cm-f-xs);
  font-variant-numeric:tabular-nums;}
[data-cm-feditor]{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--cm-s2);
  border:1px solid var(--cm-line-soft);border-radius:var(--cm-r-md);background:var(--cm-layer-2);
  padding:var(--cm-s3);min-height:0;}
[data-cm-feh]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;}
[data-cm-fename]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-sm);}
[data-cm-ftext]{flex:1;min-height:240px;resize:vertical;width:100%;box-sizing:border-box;
  background:var(--cm-base);border:1px solid var(--cm-line-strong);border-radius:var(--cm-r-sm);
  color:inherit;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-sm);
  line-height:1.55;padding:var(--cm-s2);outline:none;
  transition:border-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-ftext]:focus{border-color:var(--cm-accent);box-shadow:var(--cm-ring);}
@media (max-width:900px){
  [data-cm-fgrid]{flex-direction:column;}
  [data-cm-fcol]{flex:none;width:100%;max-height:340px;}
}

/* ── 终端 ── */
[data-cm-term-wrap]{display:flex;flex-direction:column;min-height:0;gap:var(--cm-s2);}
[data-cm-term-bar]{display:flex;align-items:center;gap:var(--cm-s2);flex-wrap:wrap;}
[data-cm-term-bar-group]{display:inline-flex;align-items:center;gap:1px;
  border:1px solid var(--cm-line-strong);border-radius:var(--cm-r-sm);
  background:var(--cm-surface);overflow:hidden;}
[data-cm-term-bar-group]>button{border:0;background:transparent;color:var(--cm-text-dim);
  font:inherit;font-size:var(--cm-f-sm);line-height:1;padding:5px 8px;cursor:pointer;
  transition:background-color var(--cm-fast) var(--cm-ease),color var(--cm-fast) var(--cm-ease);}
[data-cm-term-bar-group]>button+button{border-left:1px solid var(--cm-line-soft);}
[data-cm-term-bar-group]>button:hover:not([disabled]){background:var(--cm-hover);color:var(--cm-text);}
[data-cm-term-bar-group]>button[disabled]{opacity:.4;cursor:not-allowed;}
[data-cm-term-bar-group]>[data-cm-term-size]{min-width:34px;text-align:center;
  font-variant-numeric:tabular-nums;color:var(--cm-text);cursor:default;font-size:var(--cm-f-sm);padding:5px 2px;}
[data-cm-term]{position:relative;height:clamp(260px,60vh,560px);min-height:0;
  border:1px solid var(--cm-line-strong);border-radius:var(--cm-r-md);
  padding:6px 4px 6px 8px;background:var(--cm-base);overflow:hidden;
  box-shadow:var(--cm-shadow-sm);
  transition:border-color var(--cm-fast) var(--cm-ease),box-shadow var(--cm-fast) var(--cm-ease);}
[data-cm-term]:focus-within{border-color:var(--cm-accent-line);
  box-shadow:var(--cm-shadow-md),0 0 0 1px var(--cm-accent-line);}
[data-cm-term] .xterm{height:100%;}
[data-cm-term] .xterm-viewport{background:transparent!important;}
[data-cm-term] .xterm-screen{cursor:text;}
/* 连接中 / 断线时浮一层，不用滚回顶部找按钮 */
[data-cm-term-overlay]{position:absolute;inset:0;z-index:10;display:flex;
  flex-direction:column;align-items:center;justify-content:center;gap:var(--cm-s3);
  padding:var(--cm-s4);text-align:center;
  background:color-mix(in srgb,var(--cm-base) 86%,transparent);
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}
[data-cm-term-overlay][data-bad]{background:color-mix(in srgb,var(--cm-danger-soft) 45%,var(--cm-base));}
[data-cm-term-overlay] [data-cm-overlay-title]{font-size:var(--cm-f-md);font-weight:650;color:var(--cm-text);}
[data-cm-term-overlay] [data-cm-overlay-msg]{font-size:var(--cm-f-sm);color:var(--cm-text-dim);
  max-width:46ch;line-height:1.6;word-break:break-word;}
/* 全屏：铺到视口上，Esc 退出 */
[data-cm-term-wrap][data-cm-full]{position:fixed;inset:0;z-index:9000;
  background:var(--cm-base);padding:var(--cm-s4);gap:var(--cm-s3);}
[data-cm-term-wrap][data-cm-full] [data-cm-term]{flex:1;height:auto;}
[data-cm-term-wrap][data-cm-full]::after{content:'Esc 退出全屏';position:absolute;
  right:var(--cm-s5);bottom:var(--cm-s3);font-size:var(--cm-f-xs);color:var(--cm-text-dim);
  pointer-events:none;}

/* ── 活动日志 ── */
[data-cm-audit]{display:flex;flex-direction:column;gap:1px;}
[data-cm-audit-row]{display:grid;grid-template-columns:88px 54px minmax(90px,1fr) minmax(90px,1.2fr) 70px;
  gap:var(--cm-s3);padding:6px var(--cm-s3);border-radius:var(--cm-r-sm);font-size:var(--cm-f-sm);
  align-items:center;min-width:0;transition:background-color var(--cm-fast) var(--cm-ease);}
[data-cm-audit-row]>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-cm-audit-row]:hover{background:var(--cm-hover);}
[data-cm-audit-row][data-head]{font-weight:650;color:var(--cm-text-dim);
  border-bottom:1px solid var(--cm-line);border-radius:0;position:sticky;top:0;
  background:var(--cm-base);z-index:1;}
[data-cm-audit-row][data-bad]{color:var(--cm-danger);}
[data-cm-audit-row][data-bad] span:last-child{font-weight:600;}
[data-cm-audit-tag]{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-xs);
  padding:1px 6px;border:1px solid var(--cm-line);border-radius:var(--cm-r-sm);
  color:var(--cm-text-dim);}
[data-cm-audit-tag][data-panel]{border-color:var(--cm-ok-line);color:var(--cm-ok);background:var(--cm-ok-soft);}

/* ── 端口胶囊：能点开的那种 ── */
a[data-cm-portpill]{text-decoration:none;}
a[data-cm-portpill]:hover{background:var(--cm-accent);color:var(--cm-on-accent);}
[data-cm-portext]{margin-left:3px;font-size:var(--cm-f-xs);opacity:.85;}

/* 退出码后面跟一个短标签（SIGKILL / SIGSEGV），完整解释留在 title 里 */
[data-cm-exitshort]{font-style:normal;margin-left:5px;font-size:var(--cm-f-xs);
  opacity:.85;letter-spacing:.02em;}

/* ── 窄屏（≤600px）：只修会溢出、会被裁的地方，不动信息密度 ── */
@media (max-width:600px){
  /* tab 栏：不换行、可横滚，别把四个标签竖着堆起来 */
  [data-cm-tabs]{overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
  [data-cm-tabs]::-webkit-scrollbar{display:none;}
  /* 容器行：允许折行，长镜像名不撑破 */
  [data-cm-row]{flex-wrap:wrap;row-gap:3px;}
  [data-cm-row]>*{min-width:0;}
  /* 宿主信息两块并排 → 单列 */
  [data-cm-host]{grid-template-columns:1fr;}
  /* 活动日志五行并排挤不下，改两列自动换行 */
  [data-cm-audit-row]{grid-template-columns:1fr auto;}
}

/* ═══ Obsidian Glass HUD：新增部件的材质与刻度 ═══ */

/* 主按钮：电光青渐变 + 外发光。整个界面只有它和选中态发光，亮度才有意义。 */
[data-cm-btn][data-primary]{background:linear-gradient(180deg,var(--cm-accent-hover),var(--cm-accent));
  border-color:transparent;color:var(--cm-on-accent);font-weight:600;
  box-shadow:var(--cm-glow-accent),var(--cm-glow-top);}
[data-cm-btn][data-primary]:hover{background:linear-gradient(180deg,var(--cm-accent),var(--cm-accent-hover));
  box-shadow:var(--cm-glow-accent),var(--cm-shadow-md);}

/* 刷新按钮的 4 秒脉冲环：和数据刷新同一个节拍，不是装饰动画 */
[data-cm-pulsedot]{position:relative;width:6px;height:6px;flex:none;border-radius:var(--cm-r-full);
  background:var(--cm-ok);box-shadow:var(--cm-glow-ok);}
[data-cm-pulsedot]::after{content:'';position:absolute;inset:-2px;border-radius:inherit;
  border:1px solid var(--cm-ok);opacity:0;animation:cm-pulse 4s var(--cm-ease) infinite;}
@keyframes cm-pulse{
  0%{opacity:.5;transform:scale(.72);}
  45%{opacity:0;transform:scale(1.55);}
  100%{opacity:0;transform:scale(1.55);}}

/* 待确认计数：0 条时是灰字，有货才点亮成琥珀胶囊 —— 别用常亮的红点逼人习惯警报 */
[data-cm-pendingbadge]{color:var(--cm-text-dim);}
[data-cm-pendingbadge][data-on]{margin-left:6px;padding:0 7px;border-radius:var(--cm-r-xs);
  color:var(--cm-warn);font-weight:600;background:var(--cm-warn-soft);
  box-shadow:inset 0 0 0 1px var(--cm-warn-line);}

/* 任务计数：跟待确认同一个规矩 —— 没活儿的时候是一句话，有活儿才点亮 */
[data-cm-jobbadge]{color:var(--cm-text-dim);border:0;background:none;font:inherit;
  padding:0;cursor:pointer;}
[data-cm-jobbadge][data-on]{margin-left:6px;padding:0 7px;border-radius:var(--cm-r-xs);
  color:var(--cm-accent);font-weight:600;background:var(--cm-accent-soft);
  box-shadow:inset 0 0 0 1px var(--cm-accent-line);}

/* ── Bento：宿主三格遥测（负载 / 内存 / 主盘） ── */
[data-cm-bento]{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--cm-s3);
  margin-top:var(--cm-s1);}
[data-cm-tile]{position:relative;border:var(--cm-hairline);border-radius:var(--cm-r-sm);
  background:var(--cm-layer-2);padding:var(--cm-s3);min-width:0;overflow:hidden;}
[data-cm-tilehead]{display:flex;align-items:center;gap:6px;font-size:var(--cm-f-xs);
  color:var(--cm-text-dim);letter-spacing:.04em;}
[data-cm-tileicon]{display:flex;color:var(--cm-accent);opacity:.85;}
[data-cm-big]{font-size:var(--cm-f-2xl);font-weight:600;line-height:1.15;margin-top:4px;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;}
[data-cm-bigunit]{font-size:var(--cm-f-md);font-weight:500;color:var(--cm-text-2);margin-left:1px;}
[data-cm-tilesub]{font-size:var(--cm-f-xs);color:var(--cm-text-2);margin-top:2px;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-cm-hint]{font-size:var(--cm-f-xs);color:var(--cm-text-dim);}

/* 负载折线：线细、面积淡，最后一点标一个实心圆（当前值） */
[data-cm-spark]{display:block;width:100%;height:28px;margin-top:var(--cm-s2);}
[data-cm-spark-area]{fill:var(--cm-accent-soft);stroke:none;}
[data-cm-spark-line]{fill:none;stroke:var(--cm-accent);stroke-width:1.5;
  stroke-linejoin:round;stroke-linecap:round;}
[data-cm-spark-dot]{fill:var(--cm-accent);}

/* ── 三格信息矩阵（面板 / 危险操作 / AI） ── */
[data-cm-matrix]{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--cm-s3);}
[data-cm-cell]{border:var(--cm-hairline);border-radius:var(--cm-r-sm);
  background:var(--cm-layer-2);padding:var(--cm-s3);min-width:0;}
[data-cm-cellhead]{display:flex;align-items:center;gap:6px;font-size:var(--cm-f-sm);
  margin-bottom:var(--cm-s1);}
[data-cm-cellhead] strong{font-weight:600;}
[data-cm-cellbody]{font-size:var(--cm-f-xs);color:var(--cm-text-2);line-height:1.65;}

/* ── 节点：两张子卡 + 等宽技术徽章 ── */
[data-cm-nodes]{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--cm-s3);}
[data-cm-nodecard]{border:var(--cm-hairline);border-radius:var(--cm-r-sm);
  background:var(--cm-layer-2);padding:var(--cm-s3);min-width:0;}
[data-cm-nodehead]{display:flex;align-items:center;gap:6px;font-size:var(--cm-f-sm);
  margin-bottom:var(--cm-s1);}
[data-cm-tech]{display:flex;flex-wrap:wrap;gap:4px;}
[data-cm-tip]{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--cm-f-xs);
  line-height:1.7;padding:0 6px;border-radius:var(--cm-r-xs);
  border:1px solid var(--cm-line-soft);background:var(--cm-layer-2);
  color:var(--cm-text-2);white-space:nowrap;}

/* 配置页的分段控件：同一套凹槽 + 亮药丸语言 */
[data-cm-seg]{display:inline-flex;gap:2px;padding:3px;margin-bottom:var(--cm-s4);
  border-radius:var(--cm-r-md);background:var(--cm-layer-2);
  border:1px solid var(--cm-line-soft);box-shadow:var(--cm-inset-groove);}
[data-cm-segitem][data-active]{background:var(--cm-active);color:var(--cm-text);
  box-shadow:var(--cm-glow-top);}

/* 窄屏：三格与两格全部退成单列，别横向挤成一坨 */
@media (max-width:600px){
  [data-cm-bento],[data-cm-matrix],[data-cm-nodes]{grid-template-columns:1fr;}
}
/* ── 尊重系统的降低动效偏好 ── */
@media (prefers-reduced-motion:reduce){
  [data-cm-page] *,[data-cm-page] *::before,[data-cm-page] *::after{
    transition-duration:.01ms!important;animation-duration:.01ms!important;
    animation-iteration-count:1!important;scroll-behavior:auto!important;}
}
`

    /* ───────────────────────── fetch ───────────────────────── */

    const baseHeaders = () => ({
      'x-cm-request': '1',
      'x-cm-principal': 'panel',
    })

    async function jget(path) {
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        headers: baseHeaders(),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        const error = body && body.error ? body.error : {}
        throw new Error(error.message || ('HTTP ' + res.status))
      }
      return body.data
    }

    /**
     * 容器台里子组件拿不到主组件的 setState，但「有任务入队了」这件事
     * 得让地板上的任务抽屉自动弹出来。用一个小小的模块级钩子，主组件挂载时把它换成真的。
     */
    const JOB_SINK = { open: () => {} }

    /** 长操作后端会返回 status=job；这里统一把「已入队」变成一句人话并弹出抽屉。 */
    function noteJobResult(result) {
      if (!result || result.status !== 'job' || !result.job) return null
      try { JOB_SINK.open() } catch { /* 抽屉没挂上也不影响主流程 */ }
      return result.message || ('已入队：' + (result.job.label || result.job.id))
    }

    async function jpost(path, payload) {
      const res = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...baseHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        const error = body && body.error ? body.error : {}
        throw new Error(error.message || ('HTTP ' + res.status))
      }
      return body.data
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    function Dot({ tone }) {
      const props = { 'data-cm-dot': '' }
      if (tone) props['data-' + tone] = ''
      return h('span', props)
    }

    /**
     * 内联线性图标。只留几条能一眼认出的形状，全部 24×24 网格、随 currentColor 上色，
     * 不引图标库 —— 一个面板为七个图标背一整个 iconfont 是没必要的。
     */
    const GLYPHS = {
      search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
      refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
        ['path', { d: 'M21 3v5h-5' }],
        ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
        ['path', { d: 'M8 16H3v5' }]],
      shield: [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }]],
      wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
      activity: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
      cpu: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }],
        ['rect', { x: 9, y: 9, width: 6, height: 6 }],
        ['path', { d: 'M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2' }]],
      boxes: [['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1 }],
        ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1 }]],
      disk: [['path', { d: 'M22 12H2' }],
        ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
        ['path', { d: 'M6 16h.01M10 16h.01' }]],
    }

    function Glyph({ name, size }) {
      const parts = GLYPHS[name] || []
      const px = size || 14
      return h('svg', {
        width: px, height: px, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, ...parts.map((part, index) => h(part[0], { key: index, ...part[1] })))
    }

    /**
     * 数据格：整个面板里「一个数字」只走这一种排版。
     * 材质借 [data-cm-tile]（hairline + 凹槽底 + 圆角 10），数字统一 28px 等宽，
     * 这样详情页的三块和首页的宿主三格看起来是同一个东西，而不是两套。
     */
    function DataTile({ icon, label, value, unit, sub, trail, extra }) {
      return h('div', { 'data-cm-tile': '' },
        h('div', { 'data-cm-tilehead': '' },
          icon ? h('span', { 'data-cm-tileicon': '' }, h(Glyph, { name: icon, size: 13 })) : null,
          label),
        h('div', { 'data-cm-big': '' }, value,
          unit ? h('span', { 'data-cm-bigunit': '' }, unit) : null,
          trail || null),
        sub ? h('div', { 'data-cm-tilesub': '' }, sub) : null,
        extra || null)
    }

    /** 三格信息位：一个图标、一句标题、一段说明。比 96px 宽的 kv 表更好扫。 */
    function InfoCell({ icon, title, hint }) {
      return h('div', { 'data-cm-cell': '' },
        h('div', { 'data-cm-cellhead': '' },
          h('span', { 'data-cm-tileicon': '' }, h(Glyph, { name: icon, size: 14 })),
          h('strong', null, title)),
        h('div', { 'data-cm-cellbody': '' }, hint))
    }

    function kv(entries) {
      const children = []
      entries.forEach(([key, value], index) => {
        if (value === null || value === undefined || value === '') return
        children.push(h('b', { key: 'k' + index }, key))
        children.push(h('span', { key: 'v' + index, 'data-cm-mono': typeof value === 'string' && /^[a-f0-9]{12,}$/.test(value) ? '' : undefined }, value))
      })
      return h('div', { 'data-cm-kv': '' }, children)
    }

    /**
     * 状态 → 色调，只留四档：on（跑着）/ bad（崩了）/ warn（正在变或没在服务）/ off（停着）。
     *
     * 以前 on/warn/off 三档时，「已停止」和「异常退出」都是灰点，运维一眼分不开 ——
     * 这是最要命的一条，所以 bad 必须独立。反过来，档位也不能多到需要背：
     * created / paused 都归 warn，因为它们的共同点是「现在没在提供服务」。
     */
    function stateTone(state) {
      const text = String(state || '').toLowerCase()
      if (text === 'running' || text === 'up') return 'on'
      // 自己崩掉 / 被 OOM 杀掉的，跟「手动停掉」不是一个性质。
      if (text === 'dead' || text === 'error' || text === 'oomkilled' || text === 'failed') return 'bad'
      // 正在切换：重启 / 启动 / 停止 / 暂停 / 删除 —— 都是瞬态。
      if (/^(restarting|starting|stopping|pausing|unpausing|removing|created|configured|paused|frozen)$/.test(text)) return 'warn'
      return 'off'
    }

    /**
     * 容器 → 色调。退出码非 0 的「已退出」是崩的，不是停的。
     * podman 的 137 是 OOM/被 SIGKILL，139 是段错误 —— 这两个数字值得直接露在脸上。
     */
    function containerTone(container) {
      const tone = stateTone(container && container.state)
      const code = container && container.exitCode
      if (tone === 'off' && code !== null && code !== undefined && Number(code) !== 0) return 'bad'
      return tone
    }

    /** 退出码 → 一句人话。只解释能确定的，猜的不说。 */
    function exitCodeHint(code) {
      const n = Number(code)
      if (!Number.isFinite(n) || n === 0) return ''
      if (n === 137) return '被 SIGKILL（常见于内存超限）'
      if (n === 139) return '段错误 SIGSEGV'
      if (n === 143) return '被 SIGTERM 终止'
      if (n === 126) return '命令不可执行'
      if (n === 127) return '命令不存在'
      return ''
    }
    /**
     * 退出码 → 一个短标签，跟在数字后面。
     * 只写**确定**的信号名：137 就是 SIGKILL，至于它是不是 OOM 杀的，
     * 那个猜测留在 exitCodeHint 的 title 里，不在界面上当结论。
     */
    function exitCodeShort(code) {
      const n = Number(code)
      if (!Number.isFinite(n) || n === 0) return ''
      if (n === 137) return 'SIGKILL'
      if (n === 139) return 'SIGSEGV'
      if (n === 143) return 'SIGTERM'
      if (n === 126) return 'EACCES'
      if (n === 127) return 'ENOENT'
      return ''
    }

    /** 状态词的显示名。容器状态在接口里是英文，中文运维台不该把它原样丢到界面上。 */
    const STATE_LABELS = {
      running: '运行中',
      up: '运行中',
      exited: '已退出',
      stopped: '已停止',
      paused: '已暂停',
      pausing: '暂停中',
      unpausing: '恢复中',
      frozen: '已冻结',
      created: '未启动',
      configured: '未启动',
      restarting: '重启中',
      starting: '启动中',
      stopping: '停止中',
      removing: '删除中',
      dead: '异常退出',
      error: '异常',
      failed: '失败',
      oomkilled: '内存超限被杀',
    }

    function stateLabel(state) {
      const text = String(state || '').toLowerCase()
      return STATE_LABELS[text] ?? (text || '未知')
    }

    function containerIps(container) {
      return (container.networks ?? []).map(network => network.ip).filter(Boolean)
    }

    /* ───────────────────────── 面板 ───────────────────────── */

    /* ───────────────────────── 崩溃兜底 ───────────────────────── */

    /**
     * 渲染兜底：任何子组件在渲染期抛错，React 18 会卸载整棵树 —— 表现出来就是整页白屏。
     * 这里把崩溃关在一块区域内，并把错误摊开给人看：既是不白屏的保险，
     * 也是下次定位问题的一手证据（DSH 不会把前端异常写进宿主日志）。
     */
    class PaneBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[container-manager] ' + (this.props.label || '面板') + ' 渲染失败', error, info)
        } catch {
          // 控制台都不可用就算了，别再抛
        }
      }

      retry() {
        this.setState({ error: null })
      }

      render() {
        const error = this.state.error
        if (!error) return this.props.children
        const where = this.props.label || '这块内容'
        const text = String((error && (error.stack || error.message)) || error || '未知错误')
        const head = text.split('\n').slice(0, 8).join('\n')
        return h('div', { 'data-cm-card': '', 'data-cm-crash': '' },
          h('div', { 'data-cm-warn': '' }, where + ' 渲染出错，已经拦在这里（页面其它部分还能用）'),
          h('pre', { 'data-cm-pre': '' }, head),
          h('div', { 'data-cm-actions': '' },
            h('button', { 'data-cm-btn': '', 'data-primary': '', onClick: this.retry }, '重试'),
            h('button', { 'data-cm-btn': '', onClick: () => { try { window.location.reload() } catch { /* 忽略 */ } } }, '刷新页面')),
          h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
            '把上面这几行发给汐，就能直接定位。'))
      }
    }

    /**
     * 容器实时占用。10 秒取一次 —— `podman stats --no-stream` 单次要 1~2 秒，
     * 跟着 /state 的 4 秒轮询跑会把面板拖慢。切节点或卸载就停。
     */
    /**
     * CPU 走向：每个容器只留最近 3 个采样（/stats 是 10 秒一次，约 30 秒窗口）。
     *
     * 为什么不做 sparkline：10 秒才采一个点，折线的起伏来自采样间隔而不是负载本身，
     * 那种图会让人以为自己看见了毛刺。一个 ↗ / → / ↘ 足够回答「在涨还是在落」，
     * 而且不撒谎。
     */
    const CPU_HISTORY = new Map()
    const CPU_SAMPLES = 3

    function pushCpuSamples(byNode) {
      for (const [nodeId, value] of byNode) {
        const rows = value && Array.isArray(value.containers) ? value.containers : []
        for (const row of rows) {
          const key = nodeId + '/' + row.name
          const series = CPU_HISTORY.get(key) || []
          series.push(Number(row.cpuPercent) || 0)
          while (series.length > CPU_SAMPLES) series.shift()
          CPU_HISTORY.set(key, series)
        }
      }
    }

    /** 三次采样判走向：差 1.5 个百分点以内算平。 */
    function trendOf(series) {
      const list = Array.isArray(series) ? series.map(Number).filter(Number.isFinite) : []
      if (list.length < 2) return null
      const delta = list[list.length - 1] - list[0]
      const span = list.length + ' 次采样'
      if (delta > 1.5) return { dir: 'up', text: '↗', title: '近 ' + span + '在涨' }
      if (delta < -1.5) return { dir: 'down', text: '↘', title: '近 ' + span + '在落' }
      return { dir: 'flat', text: '→', title: '近 ' + span + '基本持平' }
    }

    /*
     * 宿主负载的环形缓冲：10 秒一个点、最多 20 个（约 3 分钟）。
     *
     * 和容器 CPU 那条「只给箭头不给曲线」不冲突：容器是每台一个数组、采样 10 秒一次，
     * 每条曲线的起伏大半来自采样间隔，画出来是假毛刺；这里一台机一个数、x 轴等距、
     * 点还够密，折线才真的在描述负载。少于 2 点不画 —— 一个点连不成线。
     */
    const LOAD_HISTORY = []
    const LOAD_SAMPLES = 20

    function pushHostLoad(byNode) {
      for (const value of byNode.values()) {
        const host = value && value.host
        const one = host && host.ok && host.load ? Number(host.load.one) : NaN
        if (!Number.isFinite(one)) continue
        LOAD_HISTORY.push(one)
        while (LOAD_HISTORY.length > LOAD_SAMPLES) LOAD_HISTORY.shift()
        return
      }
    }
    /**
     * 实时占用：按节点批量取，返回 Map<节点 id, {value, problem, rows, byName}>。
     * 左侧列表是所有节点混在一起显示的，所以每个节点各要一份 ——
     * 以前只取 podman 那一份，LXC 行就永远空着。
     */
    function useStats(nodeIds) {
      const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : []
      const key = ids.join(',')
      const [byNode, setByNode] = React.useState(new Map())
      const [problems, setProblems] = React.useState(new Map())

      React.useEffect(() => {
        const list = key ? key.split(',') : []
        if (list.length === 0) return undefined
        let cancelled = false
        let timer = null
        const tick = async () => {
          const values = new Map()
          const failures = new Map()
          await Promise.all(list.map(async (id) => {
            try {
              const data = await jget('/stats?node=' + encodeURIComponent(id))
              values.set(id, data)
            } catch (e) {
              failures.set(id, e && e.message ? e.message : String(e))
            }
          }))
          if (cancelled) return
          pushCpuSamples(values)
          pushHostLoad(values)
          setByNode(values)
          setProblems(failures)
          timer = window.setTimeout(tick, 10000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer) window.clearTimeout(timer)
        }
      }, [key])

      const out = new Map()
      for (const id of key ? key.split(',') : []) {
        const value = byNode.get(id) || null
        const rows = value && Array.isArray(value.containers) ? value.containers : []
        const byName = new Map()
        for (const row of rows) byName.set(row.name, row)
        out.set(id, { value, problem: problems.get(id) || null, rows, byName })
      }
      return out
    }

    /** 字节数转人读的大小。 */
    function sizeText(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let index = 0
      while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
      return (size >= 100 ? Math.round(size) : Math.round(size * 10) / 10) + ' ' + units[index]
    }

    /**
     * 秒数 → 中文短时长：`2天14小时` / `3小时20分` / `5分` / `42秒`。
     *
     * 只给两级精度：看运行时长是为了判断「刚重启过没 / 跑了多久」，给到秒是噪声。
     * 拿不到合法秒数（undefined / NaN / 负数）就返回空串，让调用方整段不显示 —— 不编。
     */
    function formatUptime(seconds) {
      // null / undefined / 空串是「没有这个数据」，不是「0 秒」—— 后者会显示成
      // 「已运行 0秒」，看着像刚启动，其实是根本没读到 startedAt。
      if (seconds === null || seconds === undefined || seconds === '') return ''
      const total = Math.floor(Number(seconds))
      if (!Number.isFinite(total) || total < 0) return ''
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return days + '天' + (hours ? hours + '小时' : '')
      if (hours > 0) return hours + '小时' + (minutes ? minutes + '分' : '')
      if (minutes > 0) return minutes + '分'
      return (total % 60) + '秒'
    }
    /** 把文本存成文件：DSH 里没有文件对话框，用 Blob + a[download]。 */
    function downloadText(filename, text) {
      try {
        const blob = new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      } catch {
        // 存不下来就算了，别影响页面
      }
    }

    /** 提交镜像时用的默认名字：local/<容器>:<年月日-时分>。 */
    function stampName(containerName) {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const day = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      const time = pad(now.getHours()) + pad(now.getMinutes())
      return 'local/' + String(containerName || 'container') + ':' + day + '-' + time
    }

    /**
     * 一条细进度条：75% 起黄，90% 起红。
     *
     * `tick` 是可选的第二阈值刻度（0–100），只在确实存在第二个上限时才传
     * —— 比如 podman 的 memory-reservation 比 memory 小。没有第二阈值就不画，
     * 画在 100% 位置等于装饰，会让读者以为那里另有一条线。
     * `tall` 把轨道从 3px 抬到 6px，用在真正要看的水位线上。
     */
    /**
     * 宿主负载折线：只连真实采样点，不插值、不平滑、不做面积阴影以外的装饰。
     * 点少于 2 个直接不渲染 —— 一个点画成折线是在骗人。
     */
    /**
     * 宿主负载历史：来自服务端采样器落的 NDJSON，不是内存环。
     * 一分钟取一次就够 —— 新点最快也要 30 秒才产生一个。
     */
    function useHostHistory(nodeId, minutes) {
      const [state, setState] = React.useState({ series: [], info: null, problem: null })
      React.useEffect(() => {
        if (!nodeId) return undefined
        let cancelled = false
        let timer = null
        const tick = async () => {
          try {
            const data = await jget('/metrics?node=' + encodeURIComponent(nodeId)
              + '&minutes=' + encodeURIComponent(minutes) + '&points=120')
            if (!cancelled) {
              setState({
                series: Array.isArray(data.series) ? data.series : [],
                info: data.info || null,
                problem: null,
              })
            }
          } catch (e) {
            if (!cancelled) {
              setState(prev => ({ ...prev, problem: e && e.message ? e.message : String(e) }))
            }
          }
          if (!cancelled) timer = window.setTimeout(tick, 60000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer) window.clearTimeout(timer)
        }
      }, [nodeId, minutes])
      return state
    }

    function HostSpark({ series }) {
      const list = (Array.isArray(series) ? series : []).map(Number).filter(Number.isFinite)
      if (list.length < 2) return null
      const width = 100
      const height = 26
      const peak = Math.max(...list)
      const scale = peak > 0 ? peak : 1
      const step = width / (list.length - 1)
      const at = (value, index) => (index * step).toFixed(2) + ','
        + (height - (value / scale) * (height - 3) - 1.5).toFixed(2)
      const points = list.map(at).join(' ')
      const tail = at(list[list.length - 1], list.length - 1).split(',')
      return h('svg', {
        'data-cm-spark': '', viewBox: '0 0 ' + width + ' ' + height,
        preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
        title: '近 ' + list.length + ' 次采样，峰值 ' + peak.toFixed(2),
      },
        h('polygon', { 'data-cm-spark-area': '', points: '0,' + height + ' ' + points + ' ' + width + ',' + height }),
        h('polyline', { 'data-cm-spark-line': '', points, vectorEffect: 'non-scaling-stroke' }),
        h('circle', { 'data-cm-spark-dot': '', cx: tail[0], cy: tail[1], r: 1.5 }))
    }

    /**
     * 列表行里的双色微进度：CPU 一条青色、内存一条绿色。
     * 内存那条只在容器真的设了上限时才画 —— 没有上限时「已用 / 0」算不出百分比，
     * 拿它当分母画一根 100% 的条是在骗人，所以宁可少画一条。
     */
    function RowBars({ usage }) {
      if (!usage) return null
      const cpu = Math.max(0, Math.min(100, Number(usage.cpuPercent) || 0))
      const limit = Number(usage.memLimit) || 0
      const mem = limit > 0
        ? Math.max(0, Math.min(100, (Number(usage.memUsed) || 0) / limit * 100))
        : null
      if (!(cpu > 0.5) && (mem === null || !(mem > 0.5))) return null
      const bars = [h('i', { key: 'cpu', 'data-kind': 'cpu', title: 'CPU ' + cpu.toFixed(1) + '%' },
        h('b', { style: { width: cpu.toFixed(1) + '%' } }))]
      if (mem !== null) {
        bars.push(h('i', { key: 'mem', 'data-kind': 'mem', title: '占内存上限 ' + mem.toFixed(0) + '%' },
          h('b', { style: { width: mem.toFixed(1) + '%' } })))
      }
      return h('div', { 'data-cm-bars': '' }, bars)
    }

    function Meter({ percent, tick, tall }) {
      const value = Math.max(0, Math.min(100, Number(percent) || 0))
      const props = { 'data-cm-meter': '' }
      if (tall) props['data-tall'] = ''
      if (value >= 90) props['data-bad'] = ''
      else if (value >= 75) props['data-warn'] = ''
      const mark = Number(tick) > 0 && Number(tick) < 100
        ? h('u', { 'data-cm-tick': '', style: { left: Number(tick) + '%' } })
        : null
      return h('div', props, h('i', { style: { width: value + '%' } }), mark)
    }

    /**
     * 把 tab 内容的求值推迟到子组件里做。
     *
     * 直接在 Panel 的 render 里调 body()，元素创建期间的异常会被算在 Panel 头上，
     * tab 那层 PaneBoundary 根本接不到 —— 只有最外层能兜，等于白加一层。
     */
    function TabContent({ render }) {
      return render()
    }

    /**
     * 宿主网络：网卡 / 路由 / DNS / NM 连接 / 监听端口，10 秒一次。
     * 全是只读，改配置走另一个接口（挂起在待确认里）。
     */
    function useHostNet() {
      const [data, setData] = React.useState(null)
      const [problem, setProblem] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        let timer = null
        const tick = async () => {
          try {
            const value = await jget('/net/host')
            if (cancelled) return
            setData(value)
            setProblem(null)
          } catch (e) {
            if (cancelled) return
            setProblem(e && e.message ? e.message : String(e))
          }
          if (!cancelled) timer = window.setTimeout(tick, 10000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer) window.clearTimeout(timer)
        }
      }, [])

      return { data, problem }
    }

    function Panel() {
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      // 顶部四段：Podman / LXC / 宿主网络 / 活动。两套运行时彻底分页，不再混在「容器」里。
      const [view, setView] = React.useState('podman')
      // 子 tab 按页分开存，切页不会把位置弄丢。
      const [podmanTab, setPodmanTab] = React.useState('containers')
      const [lxcTab, setLxcTab] = React.useState('containers')
      const [hostTab, setHostTab] = React.useState('interfaces')
      const [selected, setSelected] = React.useState(null)
      const [tab, setTab] = React.useState('overview')
      const [filter, setFilter] = React.useState('')
      const [nodeFilter, setNodeFilter] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [createDraft, setCreateDraft] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [renameDraft, setRenameDraft] = React.useState(null)
      const [commitDraft, setCommitDraft] = React.useState(null)
      const alive = React.useRef(true)

      // 任务抽屉：长操作（克隆/快照/导出/提交）不在请求里干等，进度落在这里。
      const [jobsOpen, setJobsOpen] = React.useState(false)
      const [jobState, setJobState] = React.useState({ jobs: [], summary: null })
      const [jobTailId, setJobTailId] = React.useState('')

      // 实时占用：提前算好，容器行和概览卡都用同一份。
      const liveNode = snap && Array.isArray(snap.nodes) ? (snap.nodes.find(item => item.kind === 'podman') || null) : null
      const liveNodeId = liveNode ? liveNode.id : ''
      // 可用节点各要一份占用；不可用的请求过去也只会拿到原因，白跑一趟。
      const liveNodeIds = React.useMemo(() => {
        if (!snap || !Array.isArray(snap.nodes)) return []
        return snap.nodes.filter(item => item.available).map(item => item.id)
      }, [snap])
      const liveByNode = useStats(liveNodeIds)
      // 宿主负载的历史窗口：服务端 30 秒一个点，这里只挑要看的跨度。
      const [hostMinutes, setHostMinutes] = React.useState(60)
      const hostHistory = useHostHistory(liveNodeId, hostMinutes)
      const [netEditing, setNetEditing] = React.useState('')
      const hostNet = useHostNet()

      /** LXC 可选的网桥：宿主上真实存在的 bridge（docker0 除外，别把容器塞进 docker 的桥）。 */
      const lxcBridges = React.useMemo(() => {
        const list = (hostNet.data && hostNet.data.interfaces) || []
        return list
          .filter(item => item.type === 'bridge' && item.name !== 'docker0')
          .map(item => {
            const v4 = (item.addresses || []).filter(entry => entry.family === 'inet')[0]
            return {
              name: item.name,
              address: v4 ? v4.address + '/' + v4.prefix : '',
              state: item.state,
            }
          })
          .sort((left, right) => {
            const rank = name => (name === 'lxcbr0' ? 0 : name === 'br0' ? 1 : 2)
            const diff = rank(left.name) - rank(right.name)
            return diff !== 0 ? diff : left.name.localeCompare(right.name)
          })
      }, [hostNet.data])

      const load = React.useCallback(async (force) => {
        try {
          const data = await jget('/state' + (force ? '?refresh=1' : ''))
          if (!alive.current) return
          setSnap(data)
          setError(null)
        } catch (e) {
          if (alive.current) setError(e && e.message ? e.message : String(e))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        load(false)
        let timer = null
        const tick = () => {
          timer = setTimeout(() => {
            if (document.hidden) {
              tick()
              return
            }
            load(false).then(tick, tick)
          }, REFRESH_MS)
        }
        tick()
        const onVisible = () => { if (!document.hidden) load(false) }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          if (timer) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 5200)
        return () => clearTimeout(timer)
      }, [toast])

      // 子组件把「有任务了」推给抽屉：挂载时接上，卸载时摘掉。
      React.useEffect(() => {
        JOB_SINK.open = () => setJobsOpen(true)
        return () => { JOB_SINK.open = () => {} }
      }, [])

      /**
       * 任务轮询：抽屉关着又没活儿的时候 8 秒看一眼（只是读一个 json，不打 podman）；
       * 有活儿或者抽屉开着就 1.5 秒一跳。别让它跟主循环一样永远 4 秒刷。
       */
      React.useEffect(() => {
        let stopped = false
        let timer = null
        let hasWork = false
        const tick = async () => {
          if (!stopped && !document.hidden) {
            try {
              const data = await jget('/jobs')
              if (!stopped && data) {
                const summary = data.summary || null
                hasWork = Boolean(summary && summary.running + summary.queued > 0)
                setJobState({ jobs: Array.isArray(data.jobs) ? data.jobs : [], summary })
              }
            } catch {
              // 队列读不到只是少一块信息，不能把主界面打成错误态
            }
          }
          if (stopped) return
          timer = setTimeout(tick, hasWork || jobsOpen ? 1500 : 8000)
        }
        tick()
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      }, [jobsOpen])

      async function cancelJob(id) {
        try {
          await jpost('/jobs/' + encodeURIComponent(id) + '/cancel', {})
          setToast('已请求取消，正在收尾')
        } catch (e) {
          setToast({ bad: true, text: e && e.message ? e.message : String(e) })
        }
      }

      const nodes = snap ? snap.nodes : []
      const containers = snap ? snap.containers : []
      const networks = snap ? snap.networks : []
      const pending = (snap && snap.pending) ? snap.pending : []
      const jobSummary = jobState.summary || (snap && snap.jobs) || null
      const jobsList = jobState.jobs
      const activeJobCount = jobSummary ? jobSummary.running + jobSummary.queued : 0

      const shown = containers.filter(container => {
        if (nodeFilter && container.nodeId !== nodeFilter) return false
        if (!filter.trim()) return true
        const needle = filter.trim().toLowerCase()
        return String(container.name).toLowerCase().includes(needle) ||
          String(container.image ?? '').toLowerCase().includes(needle) ||
          String(container.state ?? '').toLowerCase().includes(needle)
      })

      const selectedContainer = selected
        ? containers.find(container => container.nodeId === selected.node && (container.name === selected.ref || container.id === selected.ref)) ?? null
        : null

      async function run(promise, successText) {
        setBusy(true)
        try {
          const result = await promise
          if (result && result.status === 'pending') {
            setToast('已挂起，等待你在下面「待确认」里点确认：' + (result.message || result.summary || ''))
          } else if (successText) {
            setToast(successText)
          }
          await load(true)
          return result
        } catch (e) {
          setToast({ bad: true, text: (e && e.message) ? e.message : String(e) })
          return null
        } finally {
          setBusy(false)
        }
      }

      async function startFromContainer(container) {
        try {
          const detail = await jget('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name))
          setCreateDraft(draftFrom(container, detail))
          setTab('create')
          setToast('已把配置填进「新建」，环境变量的值不会回填（面板只读得到键名）。')
        } catch (e) {
          setToast('读详情失败：' + (e && e.message ? e.message : String(e)))
        }
      }

      function act(container, action) {
        if (action === 'delete' && !window.confirm(`删除 ${container.name}？\n\n这会先挂起，确认后不可撤销。`)) return
        run(jpost('/actions', { node: container.nodeId, ref: container.name, action }), `${container.name}：${action} 已发出`)
      }

      async function doRename(container, value) {
        const next = String(value ?? '').trim()
        if (!next) { setToast({ bad: true, text: '新名字不能空。' }); return }
        if (next === container.name) { setToast({ bad: true, text: '新旧名字一样，不用改。' }); return }
        setBusy(true)
        try {
          await jpost('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/rename', { name: next })
          setRenameDraft(null)
          setSelected({ node: container.nodeId, ref: next })
          setToast({ text: '改名了：' + container.name + ' → ' + next })
          load(false)
        } catch (e) {
          setToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      async function doCommit(container, value) {
        const image = String(value ?? '').trim()
        if (!image) { setToast({ bad: true, text: '要给个镜像名，比如 local/名字:日期。' }); return }
        setBusy(true)
        try {
          const result = await jpost('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/commit', { image })
          setCommitDraft(null)
          const queued = noteJobResult(result)
          if (queued) {
            setToast({ text: queued })
          } else if (result && result.status === 'pending') {
            setToast('提交已在「待确认」里挂起 —— 去页面底部点一下才真的做。')
          } else {
            setToast({ text: '已提交成镜像 ' + image })
          }
          load(false)
        } catch (e) {
          setToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      /** 批量启停：串行跑，逐条汇总，别把 N 个写请求一次砸出去。 */
      async function runBatch(action) {
        if (picked.length === 0) { setToast({ bad: true, text: '先勾几个容器。' }); return }
        setBusy(true)
        let done = 0
        const failed = []
        for (const key of picked) {
          const slash = key.indexOf('/')
          const node = key.slice(0, slash)
          const ref = key.slice(slash + 1)
          try {
            await jpost('/actions', { node, ref: name, action })
            done += 1
          } catch (e) {
            failed.push(ref + '：' + (e && e.message ? e.message : String(e)))
          }
        }
        setBusy(false)
        setPicked([])
        setToast({
          bad: failed.length > 0,
          text: '批量' + action + '：成了 ' + done + ' 个' +
            (failed.length ? '，失败 ' + failed.length + ' 个 — ' + failed.slice(0, 2).join('；') : ''),
        })
        load(false)
      }

      function confirmPending(token) {
        run(jpost('/actions/confirm', { token }), '已执行。')
      }

      function cancelPending(token) {
        run(jpost('/actions/cancel', { token }), '已取消。')
      }

      /**
       * 「＋ 新建」跟着当前页走：在 LXC 页就建 LXC，其余回 Podman。
       * 必须留在 Panel 内部 —— 它要用 Panel 里的 setter，搬到模块级就是 ReferenceError。
       */
      function startCreate() {
        setCreateDraft(null)
        setSelected(null)
        setTab('create')
        if (view === 'lxc') {
          setLxcTab('containers')
          return
        }
        setView('podman')
        setPodmanTab('containers')
      }

      /** 节点分组上的「网络」按钮：跳进那一页的网络子 tab，并把这个节点筛上。 */
      function openNodeNetworks(node) {
        setSelected(null)
        setNodeFilter(node.id)
        if (node.kind === 'lxc') {
          setView('lxc')
          setLxcTab('networks')
          return
        }
        setView('podman')
        setPodmanTab('networks')
      }
      /* ── 顶栏 ── */
      const top = h('div', { key: 'top', 'data-cm-top': '' },
        h('div', { key: 'title' },
          h('div', { 'data-cm-title': '' }, '容器台'),
          h('div', { 'data-cm-sub': '' },
            loading
              ? '读取中…'
              /* 待确认 > 0 时单独挂琥珀色，这是整个页面唯一需要人动手的信号 */
              : [
                containers.length + ' 个容器 · ' + networks.length + ' 个网络',
                h('span', {
                  key: 'pending',
                  'data-cm-pendingbadge': '',
                  ...(pending.length > 0 ? { 'data-on': '' } : {}),
                }, pending.length > 0 ? pending.length + ' 条待确认' : ' · ' + pending.length + ' 条待确认'),
                h('button', {
                  key: 'jobs',
                  'data-cm-jobbadge': '',
                  ...(activeJobCount > 0 || jobsOpen ? { 'data-on': '' } : {}),
                  title: '长操作（克隆 / 快照 / 导出 / 提交）在队列里跑，关掉页面也继续',
                  onClick: () => setJobsOpen(open => !open),
                }, activeJobCount > 0
                  ? ' · ' + (jobSummary.running > 0
                    ? jobSummary.running + ' 个任务在跑'
                    : jobSummary.queued + ' 个任务排队')
                  : ' · 任务'),
              ])),
        h('div', { key: 'nav', 'data-cm-nav': '' },
          ...VIEWS.map(entry => h('button', {
            key: entry[0],
            ...(view === entry[0] ? { 'data-on': '' } : {}),
            onClick: () => setView(entry[0]),
          }, entry[1]))),
        h('div', { key: 'grow', 'data-cm-grow': '' }),
        h('div', { key: 'chips', 'data-cm-chips': '' },
          ...nodes.filter(node => node.kind === (view === 'lxc' ? 'lxc' : 'podman')).map(node => h('button', {
            key: node.id,
            'data-cm-chip': '',
            ...(nodeFilter === node.id ? { 'data-on': '' } : {}),
            title: node.available ? `${node.kind} / ${node.transport}` : (node.reason || '不可用'),
            onClick: () => setNodeFilter(nodeFilter === node.id ? null : node.id),
          }, (node.available ? '● ' : '○ ') + node.label))),
        h('button', {
          key: 'new',
          'data-cm-btn': '',
          'data-primary': '',
          onClick: startCreate,
        }, '+ 新建'),
        h('button', {
          key: 'refresh',
          'data-cm-btn': '',
          disabled: busy,
          onClick: () => run(load(true), '已刷新'),
        }, h('span', { 'data-cm-pulsedot': '' }), '刷新'),
      )

      /* ── 左侧列表 ── */
      const listChildren = []
      listChildren.push(h('div', { 'data-cm-search': '' },
        h('div', { 'data-cm-searchwrap': '' },
          h('span', { 'data-cm-sicon': '' }, h(Glyph, { name: 'search', size: 14 })),
          h('input', {
            placeholder: '筛选容器 / 镜像 / 状态',
            value: filter,
            onChange: event => setFilter(event.target.value),
          }))))
      // 页面已经按运行时分开了，列表就只遍历当前这一类的节点。
      const activeKind = view === 'lxc' ? 'lxc' : 'podman'
      const kindNodes = nodes.filter(node => node.kind === activeKind)
      const groups = []
      for (const node of kindNodes) {
        if (nodeFilter && node.id !== nodeFilter) continue
        const nodeContainers = shown.filter(container => container.nodeId === node.id)
        groups.push(h('div', { key: 'g-' + node.id, 'data-cm-group': '' },
          h('div', { 'data-cm-ghead': '' },
            h(Dot, { tone: node.available ? 'on' : 'off' }),
            h('span', null, node.label),
            h('span', { 'data-cm-dim': '' }, ` ${node.kind}`),
            h('div', { 'data-cm-grow': '' }),
            h('button', {
              'data-cm-btn': '',
              style: { padding: '1px 7px', fontSize: 'var(--cm-f-xs)' },
              onClick: () => openNodeNetworks(node),
            }, '网络')),
          node.available
            ? (nodeContainers.length === 0
              ? h('div', { 'data-cm-nodehint': '' }, '（这个节点上没有容器）')
              : nodeContainers.map(container => containerRow(container, node, liveByNode.get(node.id) || null)))
            : h('div', { 'data-cm-nodehint': '' },
              '不可用：' + (node.reason || '未知原因'),
              node.hintText ? h('div', { 'data-cm-mono': '', style: { marginTop: '3px' } }, node.hintText) : null),
        ))
      }
      if (groups.length === 0) {
        groups.push(h('div', { key: 'empty', 'data-cm-empty': '' }, loading ? '读取中…' : '没有节点。'))
      }
      if (picked.length > 0) {
        listChildren.push(h('div', { key: 'bulk', 'data-cm-bulk': '' },
          h('span', { 'data-cm-dim': '' }, '选了 ' + picked.length + ' 个'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => runBatch('start') }, '启动'),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => runBatch('stop') }, '停止'),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => runBatch('restart') }, '重启'),
          h('button', { 'data-cm-btn': '', onClick: () => setPicked([]) }, '清空')))
      }
      listChildren.push(h('div', { key: 'scroll', 'data-cm-scroll': '' }, ...groups))

      const list = h('div', { key: 'list', 'data-cm-list': '' }, listChildren)

      /* ── 右侧 ── */
      const selectedNode = selected ? nodes.find(item => item.id === selected.node) : null
      const isLxc = Boolean(selectedNode && selectedNode.kind === 'lxc')
      // 层级分开：新建容器、宿主网络都是「整台机器」的事，挂在单个容器底下会让人以为
      // 是在这个容器里新建什么。选中容器时只留属于它的那几页。
      // 快照与挂载点是 LXC 独有的，Podman 那边靠 compose 文件与卷。
      // 快照与挂载不再是独立 tab：它们跟网卡一样都是「这个容器的配置」，
      // 只是低频得多，收进配置页的分段控件里。容器级只剩四页。
      const containerTabs = ['overview', 'logs', 'files', 'diagnose', 'config', 'terminal']
      const nodeTabs = ['overview', 'create']
      const tabs = selectedContainer ? containerTabs : nodeTabs
      // tab 是跨层级共用的状态，切换选中对象后旧值可能已经不在这一层里了。
      const activeTab = tabs.includes(tab) ? tab : tabs[0]
      const tabLabels = {
        overview: '概览', create: '新建', networks: '网络', logs: '日志',
        config: '配置', snapshots: '快照', mounts: '挂载', terminal: '终端', files: '文件', diagnose: '诊断',
      }
      const detail = h('div', { key: 'detail', 'data-cm-detail': '' },
        h('div', { 'data-cm-tabs': '' },
          selectedContainer
            ? h('button', {
              key: 'back',
              'data-cm-tab': '',
              'data-cm-back': '',
              title: '回到节点视图',
              onClick: () => { setSelected(null); setTab('overview') },
            }, '← 全部容器')
            : null,
          ...tabs.map(name => h('button', {
            key: name,
            'data-cm-tab': '',
            ...(activeTab === name ? { 'data-on': '' } : {}),
            onClick: () => setTab(name),
          }, tabLabels[name]))),
        h('div', { 'data-cm-dbody': '' }, h(PaneBoundary, { key: activeTab, label: tabLabels[activeTab] || activeTab }, h(TabContent, { render: body }))),
      )

      function containerRow(container, node, live) {
        const ips = containerIps(container)
        const usage = live && live.byName ? live.byName.get(container.name) : null
        const active = selected && selected.node === node.id && selected.ref === container.name
        return h('div', {
          key: node.id + '/' + container.name,
          'data-cm-row': '',
          ...(active ? { 'data-active': '' } : {}),
          onClick: () => { setSelected({ node: node.id, ref: container.name }); setTab('overview') },
        },
          h('input', {
            'data-cm-check': '',
            type: 'checkbox',
            checked: picked.includes(node.id + '/' + container.name),
            onClick: event => event.stopPropagation(),
            onChange: () => {
              const key = node.id + '/' + container.name
              setPicked(list => list.includes(key) ? list.filter(item => item !== key) : [...list, key])
            },
          }),
          h(Dot, { tone: stateTone(container.state) }),
          h('div', { 'data-cm-rmain': '' },
            h('div', { 'data-cm-rname': '' }, container.name),
            h('div', { 'data-cm-rmeta': '' },
              [container.state, container.image, ips.join(', ')].filter(Boolean).join(' · '),
              // 有健康检查的容器：健康时不打扰，只在「失败 / 检查中」挂一个字。
              container.health && container.health !== 'healthy'
                ? h('span', {
                  'data-cm-health': '',
                  'data-tone': container.health,
                }, container.health === 'unhealthy' ? ' 健康检查失败' : ' 健康检查中')
                : null),
            usage
              ? h('div', { 'data-cm-rmeta': '', 'data-cm-live': '' },
                'CPU ' + usage.cpuPercent.toFixed(2) + '% · 内存 ' + sizeText(usage.memUsed))
              : null,
            h(RowBars, { usage })),
          container.state === 'running'
            ? h('button', {
              'data-cm-btn': '',
              style: { padding: '1px 7px', fontSize: 'var(--cm-f-xs)' },
              disabled: busy,
              onClick: event => { event.stopPropagation(); act(container, 'stop') },
            }, '停')
            : h('button', {
              'data-cm-btn': '',
              style: { padding: '1px 7px', fontSize: 'var(--cm-f-xs)' },
              disabled: busy,
              onClick: event => { event.stopPropagation(); act(container, 'start') },
            }, '启'),
        )
      }

      /* ── 右侧内容 ── */
      function body() {
        if (error) {
          return h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-warn': '' }, '读不到容器台数据：' + error),
            h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } }, '刷新一次；还不行就看 DSH 日志里的 [container-manager]。'))
        }
        if (activeTab === 'create') return createView()
        if (activeTab === 'logs') return logsView()
        if (activeTab === 'files') {
          if (!selectedContainer) return null
          return h(ContainerFilesPane, {
            key: selected.node + ':' + selectedContainer.name,
            nodeId: selected.node,
            name: selectedContainer.name,
            nodeKind: selectedNode ? selectedNode.kind : 'podman',
            running: selectedContainer.state === 'running',
            onToast: setToast,
          })
        }
        if (activeTab === 'diagnose') {
          if (!selectedContainer) return null
          return h(ContainerDiagnosePane, {
            key: selected.node + ':' + selectedContainer.name,
            nodeId: selected.node,
            name: selectedContainer.name,
            running: selectedContainer.state === 'running',
          })
        }
        if (activeTab === 'config') return configView()

        if (activeTab === 'terminal') return terminalView()
        return overviewView()
      }

      function createView() {
        // 页面已经按运行时分开了：在 LXC 页新建就只该出现 LXC 节点，
        // 否则 usable[0] 是 local-podman，表单会落到 Podman 上（看着像「点不动」）。
        const pageKind = view === 'lxc' ? 'lxc' : 'podman'
        const usable = nodes.filter(item => item.available && item.kind === pageKind)
        if (usable.length === 0) {
          return h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-warn': '' }, '没有可用的节点，建不了容器。'),
            h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
              '先看「概览」里节点不可用的原因；LXC 需要先装 helper（sudo bash helper/install-helper.sh）。'))
        }
        const preferred = selected ? usable.find(item => item.id === selected.node) : null
        return h(CreateContainerForm, {
          key: createDraft && createDraft.at ? 'draft-' + createDraft.at : 'blank',
          nodes: usable,
          networks,
          bridges: lxcBridges,
          defaultNodeId: (preferred || usable[0]).id,
          draft: createDraft,
          busy,
          onCreated: (data) => {
            const created = (data && data.created) ? data.created : data
            setCreateDraft(null)
            if (created && created.name) {
              setSelected({ node: created.nodeId, ref: created.name })
              setTab('overview')
              setToast('已创建 ' + created.name + (created.state ? '（' + created.state + '）' : '') + macSwapText(created.swaps))
            } else {
              setToast('已创建')
            }
            void load(true)
          },
        })
      }
      /** 宿主负载：负载 / 内存 / 磁盘，10 秒一份，来自 /stats。 */
      function hostCard() {
        // 宿主就一台：任一节点读到的 host 都是同一份 /proc，挑第一个有值的就行。
        const anyLive = [...liveByNode.values()].find(item => item && item.value) || null
        const host = anyLive && anyLive.value ? anyLive.value.host : null
        if (!host || !host.ok) {
          const problem = anyLive && anyLive.problem ? anyLive.problem : ''
          return h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '这台机'),
            h('div', { 'data-cm-dim': '' },
              problem ? '读不到实时占用：' + problem : '读取中…'))
        }
        const memory = host.memory || {}
        const disks = host.disks || []
        const load = host.load || {}
        const tower = disks[0] || null
        const two = value => Number(value || 0).toFixed(2)
        // 有历史就用历史（真曲线），没有就退回内存环（刚开面板时的这十几分钟）。
        const historyPoints = (hostHistory && Array.isArray(hostHistory.series) ? hostHistory.series : [])
          .map(point => Number(point.load))
          .filter(value => Number.isFinite(value))
        const sparkSeries = historyPoints.length >= 2 ? historyPoints : LOAD_HISTORY.slice()
        const sparkLabel = historyPoints.length >= 2
          ? (hostMinutes >= 1440 ? '24 小时' : hostMinutes >= 360 ? '6 小时' : '1 小时') + '内 ' + historyPoints.length + ' 点'
          : '这里还没攒够历史'
        /* 三格 Bento：负载（带折线）/ 内存 / 主盘。数字用同一档大号等宽字，扫一眼就能对齐比较。 */
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
            '这台机',
            h('div', { 'data-cm-grow': '' }),
            h('span', { 'data-cm-hint': '' }, sparkLabel)),
          h('div', { 'data-cm-bento': '' },
            h('div', { key: 'load', 'data-cm-tile': '' },
              h('div', { 'data-cm-tilehead': '' },
                h('span', { 'data-cm-tileicon': '' }, h(Glyph, { name: 'activity', size: 13 })),
                '负载',
                h('div', { 'data-cm-grow': '' }),
                h('div', { 'data-cm-range': '' },
                  ...[['60', '1h'], ['360', '6h'], ['1440', '24h']].map(entry => h('button', {
                    key: entry[0],
                    'data-cm-rangeitem': '',
                    ...(String(hostMinutes) === entry[0] ? { 'data-on': '' } : {}),
                    onClick: () => setHostMinutes(Number(entry[0])),
                  }, entry[1])))),
              h('div', { 'data-cm-big': '' }, two(load.one)),
              h('div', { 'data-cm-tilesub': '' }, '5 分 ' + two(load.five) + ' · 15 分 ' + two(load.fifteen)),
              h(HostSpark, { series: sparkSeries })),
            h('div', { key: 'mem', 'data-cm-tile': '' },
              h('div', { 'data-cm-tilehead': '' },
                h('span', { 'data-cm-tileicon': '' }, h(Glyph, { name: 'cpu', size: 13 })),
                '内存'),
              h('div', { 'data-cm-big': '' }, String(memory.percent || 0),
                h('span', { 'data-cm-bigunit': '' }, '%')),
              h('div', { 'data-cm-tilesub': '' }, sizeText(memory.used) + ' / ' + sizeText(memory.total)),
              h(Meter, { percent: memory.percent, tall: true })),
            h('div', { key: 'disk', 'data-cm-tile': '' },
              h('div', { 'data-cm-tilehead': '' },
                h('span', { 'data-cm-tileicon': '' }, h(Glyph, { name: 'disk', size: 13 })),
                '磁盘' + (tower ? ' ' + tower.mount : '')),
              tower
                ? h('div', { 'data-cm-big': '' }, String(tower.percent || 0),
                  h('span', { 'data-cm-bigunit': '' }, '%'))
                : h('div', { 'data-cm-big': '' }, '—'),
              h('div', { 'data-cm-tilesub': '' },
                tower ? sizeText(tower.used) + ' / ' + sizeText(tower.total) : '读不到磁盘'),
              tower ? h(Meter, { percent: tower.percent, tall: true }) : null)))
      }

      /**
       * 节点技术栈拆成独立徽章。以前是一串 · 拼起来的灰字，扫不出「哪一版 / 是不是 rootless」；
       * 拆成等宽小胶囊之后，两台节点的差异一眼就能对齐比。
       */
      function techBadges(node) {
        const detail = node.detail || {}
        if (node.kind === 'podman') {
          return [
            'podman ' + (detail.version ?? '?'),
            detail.rootless ? 'rootless' : 'rootful',
            detail.networkBackend ? 'net ' + detail.networkBackend : '',
            detail.kernel ? 'kernel ' + detail.kernel : '',
            detail.cgroupVersion ? 'cgroup v' + detail.cgroupVersion : '',
          ].filter(Boolean)
        }
        return [
          'lxc ' + (detail.version ?? '?'),
          detail.macvlan ? 'macvlan 已加载' : 'macvlan 未加载',
          detail.lxcbr0 ? 'lxcbr0 在' : 'lxcbr0 没起',
        ].filter(Boolean)
      }

      function overviewView() {
        if (selectedContainer) return containerOverview(selectedContainer)
        return h('div', null,
          hostCard(),
          h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-matrix': '' },
              h(InfoCell, { icon: 'refresh', title: '面板',
                hint: '左侧「容器」——数据每 4 秒刷新一次。' }),
              h(InfoCell, { icon: 'shield', title: '危险操作',
                hint: '删除容器、改网络会先挂起，在本页底部「待确认」里点确认才执行。' }),
              h(InfoCell, { icon: 'wrench', title: 'AI',
                hint: 'AI 有 20 个工具，能读、能建、能改名、能提交镜像，但确认按钮只在人手里。' }))),
          h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '节点'),
            h('div', { 'data-cm-nodes': '' },
              nodes.map(node => h('div', { key: node.id, 'data-cm-nodecard': '' },
                h('div', { 'data-cm-nodehead': '' },
                  h(Dot, { tone: node.available ? 'on' : 'off' }),
                  h('strong', null, node.label),
                  h('span', { 'data-cm-dim': '' }, node.kind + ' / ' + node.transport)),
                node.available
                  ? h('div', { 'data-cm-tech': '' },
                    techBadges(node).map((badge, index) => h('span', { key: index, 'data-cm-tip': '' }, badge)))
                  : h('div', { 'data-cm-nodehint': '' }, node.reason || '不可用',
                    node.hintText ? h('div', { 'data-cm-mono': '' }, node.hintText) : null))))),
        )
      }

      /**
       * 容器概览。
       *
       * 这一屏要一秒内答出三件事：在不在跑、占多少内存、跑了多久。
       * 所以顺序是「状态头 → 两个数字块 → 身份折叠 → 网络端口 → 操作」，
       * 而不是把七个语义完全不同的按钮和身份信息挤在一张卡里。
       */
      function containerOverview(container) {
        const node = nodes.find(item => item.id === container.nodeId)
        const liveOne = liveByNode.get(container.nodeId) || null
        const usage = liveOne && liveOne.byName ? liveOne.byName.get(container.name) : null
        const tone = containerTone(container)
        const exitHint = exitCodeHint(container.exitCode)
        const exitShort = exitCodeShort(container.exitCode)
        const trend = trendOf(CPU_HISTORY.get(container.nodeId + '/' + container.name))
        const isPodman = container.runtime === 'podman'

        // 运行时长：拿不到 startedAt 就空着，不编。
        let uptime = ''
        if (container.state === 'running' && container.startedAt) {
          const began = new Date(container.startedAt).getTime()
          if (Number.isFinite(began) && began > 0) {
            const seconds = Math.max(0, Math.floor((Date.now() - began) / 1000))
            uptime = formatUptime(seconds)
          }
        }

        const heroLine = [
          usage ? usage.cpuPercent.toFixed(1) + '% CPU' : '',
          usage ? sizeText(usage.memUsed) + ' / ' + sizeText(usage.memLimit) : '',
          uptime ? '已运行 ' + uptime : '',
        ].filter(Boolean).join('  ·  ')

        // ── 1. 状态头 ──
        const hero = h('div', { 'data-cm-card': '', 'data-cm-hero': '' },
          h('div', { 'data-cm-heroline': '' },
            h(Dot, { tone }),
            h('span', { 'data-cm-statelabel': '', 'data-tone': tone }, stateLabel(container.state)),
            // 退出码非 0 就直接摆在状态旁边：137 是 OOM，139 是段错误，
            // 这个数字比「异常退出」四个字有用得多。
            tone === 'bad' && container.exitCode !== null && container.exitCode !== undefined && Number(container.exitCode) !== 0
              ? h('span', { 'data-cm-exitbad': '', title: exitHint || '退出码 ' + container.exitCode },
                'code ' + container.exitCode,
                exitShort ? h('i', { 'data-cm-exitshort': '' }, exitShort) : null)
              : null,
            h('strong', { 'data-cm-heroname': '' }, container.name),
            h('div', { 'data-cm-grow': '' }),
            node ? h('span', { 'data-cm-dim': '' }, node.label) : null),
          heroLine ? h('div', { 'data-cm-herosub': '' }, heroLine) : null)

        // ── 2. CPU / 内存 / 进程 三块并排 ──
        // 内存块是这一屏的主角：数字看不清「离爆还有多远」，水位线能。
        // 上限为 0（不限）时不画水位线，也不编百分比 —— 那根条没有分母。
        const memLimited = usage && Number(usage.memLimit) > 0
        const numbers = usage
          ? h('div', { 'data-cm-numbers': '' },
            h(DataTile, {
              icon: 'activity',
              label: 'CPU',
              value: usage.cpuPercent.toFixed(1),
              unit: '%',
              trail: trend
                ? h('span', { 'data-cm-trend': '', 'data-dir': trend.dir, title: trend.title }, trend.text)
                : null,
              sub: usage.cpuTime ? '累计 ' + usage.cpuTime : '—',
            }),
            h(DataTile, {
              icon: 'cpu',
              label: '内存',
              value: sizeText(usage.memUsed),
              sub: memLimited
                ? '上限 ' + sizeText(usage.memLimit) + ' · ' + usage.memPercent.toFixed(1) + '%'
                : '未设上限',
              extra: memLimited ? h(Meter, { percent: usage.memPercent, tall: true }) : null,
            }),
            h(DataTile, {
              icon: 'boxes',
              label: '进程',
              value: String(usage.pids || 0),
              sub: usage.netIo ? 'IO ' + usage.netIo : '—',
            }))
          : null

        // ── 2.5 健康检查：有健康检查才画这张卡 ──
        // 连续失败次数比一个红色徽章有用：3 次失败和 300 次失败不是一个事故。
        const health = container.health || null
        const healthCard = !health
          ? null
          : h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
              '健康检查',
              h('span', { 'data-cm-health': '', 'data-tone': health.status || 'unknown' },
                health.status === 'healthy' ? '正常'
                  : health.status === 'unhealthy' ? '失败'
                    : health.status === 'starting' ? '检查中' : '未知'),
              health.failingStreak > 0
                ? h('span', {
                  'data-cm-dim': '',
                  style: { marginLeft: 'var(--cm-s2)', fontWeight: '400' },
                }, '连续失败 ' + health.failingStreak + ' 次')
                : null),
            (health.log || []).length === 0
              ? h('div', { 'data-cm-dim': '' }, '还没有检查记录（容器刚起来时正常）。')
              : h('div', { 'data-cm-healthlog': '' },
                ...(health.log || []).slice(-6).reverse().map((entry, index) => h('div', {
                  key: index,
                  'data-cm-healthrow': '',
                  'data-tone': Number(entry.exitCode) === 0 ? 'ok' : 'bad',
                },
                h('span', { 'data-cm-mono': '' }, entry.exitCode == null ? '—' : 'exit ' + entry.exitCode),
                h('span', {
                  'data-cm-healthout': '',
                  title: entry.output || '',
                }, entry.output || '（没有输出）')))))

        // ── 3. 身份：属于「要查」不是「要看」，折起来 ──
        const nodeLabel = node ? node.label : container.nodeId
        const identity = h('details', { 'data-cm-details': '' },
          h('summary', null, '身份信息'),
          kv([
            ['节点', nodeLabel + '（' + container.runtime + '）'],
            ['ID', container.id],
            ['镜像', container.image],
            ['状态', container.status],
            ['创建', container.createdText || container.created || '—'],
            ['PID', container.pid == null ? '—' : String(container.pid)],
            ['启动于', container.startedAt || '—'],
            ['退出码', container.exitCode == null ? '—' : String(container.exitCode)],
          ]))

        // ── 4. 网络 + 端口 ──
        // 端口改成结构化胶囊：`0.0.0.0:8080->80/tcp` 这种整行字符串扫不动，
        // 拆成「宿主端口 → 容器端口 / 协议」三段之后，一眼就知道服务从哪进来。
        // 常见 web 端口才做成链接：点了能进去的才值得点。
        // 22 / 3306 / 5432 这些放进浏览器只会报错，所以保持纯文本。
        const WEB_PORTS = new Set([80, 443, 3000, 3001, 4000, 5000, 5001, 5601, 7860,
          8000, 8008, 8080, 8081, 8088, 8443, 8888, 9000, 9090, 9091, 9443])
        // 目标地址：LXC 是桥接容器、有自己的 IP，直接用；
        // Podman rootless 的端口发布在宿主上，容器内 IP 浏览器根本够不到，只能用当前 host。
        const ownIp = (Array.isArray(container.networks) ? container.networks : [])
          .map(net => net && net.ip).filter(Boolean)[0] || ''
        const hereHost = typeof window !== 'undefined' && window.location ? window.location.hostname : ''
        const webHost = container.runtime === 'lxc' ? (ownIp || hereHost) : (hereHost || ownIp)
        const portChips = (container.ports || []).map((port, index) => {
          const hostIp = port.hostIp && port.hostIp !== '0.0.0.0' ? port.hostIp : ''
          const hostText = port.hostPort == null ? '随机' : String(port.hostPort)
          const portNo = Number(port.hostPort)
          const linkable = Boolean(webHost) && Number.isFinite(portNo) && WEB_PORTS.has(portNo)
          const scheme = portNo === 443 || portNo === 8443 || portNo === 9443 ? 'https' : 'http'
          const href = linkable ? scheme + '://' + webHost + ':' + portNo : ''
          return h('div', { key: 'p' + index, 'data-cm-portrow': '' },
            hostIp ? h('span', { 'data-cm-portpill': '', 'data-muted': '' }, hostIp) : null,
            linkable
              ? h('a', {
                'data-cm-portpill': '', 'data-cm-portlink': '', href, target: '_blank', rel: 'noreferrer',
                title: '在新标签打开 ' + href,
              }, hostText, h('span', { 'data-cm-portext': '' }, '↗'))
              : h('span', { 'data-cm-portpill': '' }, hostText),
            h('span', { 'data-cm-portarrow': '' }, '→'),
            h('span', { 'data-cm-portpill': '', 'data-muted': '' }, String(port.containerPort)),
            h('span', { 'data-cm-portpill': '', 'data-muted': '' }, String(port.protocol || 'tcp')))
        })

        const portsTable = (container.ports || []).length === 0
          ? null
          : h('div', { style: { marginTop: 'var(--cm-s3)' } },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '端口'),
            h('div', { 'data-cm-ports': '' }, ...portChips))

        const netCard = h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '网络'),
          container.networks && container.networks.length > 0
            ? h('div', { 'data-cm-kv': '' }, ...container.networks.flatMap((network, index) => [
              h('b', { key: 'n' + index }, network.name),
              h('span', { key: 'v' + index, 'data-cm-mono': '' }, [network.ip, network.mac, network.gateway].filter(Boolean).join('  ') || '—'),
            ]))
            : h('div', { 'data-cm-dim': '' }, '没有网络信息。'),
          container.nics && container.nics.length > 0
            ? h('div', { style: { marginTop: 'var(--cm-s3)' } },
              h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'LXC 网卡'),
              h('div', { 'data-cm-mono': '' }, container.nics.map(nic => {
                const parts = [
                  nic.type + ' link=' + (nic.link || '—'),
                  'mac=' + (nic.hwaddr || '（未固定，每次启动可能变）'),
                  'ipv4=' + ((nic.ipv4 && nic.ipv4.address) || 'dhcp'),
                ]
                if (nic.ipv6 && nic.ipv6.address) parts.push('ipv6=' + nic.ipv6.address)
                return parts.join(' ')
              }).join('\n')))
            : null,
          portsTable)

        // ── 5. 操作分三层 ──
        const dailyActions = h('div', null,
          container.state === 'running'
            ? h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act(container, 'restart') }, '重启')
            : null,
          container.state === 'paused'
            ? h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act(container, 'unpause') }, '恢复')
            : (container.state === 'running'
              ? h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act(container, 'pause') }, '暂停')
              : null))

        const minorActions = h('div', null,
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setRenameDraft({ name: container.name, value: container.name }) }, '改名'),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setCommitDraft({ name: container.name, value: stampName(container.name) }) }, '存成镜像'))

        const dangerActions = h('div', null,
          h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => setConfirmDelete(container.name) }, '删除'))

        const actionsCard = h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '操作'),
          h('div', { 'data-cm-actions': '' },
            h('span', { 'data-cm-dim': '', style: { minWidth: '2.6em' } }, '日常'),
            dailyActions),
          h('div', { 'data-cm-actions': '' },
            h('span', { 'data-cm-dim': '', style: { minWidth: '2.6em' } }, '次要'),
            minorActions),
          h('div', { 'data-cm-dangerzone': '' },
            h('span', { 'data-cm-dim': '', style: { minWidth: '2.6em' } }, '危险'),
            dangerActions,
            h('span', { 'data-cm-dim': '' }, '删除不可撤销，数据卷不会自动清')),
          confirmDelete === container.name
            ? h('div', { 'data-cm-warn': '', style: { display: 'flex', gap: 'var(--cm-s2)', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', null, '删除 ' + container.name + ' 不可撤销，数据卷不会自动清。'),
              h('button', {
                'data-cm-btn': '',
                'data-danger': '',
                disabled: busy,
                onClick: () => { setConfirmDelete(null); act(container, 'delete') },
              }, '确认挂起删除'),
              h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setConfirmDelete(null) }, '算了'))
            : null,
          renameDraft && renameDraft.name === container.name
            ? h('div', { 'data-cm-formrow': '' },
              h('input', {
                'data-cm-input': '',
                value: renameDraft.value,
                placeholder: '新名字',
                onChange: event => setRenameDraft({ name: container.name, value: event.target.value }),
                onKeyDown: event => { if (event.key === 'Enter') doRename(container, renameDraft.value) },
              }),
              h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: () => doRename(container, renameDraft.value) }, '改名'),
              h('button', { 'data-cm-btn': '', onClick: () => setRenameDraft(null) }, '算了'))
            : null,
          commitDraft && commitDraft.name === container.name
            ? h('div', { 'data-cm-formrow': '' },
              h('input', {
                'data-cm-input': '',
                value: commitDraft.value,
                placeholder: '镜像名，比如 local/名字:日期',
                onChange: event => setCommitDraft({ name: container.name, value: event.target.value }),
                onKeyDown: event => { if (event.key === 'Enter') doCommit(container, commitDraft.value) },
              }),
              h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: () => doCommit(container, commitDraft.value) }, '提交（会先挂起）'),
              h('button', { 'data-cm-btn': '', onClick: () => setCommitDraft(null) }, '算了'))
            : null)

        return h('div', null,
          hero,
          numbers,
          healthCard,
          identity,
          netCard,
          actionsCard,
          isPodman ? h(LimitsCard, { container, node, busy }) : null,
          node && node.kind === 'lxc' ? h(LxcCloneCard, { container: { nodeId: node.id, name: container.name }, onToast: setToast }) : null,
          h(ContainerMore, { container, node }),
        )
      }
      /* ── 容器网络：Podman 页 / LXC 页各自一份，宿主那套搬到「宿主网络」页 ── */

      /**
       * 一个运行时自己的网络列表。Podman 看 netavark 网络，LXC 看网桥。
       * kind 由调用方给（页面已经分开了），这里只管那个 kind 的节点。
       */
      function containerNetworksView(kind) {
        const pool = nodes.filter(item => item.kind === kind)
        const inPool = id => Boolean(id) && pool.some(item => item.id === id)
        const nodeId = inPool(selected && selected.node) ? selected.node
          : inPool(nodeFilter) ? nodeFilter
            : (pool[0] ? pool[0].id : null)
        const node = nodes.find(item => item.id === nodeId) ?? null
        const list = networks.filter(network => !nodeId || network.nodeId === nodeId)
        const isLxc = kind === 'lxc'
        return h('div', null,
          h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
              node ? `${node.label} 的网络` : '网络'),
            list.length === 0
              ? h('div', { 'data-cm-dim': '' }, isLxc ? '还没有 lxcbr0（在下面点一次「启用 lxcbr0」）。' : '还没有网络。')
              : list.map(network => h('div', { key: network.nodeId + '/' + network.name, style: { padding: '8px 0', borderTop: '1px solid var(--cm-line)' } },
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h('strong', null, network.name),
                  h('span', { 'data-cm-dim': '' }, network.driver),
                  h('div', { 'data-cm-grow': '' }),
                  network.driver !== 'bridge' || node?.kind === 'podman'
                    ? h('button', {
                      'data-cm-btn': '',
                      'data-danger': '',
                      disabled: busy,
                      onClick: () => run(jpost('/networks', { node: network.nodeId, op: 'remove', name: network.name }), '删除已挂起'),
                    }, '删除')
                    : null),
                h('div', { 'data-cm-dim': '', 'data-cm-mono': '' },
                  [network.subnet, network.gateway ? 'gw ' + network.gateway : '', `${(network.containers ?? []).length} 个容器`].filter(Boolean).join('  ')),
                (network.containers ?? []).length > 0
                  ? h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { marginTop: '2px', fontSize: 'var(--cm-f-xs)' } },
                    (network.containers ?? []).map(item => item.name + (item.ips && item.ips.length ? ' ' + item.ips[0] : '')).join(' · '))
                  : null,
              ))),
          !isLxc && node
            ? h(NetworkCreateForm, { node, busy, onDone: () => run(load(true), '网络操作已挂起') })
            : null,
          isLxc && node
            ? (() => {
              // 这一页只说 NAT 那一套。其他网桥（br0 之类）是用户在宿主网络页自己搭的，
              // 不在这里出现 —— 要挂过去，去「新建」的网桥下拉里选。
              const nat = lxcBridges.find(item => item.name === 'lxcbr0') || null
              return h('div', { 'data-cm-card': '' },
                h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'LXC 的默认网络'),
                h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
                  'LXC 默认走 NAT（lxcbr0，10.0.3.0/24）：容器拿内网地址，出网由宿主转发，跟宿主网段隔离。'),
                h('div', { 'data-cm-kv': '' },
                  h('b', null, 'lxcbr0'),
                  h('span', { 'data-cm-mono': '' }, nat
                    ? (nat.address || '10.0.3.1/24') + (nat.state === 'up' ? ' · 已启用' : ' · 未启用')
                    : '还没启用')),
                h('div', { 'data-cm-dim': '', style: { marginTop: '12px', lineHeight: '1.7' } },
                  h('b', null, '要桥接得自己建桥。'),
                  ' 上面这套 NAT 归插件管，能替你建、替你修。想跟宿主同网段，得你先在「宿主网络 → 网卡 → ＋ 新建连接」',
                  '里建一块 ', h('code', null, 'bridge'), ' 类型的连接 —— 插件不会替你在宿主上建桥，',
                  '也不会把物理网卡插进去（那会断你自己的网）。桥建好之后，新建容器时的网桥下拉里就能选到它。'),
                h('div', { 'data-cm-actions': '', style: { marginTop: '10px' } },
                  h('button', {
                    'data-cm-btn': '',
                    disabled: busy,
                    onClick: () => run(jpost('/networks', { node: node.id, op: 'create', name: 'lxcbr0', subnet: '10.0.3.0/24', gateway: '10.0.3.1' }), '已写入 lxc-net 配置并重启（若失败看提示）'),
                  }, nat ? '重建 lxcbr0' : '启用 lxcbr0')))
            })()
            : null,
        )
      }

      function logsView() {
        if (!selectedContainer) return h('div', { 'data-cm-empty': '' }, '先在左边选一个容器。')
        return h(LogsPane, { container: selectedContainer })
      }

      function terminalView() {
        if (!selectedContainer) return h('div', { 'data-cm-empty': '' }, '先在左边选一个容器。')
        if (selectedContainer.state !== 'running') {
          return h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-warn': '' }, '容器没在跑，进不去终端。'),
            h('div', { 'data-cm-hintbox': '' }, '先在「概览」里启动它，再回来开终端。'))
        }
        return h(TerminalPane, {
          key: selectedContainer.nodeId + '/' + selectedContainer.name,
          nodeId: selectedContainer.nodeId,
          name: selectedContainer.name,
        })
      }

      function configView() {
        if (selectedContainer) {
          // Podman 和 LXC 的配置模型完全不同，各用各的页面 —— 之前两边都塞进 ConfigPane，
          // 结果 Podman 容器看到的全是 lxc.net.* 字段，等于没有配置页。
          if (selectedContainer.runtime === 'podman') {
            return h(PodmanConfigPane, { container: selectedContainer })
          }
          return h(LxcConfigShell, { container: selectedContainer, bridges: lxcBridges, onToast: setToast })
        }
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '容器台配置'),
          h('pre', { 'data-cm-pre': '' }, JSON.stringify(snap ? snap.config : {}, null, 2)),
          h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
            '配置文件在 ~/.dsh-next/container-manager/config.json。确认策略、TTL、日志开关都在那里。'))
      }

      /* ── 待确认抽屉 ── */
      const pendingDrawer = pending.length === 0 ? null : h('div', { 'data-cm-pending': '' },
        h('div', { 'data-cm-phead': '' }, `待确认（${pending.length}）`, h('span', { 'data-cm-dim': '', style: { fontWeight: '400' } }, '危险操作在执行前卡在这里')),
        ...pending.map(item => h('div', { key: item.token, 'data-cm-prow': '' },
          h('div', { 'data-cm-psummary': '' },
            h('div', null, item.summary),
            h('div', { 'data-cm-pexpiry': '' }, `${item.kind} · ${item.node}${item.target ? ' · ' + item.target : ''} · ${expiryText(item.expiresAt)}`),
            planBlock(item.plan)),
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: () => confirmPending(item.token) }, '确认'),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => cancelPending(item.token) }, '取消'))))

      /* ── 任务抽屉 ── */
      const jobRow = job => h('div', { key: job.id, 'data-cm-jrow': '' },
        h('div', { 'data-cm-jmain': '' },
          h('div', { 'data-cm-jlabel': '', title: job.label }, job.label),
          h('div', { 'data-cm-jmeta': '' }, [
            job.kind,
            job.node,
            job.startedAt ? '开始 ' + jobClock(job.startedAt) : '排队中',
            job.status === 'failed' && job.error ? job.error : '',
            job.status === 'running' && job.progress && job.progress.note ? job.progress.note : '',
            job.status !== 'failed' && job.tail && job.tail.length > 0 && job.status !== 'running'
              ? job.tail[job.tail.length - 1] : '',
          ].filter(Boolean).join(' · '))),
        h('span', { 'data-cm-jstate': '', 'data-tone': job.status }, JOB_STATE_TEXT[job.status] || job.status),
        job.status === 'running' || job.status === 'queued'
          ? h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => cancelJob(job.id) }, '取消')
          : null,
        h('button', {
          'data-cm-btn': '',
          onClick: () => setJobTailId(jobTailId === job.id ? '' : job.id),
        }, jobTailId === job.id ? '收起输出' : '输出'))

      const jobDrawer = !jobsOpen ? null : h('div', { 'data-cm-jobs': '' },
        h('div', { 'data-cm-jhead': '' },
          '任务（' + jobsList.length + '）',
          h('span', { 'data-cm-dim': '', style: { fontWeight: '400' } },
            activeJobCount > 0
              ? '长操作在地板上排队，刷新页面不会打断它'
              : '现在没有在跑的任务'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', onClick: () => setJobsOpen(false) }, '收起')),
        jobsList.length === 0
          ? h('div', { 'data-cm-empty': '' }, '还没有任务。克隆、快照、导出、提交镜像这类会跑几分钟的操作都会落到这里。')
          : null,
        ...jobsList.slice(0, 12).map(jobRow),
        jobTailId && jobsList.some(job => job.id === jobTailId)
          ? h('pre', { key: 'tail', 'data-cm-pre': '', 'data-cm-jtail': '' },
            (jobsList.find(job => job.id === jobTailId).tail || []).join('\n') || '（还没有输出）')
          : null)

      const toastView = toast
        ? h('div', { 'data-cm-toast': '', ...(toast && toast.bad ? { 'data-bad': '' } : {}) }, toast && toast.text ? toast.text : String(toast))
        : null

      const podmanNode = nodes.find(item => item.kind === 'podman') || null
      const podmanNodeId = podmanNode ? podmanNode.id : liveNodeId
      // LXC 页的镜像与存储都挂在 LXC 节点上，单独取一个。
      const lxcNode = nodes.find(item => item.kind === 'lxc') || null
      const lxcNodeId = lxcNode ? lxcNode.id : null

      const projectsView = h(ProjectsPane, {
        key: 'projects',
        onPending: () => { load(false) },
        onOpenContainer: (nodeId, ref) => {
          setView('podman')
          setPodmanTab('containers')
          setSelected({ node: nodeId, ref })
          setTab('overview')
        },
      })


      // 每页自己的一排子 tab：Podman 五格、LXC 四格、宿主网络五格、活动没有。
      const pageTabs = view === 'capability' ? [] : view === 'lxc' ? LXC_TABS : view === 'host' ? HOST_TABS : PODMAN_TABS
      const pageTab = view === 'capability' ? 'report' : view === 'lxc' ? lxcTab : view === 'host' ? hostTab : podmanTab
      const setPageTab = view === 'lxc' ? setLxcTab : view === 'host' ? setHostTab : setPodmanTab

      function subTabBar() {
        if (view === 'activity' || view === 'capability') return null
        return h('div', { 'data-cm-tabs': '', 'data-cm-subtabs': '' },
          ...pageTabs.map(entry => h('button', {
            key: entry[0],
            'data-cm-tab': '',
            ...(pageTab === entry[0] ? { 'data-on': '' } : {}),
            onClick: () => setPageTab(entry[0]),
          }, entry[1])))
      }

      // 容器那两格是「左列表 + 右详情」，其余都是单页。
      const listPage = (view === 'podman' || view === 'lxc') && pageTab === 'containers'

      let bodyPane = null
      if (view === 'podman') {
        if (pageTab === 'projects') bodyPane = projectsView
        else if (pageTab === 'images') bodyPane = h(ImagesPane, { nodeId: podmanNodeId, onToast: setToast, onPending: () => { load(false) } })
        else if (pageTab === 'volumes') bodyPane = h(VolumesPane, { nodeId: podmanNodeId, onToast: setToast, onPending: () => { load(false) } })
        else if (pageTab === 'networks') bodyPane = containerNetworksView('podman')
        else if (pageTab === 'secrets') bodyPane = h(SecretsPane, { nodeId: podmanNodeId, onToast: setToast })
        else if (pageTab === 'quadlet') bodyPane = h(QuadletPane, { nodeId: podmanNodeId, onToast: setToast })
      } else if (view === 'lxc') {
        if (pageTab === 'images') bodyPane = h(LxcImagesPane, { nodeId: lxcNodeId, onToast: setToast, onPending: () => { load(false) } })
        else if (pageTab === 'networks') bodyPane = containerNetworksView('lxc')
        else if (pageTab === 'storage') bodyPane = h(LxcStoragePane, { nodeId: lxcNodeId })
        else if (pageTab === 'backup') {
          bodyPane = h(LxcBackupPane, {
            nodeId: lxcNodeId,
            containers: containers.filter(container => container.nodeId === lxcNodeId),
            onToast: setToast,
            onPending: () => { load(false) },
          })
        }
      } else if (view === 'capability') {
        bodyPane = h(CapabilityPane, { nodes, onToast: setToast })
      } else if (view === 'host') {
        bodyPane = pageTab === 'interfaces' ? h(HostInterfacesView, { hostNet, busy, run, editing: netEditing, onEdit: setNetEditing })
          : pageTab === 'routes' ? h(HostRoutesView, { hostNet })
          : pageTab === 'dns' ? h(HostDnsView, { hostNet, busy, run })
          : pageTab === 'firewall' ? h(FirewallPane, {})
          : h(DiagnosePane, {})
      } else {
        bodyPane = h(ActivityPane, {})
      }

      // 每页都是「子 tab 条 + 正文」竖着叠，只有正文里怎么排不一样：
      // 容器那格是左列表右详情，其余是单页。
      let content = null
      if (listPage) {
        content = h('div', { key: 'list-' + view, 'data-cm-stack': '' },
          h('div', { 'data-cm-subbar': '' }, subTabBar()),
          h('div', { 'data-cm-body': '' }, list, detail))
      } else {
        content = h('div', { key: view + '-' + pageTab, 'data-cm-stack': '' },
          h('div', { 'data-cm-subbar': '' }, subTabBar()),
          h('div', { 'data-cm-detail': '' },
            h('div', { 'data-cm-dbody': '' }, h(PaneBoundary, { key: pageTab, label: pageTab }, bodyPane))))
      }

      return h(PaneBoundary, { label: '容器台' },
        h('div', { 'data-cm-page': '' },
          top,
          content,
          toastView,
          jobDrawer,
          pendingDrawer,
        ))
    }

    /** 待确认的预演清单：读不到就是一条 warn，绝不假装「一切正常」。 */
    function planBlock(plan) {
      if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return null
      return h('div', { 'data-cm-plan': '' },
        ...plan.items.map((entry, index) => h('div', {
          key: index,
          'data-cm-planitem': '',
          'data-tone': entry.tone || 'info',
        }, entry.text)),
        Array.isArray(plan.blockers) && plan.blockers.length > 0
          ? h('div', { 'data-cm-planblock': '' }, '会挡住：' + plan.blockers.join('；'))
          : null)
    }

    const JOB_STATE_TEXT = {
      queued: '排队',
      running: '跑着',
      done: '完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '被中断',
    }

    /** 任务行上的时间：只到秒，别跟审计那套「月-日 时:分:秒」混用。 */
    function jobClock(iso) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return String(iso ?? '')
      const date = new Date(at)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    function expiryText(iso) {
      const left = Date.parse(iso) - Date.now()
      if (!Number.isFinite(left)) return ''
      if (left <= 0) return '已过期'
      const seconds = Math.round(left / 1000)
      if (seconds < 60) return `${seconds} 秒后过期`
      return `${Math.round(seconds / 60)} 分钟后过期`
    }

    /* ───────────────────────── 子面板 ───────────────────────── */

    function formatBytesShort(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ''
      for (const [suffix, size] of [['g', 1024 ** 3], ['m', 1024 ** 2], ['k', 1024]]) {
        if (value >= size && value % size === 0) return (value / size) + suffix
      }
      return String(value)
    }

    // cpuset.cpus 的写法（"0-3" / "0,2,4" / "0"）换算成核数，只用于把现值填回输入框。
    function cpusetCount(text) {
      const raw = String(text ?? '').trim()
      if (!raw) return ''
      let total = 0
      for (const part of raw.split(',')) {
        const piece = part.trim()
        if (!piece) continue
        if (piece.includes('-')) {
          const bounds = piece.split('-').map(item => Number(item))
          if (Number.isFinite(bounds[0]) && Number.isFinite(bounds[1]) && bounds[1] >= bounds[0]) total += bounds[1] - bounds[0] + 1
        } else if (Number.isFinite(Number(piece))) {
          total += 1
        }
      }
      return total > 0 ? String(total) : ''
    }

    // 实时占用的可读化：四舍五入，不像 formatBytesShort 那样只认整倍数。
    // 空值不能返回 '0' —— 调用方拿它判断「不限 / 没设」，转成 0 会骗人。
    function humanBytes(bytes) {
      if (bytes === '' || bytes === null || bytes === undefined) return ''
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + 'g'
      if (value >= 1024 ** 2) return Math.round(value / 1024 ** 2) + 'm'
      if (value >= 1024) return Math.round(value / 1024) + 'k'
      return String(value)
    }

    // cpu.max 是「配额 周期」，面板按核数展示：50000 100000 = 0.5 核。
    function cpuQuotaFromMax(text) {
      const parts = String(text ?? '').trim().split(/\s+/)
      if (parts.length < 2) return ''
      const quota = Number(parts[0])
      const period = Number(parts[1])
      if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return ''
      return String(Math.round((quota / period) * 100) / 100)
    }

    // io.weight 读出来是「default 100」或「8:0 200」，面板只认 default 那一档。
    function ioWeightValue(text) {
      const match = /default\s+(\d+)/.exec(String(text ?? ''))
      return match ? match[1] : ''
    }

    // 把「现有容器」翻成创建表单的初值。环境变量只有键名（面板不读值），所以值留空让用户填。
    function draftFrom(container, detail) {
      const d = detail || {}
      const portsText = (d.ports || [])
        .filter(item => item && item.hostPort)
        .map(item => (item.hostIp ? item.hostIp + ':' : '') + item.hostPort + ':' + item.containerPort + (item.protocol && item.protocol !== 'tcp' ? '/' + item.protocol : ''))
        .join('\n')
      const volumesText = (d.mounts || [])
        .filter(item => item && item.source && item.destination)
        .map(item => item.source + ':' + item.destination + (item.rw === false ? ':ro' : ''))
        .join('\n')
      const envText = Array.isArray(d.envKeys) ? d.envKeys.map(key => key + '=').join('\n') : ''
      const draft = {
        at: Date.now(),
        nodeId: container.nodeId,
        name: '',
        image: d.image || container.image || '',
        network: d.networks && d.networks.length === 1 ? d.networks[0].name : '',
        portsText,
        envText,
        volumesText,
        commandText: Array.isArray(d.command) ? d.command.join(' ') : '',
        restart: d.restartPolicy && d.restartPolicy.Name && d.restartPolicy.Name !== 'no' ? d.restartPolicy.Name : 'no',
        memory: d.limits && d.limits.memory ? formatBytesShort(d.limits.memory) : '',
        cpus: d.limits && d.limits.cpus ? String(d.limits.cpus) : '',
      }
      if (container.runtime === 'lxc' || (d.nics && d.nics.length > 0)) {
        const nic = (d.nics || [])[0]
        draft.distro = container.template ? String(container.template).split('/')[0] : undefined
        draft.release = container.template ? String(container.template).split('/')[1] : undefined
        draft.arch = container.template ? String(container.template).split('/')[2] : undefined
        draft.lxcNet = nic && nic.link ? nic.link : 'lxcbr0'
        draft.ipMode = nic && nic.ipv4 && nic.ipv4.address ? 'static' : 'dhcp'
        draft.ipAddress = nic && nic.ipv4 && nic.ipv4.address ? nic.ipv4.address : ''
        draft.autostart = Boolean(d.autostart)
      }
      return draft
    }

    function LimitsCard({ container, node, busy }) {
      const limits = container.limits || {}
      const [memory, setMemory] = React.useState(limits.memory ? formatBytesShort(limits.memory) : '')
      const [cpus, setCpus] = React.useState(limits.cpus ? String(limits.cpus) : '')
      const [working, setWorking] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [done, setDone] = React.useState(null)

      async function save() {
        setWorking(true)
        setError(null)
        setDone(null)
        try {
          await jpost('/containers/' + encodeURIComponent(node.id) + '/' + encodeURIComponent(container.name) + '/limits', {
            memory: memory.trim() || 0,
            cpus: cpus.trim() || 0,
          })
          setDone('已生效')
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setWorking(false)
        }
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '资源限制'),
        h('div', { 'data-cm-form': '' },
          field('内存', h('input', { 'data-cm-input': '', value: memory, placeholder: '256m / 1g，留空 = 不限', onChange: e => setMemory(e.target.value) })),
          field('CPU', h('input', { 'data-cm-input': '', value: cpus, placeholder: '1.5，留空 = 不限', onChange: e => setCpus(e.target.value) }))),
        h('div', { 'data-cm-actions': '' },
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: working || busy, onClick: save }, working ? '保存中…' : '保存')),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } }, error) : null,
        done ? h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } }, done) : null,
        h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
          '走 podman update，保存后会读回来核对是否真的生效 —— rootless podman 4.3.1 常常只写配置、不写 cgroup，那种情况会直接报错而不是假装成功。重启策略 / 端口 / 挂载改不了，要换就「以此配置新建」再删旧的。'))
    }
    function ContainerMore({ container, node }) {
      const [open, setOpen] = React.useState(false)
      const isLxc = node && node.kind === 'lxc'
      return h('div', { 'data-cm-card': '' },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '更多'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', onClick: () => setOpen(!open) }, open ? '收起' : '展开原始数据')),
        open ? h(ContainerRaw, { container, isLxc }) : null,
      )
    }

    function ContainerRaw({ container, isLxc }) {
      const [raw, setRaw] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        jget(`/containers/${encodeURIComponent(container.nodeId)}/${encodeURIComponent(container.name)}`)
          .then(data => { if (alive) setRaw(data) })
          .catch(e => { if (alive) setError(e.message) })
        return () => { alive = false }
      }, [container.nodeId, container.name])
      if (error) return h('div', { 'data-cm-warn': '' }, error)
      if (!raw) return h('div', { 'data-cm-dim': '' }, '读取中…')
      return h('pre', { 'data-cm-pre': '' }, JSON.stringify(raw, null, 2))
    }

    function LogsPane({ container }) {
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState(null)
      const [tail, setTail] = React.useState(100)
      const [loading, setLoading] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const data = await jget(`/containers/${encodeURIComponent(container.nodeId)}/${encodeURIComponent(container.name)}/logs?tail=${tail}`)
          setText(data.text || '（没有输出）')
          setError(null)
        } catch (e) {
          setError(e.message)
        } finally {
          setLoading(false)
        }
      }, [container.nodeId, container.name, tail])

      React.useEffect(() => { load() }, [load])

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, `${container.name} 的日志`),
            h('div', { 'data-cm-grow': '' }),
            h('select', {
              'data-cm-select': '',
              value: String(tail),
              onChange: event => setTail(Number(event.target.value) || 100),
            }, ...[100, 300, 1000, 2000].map(value => h('option', { key: value, value: String(value) }, `最近 ${value} 行`))),
            h('button', { 'data-cm-btn': '', onClick: () => downloadText(container.name + '-log.txt', text) }, '下载'),
            h('button', { 'data-cm-btn': '', disabled: loading, onClick: load }, loading ? '读取中…' : '刷新')),
          error ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px' } }, error) : null,
          h('pre', { 'data-cm-pre': '', style: { marginTop: '8px' } }, text)),
        h('div', { 'data-cm-dim': '' }, '只拉一次快照，不会跟着自动刷新；点「刷新」再看最新。'))
    }

    /**
     * 环境变量里哪些值的键名说明了「这是口令」。
     *
     * 只按键名判断，不看值 —— 值长什么样都可能有假阳性（哈希也是长串）。
     * 命中就默认打码，要看得单独点开，避免一次操作把整屏密钥摊在投影上。
     */
    const SECRET_ENV_KEY = /(SECRET|KEY|PASS|TOKEN|PWD|AUTH|CREDENTIAL)/i
    // 这些键名里带着「像秘密」的词，值却是数字、枚举或地址，糊掉只是让人看不清配置：
    // TOKEN_EXPIRY=3600、AUTH_MODE=oauth、PASSWORD_MIN_LEN=8 都曾被误伤。
    const NOT_SECRET_KEY = /(_EXPIRY|_TTL|_TIMEOUT|_MS|_SECONDS?|_COUNT|_LEN|_LENGTH|_SIZE|_URL|_URI|_MODE|_ENABLED|_ENABLE|_TYPE|_NAME|_PATH|_PORT|_HOST|_FILE|_DIR|_MAX|_MIN|_AGE|_AT|_INTERVAL|_RETRY)$/i
    function isSecretKey(key) {
      const text = String(key || '')
      if (NOT_SECRET_KEY.test(text)) return false
      return SECRET_ENV_KEY.test(text)
    }

    /** 重建会牵动的字段，以及它们在界面上叫什么。 */
    const REBUILD_FIELDS = [
      ['ports', '端口映射'],
      ['volumes', '挂载点'],
      ['env', '环境变量'],
      ['restart', '重启策略'],
      ['command', '启动命令'],
      ['entrypoint', 'entrypoint'],
      ['network', '网络模式'],
      ['hostname', '主机名'],
      ['user', '运行用户'],
      ['workdir', '工作目录'],
      ['privileged', '特权模式'],
      ['autoRemove', '退出后自动删除'],
      ['pidsLimit', 'PID 上限'],
      ['capAdd', '新增 capabilities'],
      ['capDrop', '丢弃 capabilities'],
      ['securityOpt', '安全选项'],
    ]

    /** 一个字段在两版之间怎么读：数组数条目，布尔说开关，其它原样。 */
    function draftValueText(value) {
      if (Array.isArray(value)) return value.length + " 项"
      if (typeof value === "boolean") return value ? "开" : "关"
      const text = value === undefined || value === null ? "" : String(value).trim()
      return text === '' ? '（空）' : text
    }

    /** 环境变量的差量单独算：只说「改了几项」不够，得说清增/改/删。 */
    function envDiff(before, after) {
      const toMap = (rows) => {
        const map = new Map()
        for (const row of Array.isArray(rows) ? rows : []) {
          const key = String((row && row.key) || "").trim()
          if (key) map.set(key, String(row.value === undefined || row.value === null ? "" : row.value))
        }
        return map
      }
      const a = toMap(before)
      const b = toMap(after)
      let added = 0
      let changed = 0
      let removed = 0
      for (const [key, value] of b) {
        if (!a.has(key)) added += 1
        else if (a.get(key) !== value) changed += 1
      }
      for (const key of a.keys()) if (!b.has(key)) removed += 1
      const parts = []
      if (added) parts.push('新增 ' + added)
      if (changed) parts.push('修改 ' + changed)
      if (removed) parts.push('删除 ' + removed)
      return parts.join(' · ') || '无变化'
    }

    /**
     * 草稿与基线的差量。空数组 = 没有改动 = 重建按钮该是灰的。
     * 不做字符级 diff：容器配置本来就是结构化键值，说清「哪几项变了」最有用。
     */
    function diffDraft(baseline, draft) {
      if (!baseline || !draft) return []
      const out = []
      for (const [key, label] of REBUILD_FIELDS) {
        const a = baseline[key]
        const b = draft[key]
        if (JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)) continue
        out.push({
          key,
          label,
          before: key === 'env' ? draftValueText(a) : draftValueText(a),
          after: key === 'env' ? envDiff(a, b) : draftValueText(b),
        })
      }
      return out
    }

    /** 复制到剪贴板：没权限就静默失败，不弹错（用户还能手动选）。 */
    function copyText(text) {
      try { navigator.clipboard.writeText(String(text)) } catch { /* 没权限就算了 */ }
    }

    /* ───────────────────── Podman 容器配置 ─────────────────────
       Podman 和 LXC 的配置模型是两回事，别用同一套表单糊过去：

       - 资源限制可以 podman update 热改，立刻写进 cgroup，容器不用重启；
       - 端口 / 挂载 / 环境变量 / 重启策略 / 命令这些只在 run 那一刻定死，
         改了只能重建容器（换新 ID，容器内没挂在卷上的数据会丢）。

       所以这一页分成「立即生效」和「重建生效」两段，各自写清楚代价，
       不把两者混在一个「保存」按钮里骗人。 */
    function PodmanConfigPane({ container }) {
      const base = '/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name)
      const [detail, setDetail] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      // 热改：写进 cgroup，立即生效
      const [hot, setHot] = React.useState({
        cpus: '', cpuShares: '', cpusetCpus: '',
        memory: '', memoryReservation: '', memorySwap: '', blkioWeight: '',
      })
      const [hotBusy, setHotBusy] = React.useState(false)
      const [hotToast, setHotToast] = React.useState(null)

      // 重建：整份参数重来一遍
      const [draft, setDraft] = React.useState(null)
      // 基线 = 打开这一页时容器的真实配置。重建按钮拿它算差了几项。
      const [baseline, setBaseline] = React.useState(null)
      // 逐条显示哪些环境变量的明文（只对敏感键名生效，见 isSecretKey）。
      const [revealedEnv, setRevealedEnv] = React.useState({})
      const [coldBusy, setColdBusy] = React.useState(false)
      const [coldToast, setColdToast] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        setLoading(true)
        setLoadError(null)
        jget(base).then(data => {
          if (!alive) return
          setDetail(data)
          const lim = data.limits || {}
          setHot({
            cpus: lim.cpus !== null && lim.cpus !== undefined ? String(lim.cpus) : '',
            cpuShares: lim.cpuShares ? String(lim.cpuShares) : '',
            cpusetCpus: lim.cpusetCpus || '',
            memory: lim.memory ? (formatBytesShort(lim.memory) || String(lim.memory)) : '',
            memoryReservation: lim.memoryReservation ? (formatBytesShort(lim.memoryReservation) || String(lim.memoryReservation)) : '',
            memorySwap: lim.memorySwap && lim.memorySwap > 0 ? (formatBytesShort(lim.memorySwap) || String(lim.memorySwap)) : '',
            blkioWeight: lim.blkioWeight ? String(lim.blkioWeight) : '',
          })
          const imm = data.immutable || {}
          const policy = (data.restartPolicy && data.restartPolicy.Name) || 'no'
          // 同一个对象既当草稿又当基线：重建按钮要知道「到底改了几项」才会亮。
          const initialDraft = {
            ports: (data.ports || []).map(p => ({
              hostIp: p.hostIp || '',
              hostPort: p.hostPort === null || p.hostPort === undefined ? '' : String(p.hostPort),
              containerPort: String(p.containerPort || ''),
              protocol: p.protocol || 'tcp',
            })),
            volumes: (data.mounts || []).map(m => ({
              source: m.source || '',
              destination: m.destination || '',
              ro: m.rw === false,
            })),
            env: Object.keys(data.env || {}).sort().map(key => ({ key, value: String((data.env || {})[key] ?? '') })),
            restart: policy,
            command: (data.command || []).join(' '),
            entrypoint: Array.isArray(data.entrypoint) ? data.entrypoint.join(' ') : (data.entrypoint ? String(data.entrypoint) : ''),
            network: data.networkMode || '',
            hostname: imm.hostname || '',
            user: imm.user || '',
            workdir: imm.workdir || '',
            privileged: Boolean(imm.privileged),
            autoRemove: Boolean(imm.autoRemove),
            pidsLimit: lim.pidsLimit ? String(lim.pidsLimit) : '',
            capAdd: (imm.capAdd || []).join(' '),
            capDrop: (imm.capDrop || []).join(' '),
            securityOpt: (imm.securityOpt || []).join(' '),
          }
          setDraft(initialDraft)
          setBaseline(initialDraft)
          setLoading(false)
        }).catch(err => {
          if (!alive) return
          setLoadError(err.message || String(err))
          setLoading(false)
        })
        return () => { alive = false }
      }, [base, tick])

      function setHotField(name, value) {
        setHot(prev => ({ ...prev, [name]: value }))
      }

      function setField(name, value) {
        setDraft(prev => prev ? ({ ...prev, [name]: value }) : prev)
      }

      async function saveHot() {
        if (!draft) return
        setHotBusy(true)
        setHotToast(null)
        setError(null)
        try {
          const payload = {}
          if (hot.cpus.trim() !== '') payload.cpus = Number(hot.cpus)
          if (hot.cpuShares.trim() !== '') payload.cpuShares = Number(hot.cpuShares)
          if (hot.cpusetCpus.trim() !== '') payload.cpusetCpus = hot.cpusetCpus.trim()
          if (hot.memory.trim() !== '') payload.memory = hot.memory.trim()
          if (hot.memoryReservation.trim() !== '') payload.memoryReservation = hot.memoryReservation.trim()
          if (hot.memorySwap.trim() !== '') payload.memorySwap = hot.memorySwap.trim()
          if (hot.blkioWeight.trim() !== '') payload.blkioWeight = Number(hot.blkioWeight)
          if (Object.keys(payload).length === 0) throw new Error('没有填任何限制项。')
          await jpost(base + '/limits', payload)
          setHotToast('已写入 cgroup，立即生效，不用重启容器')
          setTick(n => n + 1)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setHotBusy(false)
        }
      }

      async function saveCold() {
        if (!draft) return
        // 没有改动就不发请求：重建会换新容器 ID，宁可按钮是灰的也不让它误触。
        if (diffDraft(baseline, draft).length === 0) {
          setError('没有改任何参数，不需要重建。')
          return
        }
        setColdBusy(true)
        setColdToast(null)
        setError(null)
        try {
          const env = {}
          for (const row of draft.env) {
            const key = String(row.key || '').trim()
            if (!key) continue
            env[key] = String(row.value === undefined || row.value === null ? '' : row.value)
          }
          const ports = []
          for (const one of draft.ports) {
            if (String(one.containerPort).trim() === '') continue
            ports.push({
              hostIp: String(one.hostIp || '').trim(),
              hostPort: String(one.hostPort).trim() === '' ? null : Number(one.hostPort),
              containerPort: Number(one.containerPort),
              protocol: one.protocol === 'udp' ? 'udp' : 'tcp',
            })
          }
          const volumes = []
          for (const one of draft.volumes) {
            if (!String(one.source).trim() || !String(one.destination).trim()) continue
            volumes.push({ source: String(one.source).trim(), destination: String(one.destination).trim(), ro: Boolean(one.ro) })
          }
          const splitList = text => String(text || '').trim() === '' ? [] : String(text).trim().split(/\s+/)
          const payload = {
            ports,
            volumes,
            env,
            restart: draft.restart || 'no',
            command: splitList(draft.command),
            entrypoint: splitList(draft.entrypoint),
            network: String(draft.network || '').trim(),
            hostname: String(draft.hostname || '').trim(),
            user: String(draft.user || '').trim(),
            workdir: String(draft.workdir || '').trim(),
            privileged: Boolean(draft.privileged),
            autoRemove: Boolean(draft.autoRemove),
            pidsLimit: String(draft.pidsLimit || '').trim() === '' ? null : Number(draft.pidsLimit),
            capAdd: splitList(draft.capAdd),
            capDrop: splitList(draft.capDrop),
            securityOpt: splitList(draft.securityOpt),
          }
          const result = await jpost(base + '/recreate', payload)
          if (result && result.status === 'pending') {
            setColdToast('已挂起 —— 去底部「待确认」点一下才会真正重建')
          } else {
            setColdToast('已按新参数重建，容器 ID 变了')
          }
          setTick(n => n + 1)
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setColdBusy(false)
        }
      }

      if (loading) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-dim': '' }, '读取容器配置…'))
      if (loadError) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '读不到配置'),
          h('div', { 'data-cm-warn': '' }, loadError),
          h('button', { 'data-cm-btn': '', onClick: () => setTick(n => n + 1) }, '重试'))
      }
      if (!draft) return null

      const limitsLive = detail && detail.limits ? detail.limits : {}
      // 改了哪几项，重建按钮与它上面的差量表都吃这一份。
      const changes = diffDraft(baseline, draft)
      const restartOptions = [
        ['no', 'no —— 不自动重启'],
        ['on-failure', 'on-failure —— 非零退出才重启'],
        ['always', 'always —— 总是重启'],
        ['unless-stopped', 'unless-stopped —— 除非手动停掉'],
      ]

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
            '运行时限制',
            h('span', { 'data-cm-dim': '', style: { marginLeft: '8px', fontWeight: '400' } }, 'podman update · 立即生效')),

          h('div', { 'data-cm-formrow': '' },
            field('CPU 核数', h('input', { 'data-cm-input': '', value: hot.cpus, placeholder: '例如 1.5，留空不改', onChange: event => setHotField('cpus', event.target.value) })),
            field('CPU 权重', h('input', { 'data-cm-input': '', value: hot.cpuShares, placeholder: '10–1000', onChange: event => setHotField('cpuShares', event.target.value) })),
            field('绑核', h('input', { 'data-cm-input': '', value: hot.cpusetCpus, placeholder: '例如 0-1 或 0,2', onChange: event => setHotField('cpusetCpus', event.target.value) }))),
          h('div', { 'data-cm-formrow': '' },
            field('内存上限', h('input', { 'data-cm-input': '', value: hot.memory, placeholder: '例如 512m / 1g', onChange: event => setHotField('memory', event.target.value) })),
            field('内存软限', h('input', { 'data-cm-input': '', value: hot.memoryReservation, placeholder: '超过先回收', onChange: event => setHotField('memoryReservation', event.target.value) })),
            field('内存 + swap', h('input', { 'data-cm-input': '', value: hot.memorySwap, placeholder: '总上限，-1 = 不限', onChange: event => setHotField('memorySwap', event.target.value) }))),
          h('div', { 'data-cm-formrow': '' },
            field('块设备权重', h('input', { 'data-cm-input': '', value: hot.blkioWeight, placeholder: '10–1000', onChange: event => setHotField('blkioWeight', event.target.value) })),
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: hotBusy, onClick: saveHot }, hotBusy ? '写入中…' : '应用限制')),
          hotToast ? h('div', { 'data-cm-hintbox': '' }, hotToast) : null,
          h('div', { 'data-cm-dim': '', style: { marginTop: 'var(--cm-s3)' } },
            '写进去就生效，容器不用重启。注意 podman inspect 里的 HostConfig 不会跟着变，',
            h('span', null, '那是 podman 4.3.1 的老毛病——要看真实上限得读容器内的 cgroup，别拿 inspect 当没生效的证据。')),

          h('div', { 'data-cm-line': '' }),
          h('div', { 'data-cm-kv': '' },
            h('span', { 'data-cm-dim': '' }, '建容器时的限制'),
            h('span', { 'data-cm-mono': '' },
              'mem=' + (limitsLive.memory ? formatBytesShort(limitsLive.memory) : '不限') +
              ' · pids=' + (limitsLive.pidsLimit ? limitsLive.pidsLimit : '不限')))),

        h('div', { 'data-cm-card': '', style: { marginTop: 'var(--cm-s4)' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
            '容器参数',
            h('span', { 'data-cm-dim': '', style: { marginLeft: '8px', fontWeight: '400' } }, 'podman run · 需重建生效')),
          h('div', { 'data-cm-warn': '', style: { marginBottom: 'var(--cm-s3)' } },
            '这些参数在 podman run 那一刻就定死了，改只能重建容器：会换一个新的容器 ID，',
            '容器里没挂在卷上的数据会丢。面板的做法是「先建新的、起来之后换名字、再删旧的」，',
            '任一步失败都会把旧容器放回去，不会先删后建。'),

          h('div', { 'data-cm-sec': '' }, '端口映射'),
          ...draft.ports.map((one, index) => h('div', { key: 'port' + index, 'data-cm-formrow': '' },
            field('宿主端口', h('input', { 'data-cm-input': '', value: one.hostPort, placeholder: '留空 = 随机', onChange: event => {
              const next = draft.ports.slice(); next[index] = { ...next[index], hostPort: event.target.value }; setField('ports', next)
            } })),
            field('容器端口', h('input', { 'data-cm-input': '', value: one.containerPort, onChange: event => {
              const next = draft.ports.slice(); next[index] = { ...next[index], containerPort: event.target.value }; setField('ports', next)
            } })),
            field('协议', h('select', { 'data-cm-input': '', value: one.protocol, onChange: event => {
              const next = draft.ports.slice(); next[index] = { ...next[index], protocol: event.target.value }; setField('ports', next)
            } }, h('option', { value: 'tcp' }, 'tcp'), h('option', { value: 'udp' }, 'udp'))),
            h('button', { 'data-cm-btn': '', onClick: () => setField('ports', draft.ports.filter((_, i) => i !== index)) }, '删除'))),
          h('button', { 'data-cm-btn': '', onClick: () => setField('ports', draft.ports.concat([{ hostIp: '', hostPort: '', containerPort: '', protocol: 'tcp' }])) }, '＋ 加一条端口'),

          h('div', { 'data-cm-sec': '' }, '挂载'),
          ...draft.volumes.map((one, index) => h('div', { key: 'vol' + index, 'data-cm-formrow': '' },
            field('宿主路径', h('input', { 'data-cm-input': '', value: one.source, onChange: event => {
              const next = draft.volumes.slice(); next[index] = { ...next[index], source: event.target.value }; setField('volumes', next)
            } })),
            field('容器路径', h('input', { 'data-cm-input': '', value: one.destination, onChange: event => {
              const next = draft.volumes.slice(); next[index] = { ...next[index], destination: event.target.value }; setField('volumes', next)
            } })),
            h('label', { 'data-cm-check': '' },
              h('input', { type: 'checkbox', checked: Boolean(one.ro), onChange: event => {
                const next = draft.volumes.slice(); next[index] = { ...next[index], ro: event.target.checked }; setField('volumes', next)
              } }),
              '只读'),
            h('button', { 'data-cm-btn': '', onClick: () => setField('volumes', draft.volumes.filter((_, i) => i !== index)) }, '删除'))),
          h('button', { 'data-cm-btn': '', onClick: () => setField('volumes', draft.volumes.concat([{ source: '', destination: '', ro: false }])) }, '＋ 加一条挂载'),

          // 只给「全部隐藏」这一个方向：一键把已经点开的又盖回去是安全的，
          // 反过来的「全部显示」不给 —— 一次点击把整屏密钥摊在投影上，代价太大。
          h('div', { 'data-cm-sec': '', style: { display: 'flex', alignItems: 'center', gap: 'var(--cm-s3)' } },
            '环境变量',
            Object.keys(revealedEnv).some(k => revealedEnv[k])
              ? h('button', { 'data-cm-btn': '', onClick: () => setRevealedEnv({}) }, '全部隐藏')
              : null),
          h('div', { 'data-cm-dim': '', style: { marginBottom: 'var(--cm-s2)' } },
            '键名里带 SECRET / KEY / PASS / TOKEN / PWD / AUTH / CREDENTIAL 的默认打码；',
            'TOKEN_EXPIRY / AUTH_MODE 这类明显不是口令的键不打码。要看哪条单独点「显示」。'),
          ...draft.env.map((one, index) => {
            const secret = isSecretKey(one.key)
            const plain = !secret || Boolean(revealedEnv[index])
            return h('div', { key: 'env' + index, 'data-cm-formrow': '' },
              field('键', h('input', { 'data-cm-input': '', value: one.key, onChange: event => {
                const next = draft.env.slice(); next[index] = { ...next[index], key: event.target.value }; setField('env', next)
              } })),
              field('值', h('input', {
                'data-cm-input': '',
                type: plain ? 'text' : 'password',
                value: one.value,
                onChange: event => {
                  const next = draft.env.slice(); next[index] = { ...next[index], value: event.target.value }; setField('env', next)
                },
              })),
              secret
                ? h('button', { 'data-cm-btn': '', onClick: () => setRevealedEnv(prev => ({ ...prev, [index]: !prev[index] })) },
                  revealedEnv[index] ? '隐藏' : '显示')
                : null,
              h('button', { 'data-cm-btn': '', title: '复制这个值', onClick: () => copyText(one.value) }, '复制'),
              h('button', { 'data-cm-btn': '', onClick: () => {
                setRevealedEnv({})
                setField('env', draft.env.filter((_, i) => i !== index))
              } }, '删除'))
          }),
          h('button', { 'data-cm-btn': '', onClick: () => setField('env', draft.env.concat([{ key: '', value: '' }])) }, '＋ 加一条环境变量'),

          h('div', { 'data-cm-sec': '' }, '启动与身份'),
          h('div', { 'data-cm-formrow': '' },
            field('重启策略', h('select', { 'data-cm-input': '', value: draft.restart, onChange: event => setField('restart', event.target.value) },
              ...restartOptions.map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
            field('网络模式', h('input', { 'data-cm-input': '', value: draft.network, placeholder: '例如 host / bridge / 网络名', onChange: event => setField('network', event.target.value) })),
            field('主机名', h('input', { 'data-cm-input': '', value: draft.hostname, onChange: event => setField('hostname', event.target.value) }))),
          h('div', { 'data-cm-formrow': '' },
            field('运行用户', h('input', { 'data-cm-input': '', value: draft.user, placeholder: '例如 1000:1000', onChange: event => setField('user', event.target.value) })),
            field('工作目录', h('input', { 'data-cm-input': '', value: draft.workdir, placeholder: '例如 /app', onChange: event => setField('workdir', event.target.value) })),
            field('PID 上限', h('input', { 'data-cm-input': '', value: draft.pidsLimit, placeholder: '只能建时设', onChange: event => setField('pidsLimit', event.target.value) }))),

          field('启动命令（空格分隔，留空 = 用镜像的）', h('input', { 'data-cm-input': '', value: draft.command, onChange: event => setField('command', event.target.value) })),
          field('entrypoint（空格分隔，留空 = 用镜像的）', h('input', { 'data-cm-input': '', value: draft.entrypoint, onChange: event => setField('entrypoint', event.target.value) })),

          h('div', { 'data-cm-sec': '' }, '权限'),
          h('div', { 'data-cm-formrow': '' },
            field('新增 capabilities（空格分隔）', h('input', { 'data-cm-input': '', value: draft.capAdd, placeholder: '例如 NET_ADMIN', onChange: event => setField('capAdd', event.target.value) })),
            field('丢弃 capabilities（空格分隔）', h('input', { 'data-cm-input': '', value: draft.capDrop, placeholder: '例如 SYS_ADMIN', onChange: event => setField('capDrop', event.target.value) }))),
          field('安全选项（空格分隔）', h('input', { 'data-cm-input': '', value: draft.securityOpt, placeholder: '例如 no-new-privileges', onChange: event => setField('securityOpt', event.target.value) })),
          h('label', { 'data-cm-check': '' },
            h('input', { type: 'checkbox', checked: Boolean(draft.privileged), onChange: event => setField('privileged', event.target.checked) }),
            '特权模式（--privileged，容器内等于宿主 root）'),
          h('label', { 'data-cm-check': '' },
            h('input', { type: 'checkbox', checked: Boolean(draft.autoRemove), onChange: event => setField('autoRemove', event.target.checked) }),
            '退出后自动删除容器（--rm）'),

          // 差量表：重建是不可逆的（换新 ID），点之前必须看清改了哪几项。
          changes.length > 0
            ? h('div', { 'data-cm-diff': '' },
              h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '即将变更 ' + changes.length + ' 项'),
              ...changes.map(item => h('div', { key: item.key, 'data-cm-portrow': '' },
                h('span', { 'data-cm-portpill': '', 'data-muted': '' }, item.label),
                h('span', { 'data-cm-portarrow': '' }, '原 ' + item.before),
                h('span', { 'data-cm-portarrow': '' }, '→'),
                h('span', { 'data-cm-portpill': '' }, item.after))))
            : h('div', { 'data-cm-dim': '', style: { marginTop: 'var(--cm-s3)' } },
              '当前没有改动。动哪一项，下面的按钮才会亮。'),
          h('div', { 'data-cm-actions': '' },
            h('button', {
              'data-cm-btn': '',
              'data-primary': '',
              disabled: coldBusy || changes.length === 0,
              onClick: saveCold,
            }, coldBusy ? '提交中…' : (changes.length === 0 ? '无参数变更' : '审查变更并重建（' + changes.length + ' 项）'))),
          coldToast ? h('div', { 'data-cm-hintbox': '' }, coldToast) : null,
          error ? h('div', { 'data-cm-warn': '' }, error) : null),

        h('div', { 'data-cm-card': '', style: { marginTop: 'var(--cm-s4)' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '只读信息'),
          h('div', { 'data-cm-kv': '' },
            h('span', { 'data-cm-dim': '' }, '镜像'), h('span', { 'data-cm-mono': '' }, detail && detail.image ? detail.image : '—'),
            h('span', { 'data-cm-dim': '' }, '容器 ID'), h('span', { 'data-cm-mono': '' }, detail && detail.shortId ? detail.shortId : '—'),
            h('span', { 'data-cm-dim': '' }, '状态'), h('span', { 'data-cm-mono': '' }, detail && detail.state ? detail.state : '—'),
            h('span', { 'data-cm-dim': '' }, 'PID'), h('span', { 'data-cm-mono': '' }, detail && detail.pid ? String(detail.pid) : '—'))))
    }

      /**
       * LXC 容器配置页的外壳。
       *
       * 网卡、挂载、快照都是「这个容器的配置」，只是量级差很多（网卡天天改、快照一年两次）。
       * 所以它们收进同一页的分段控件里，不再各占一个一级 tab —— 低频操作不该待在最显眼的一行。
       * 这里只是外壳，里面三个面板原样复用，内部逻辑一行没动。
       */
      function LxcConfigShell({ container, bridges, onToast }) {
        const [seg, setSeg] = React.useState('nic')
        const ref = { nodeId: container.nodeId, name: container.name }
        const segs = [
          ['nic', '网卡与资源'],
          ['mount', '挂载点'],
          ['snap', '快照'],
        ]
        return h('div', null,
          h('div', { 'data-cm-seg': '' },
            ...segs.map(([id, label]) => h('button', {
              key: id,
              'data-cm-segitem': '',
              'data-active': seg === id ? '' : undefined,
              onClick: () => setSeg(id),
            }, label))),
          seg === 'nic'
            ? h(ConfigPane, { container, bridges })
            : seg === 'mount'
              ? h(MountsPane, { container: ref, onToast })
              : h(SnapshotsPane, { container: ref, onToast }))
      }
    function ConfigPane({ container, bridges }) {
      const [nicText, setNicText] = React.useState('')
      // 网卡表单（对 nics[0] 建模）。多于一块、或字段认不出的，自动走「原始 JSON」。
      const [nicLink, setNicLink] = React.useState('lxcbr0')
      const [nicIpMode, setNicIpMode] = React.useState('dhcp')
      const [nicIp, setNicIp] = React.useState('')
      const [nicGw, setNicGw] = React.useState('')
      const [nic6Mode, setNic6Mode] = React.useState('off')
      const [nic6Ip, setNic6Ip] = React.useState('')
      const [nic6Gw, setNic6Gw] = React.useState('')
      const [nicRawMode, setNicRawMode] = React.useState(false)
      const [nicMac, setNicMac] = React.useState('')
  // 从 config 读回来的 MAC 视为「人定的」，撞了要拦住；点「随机」抽出来的才算可自动避让。
  const [nicMacAuto, setNicMacAuto] = React.useState(false)
      const [nicHadMac, setNicHadMac] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const bridgeList = Array.isArray(bridges) ? bridges : []
      const [autostartOn, setAutostartOn] = React.useState(false)
      const [memoryText, setMemoryText] = React.useState('')
      const [settingsBusy, setSettingsBusy] = React.useState(false)
      const [settingsToast, setSettingsToast] = React.useState(null)
      const [coresText, setCoresText] = React.useState('')
      const [swapText, setSwapText] = React.useState('')
      const [liveInfo, setLiveInfo] = React.useState(null)
      const [resourceBusy, setResourceBusy] = React.useState(false)
      const [resourceToast, setResourceToast] = React.useState(null)
      // 基本 / 安全
      const [hostnameText, setHostnameText] = React.useState('')
      const [startOrderText, setStartOrderText] = React.useState('')
      const [startDelayText, setStartDelayText] = React.useState('')
      const [initCmdText, setInitCmdText] = React.useState('')
      const [capDropText, setCapDropText] = React.useState('')
      // 资源扩展
      const [cpuQuotaText, setCpuQuotaText] = React.useState('')
      const [cpuWeightText, setCpuWeightText] = React.useState('')
      const [memoryHighText, setMemoryHighText] = React.useState('')
      const [oomGroupOn, setOomGroupOn] = React.useState(false)
      const [pidsText, setPidsText] = React.useState('')
      const [ioWeightText, setIoWeightText] = React.useState('')
      const isLxc = container.runtime === 'lxc'
      const base = `/containers/${encodeURIComponent(container.nodeId)}/${encodeURIComponent(container.name)}`

      // 详情里 cgroup 的实时值优先（那才是真在生效的）；读不到才退回 config 里的设置。
      function applyResourceState(data) {
        if (!data) return
        const live = data.resources || {}
        const settings = data.settings || {}
        setAutostartOn(settings.autostart === true || data.autostart === true)
        const memLimit = live.memoryMax && live.memoryMax !== 'max' ? live.memoryMax : (settings.memoryMax || '')
        setMemoryText(memLimit ? (formatBytesShort(memLimit) || String(memLimit)) : '')
        const swapLimit = live.swapMax && live.swapMax !== 'max' ? live.swapMax : (settings.swapMax || '')
        setSwapText(swapLimit ? (formatBytesShort(swapLimit) || String(swapLimit)) : '')
        setCoresText(cpusetCount(live.cpusetCpus || settings.cores || ''))
        // 基本
        setHostnameText(settings.hostname || '')
        setStartOrderText(settings.startOrder || '')
        setStartDelayText(settings.startDelay || '')
        setInitCmdText(settings.initCmd || '')
        setCapDropText(settings.capDrop || '')
        // CPU 配额：cgroup 里的 cpu.max 才是真在生效的，回退到 config
        setCpuQuotaText(cpuQuotaFromMax(live.cpuMax || settings.cpuMax || ''))
        const weight = live.cpuWeight || settings.cpuWeight || ''
        setCpuWeightText(weight && weight !== '100' ? weight : '')
        // 内存软限与 OOM 组
        const high = live.memoryHigh && live.memoryHigh !== 'max' ? live.memoryHigh : (settings.memoryHigh || '')
        setMemoryHighText(high ? (formatBytesShort(high) || String(high)) : '')
        setOomGroupOn((live.oomGroup || settings.oomGroup || '') === '1' || settings.oomGroup === true)
        const pids = live.pidsMax && live.pidsMax !== 'max' ? live.pidsMax : (settings.pidsMax || '')
        setPidsText(pids || '')
        setIoWeightText(ioWeightValue(live.ioWeight || settings.ioWeight || ''))
        setLiveInfo({
          cpuset: live.cpusetCpus || '',
          effective: live.cpusetEffective || '',
          cpuMax: live.cpuMax || '',
          cpuWeight: live.cpuWeight || '',
          memoryMax: live.memoryMax || '',
          memoryCurrent: live.memoryCurrent || '',
          memoryHigh: live.memoryHigh || '',
          memoryPeak: live.memoryPeak || '',
          oomGroup: live.oomGroup || '',
          swapMax: live.swapMax || '',
          swapCurrent: live.swapCurrent || '',
          pidsMax: live.pidsMax || '',
          pidsCurrent: live.pidsCurrent || '',
          ioWeight: live.ioWeight || '',
        })
      }

      React.useEffect(() => {
        if (!isLxc) return
        let alive = true
        jget(base + '/network')
          .then(data => {
            if (!alive) return
            const nics = Array.isArray(data.nics) ? data.nics : []
            setNicText(JSON.stringify(nics, null, 2))
            const nic = nics[0]
            if (nic) {
              applyNicToForm(nic)
            }
            // 表单能表达：网桥、MAC、IPv4、IPv6。剩下这些才交给原始 JSON。
            // 注意别把 hwaddr 算进来 —— 它已经有自己的输入框了，算进来会让老容器一打开就进原始模式，
            // 而原始模式保存用的是 JSON 快照，表单改动会被静默丢掉。
            const exotic = nics.length > 1 || nics.some(item => item && (item.type === 'macvlan' || item.mtu != null))
            if (exotic) setNicRawMode(true)
          })
          .catch(e => { if (alive) setError(e.message) })
        jget(base)
          .then(data => {
            if (!alive || !data) return
            applyResourceState(data)
          })
          .catch(() => { /* 读不到启动项不影响网卡编辑 */ })
        return () => { alive = false }
      }, [container.nodeId, container.name, isLxc])

      if (!isLxc) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'Podman 容器配置'),
          h('div', { 'data-cm-dim': '' }, 'Podman 的容器配置用「概览 → 展开原始数据」看。要改端口/网络归属，目前只能重建容器（第一版不提供一键重建）。'))
      }

      /** nic → 表单。从接口读回来、或从原始 JSON 切回表单时都用它。 */
      function applyNicToForm(nic) {
        if (!nic) return
        setNicLink(nic.link || 'lxcbr0')
        setNicMac(nic.hwaddr || '')
        setNicMacAuto(false)
        setNicHadMac(Boolean(nic.hwaddr))
        if (nic.ipv4 && nic.ipv4.address) {
          setNicIpMode('static')
          setNicIp(nic.ipv4.address)
          setNicGw(nic.ipv4.gateway || '')
        } else {
          setNicIpMode('dhcp')
          setNicIp('')
          setNicGw('')
        }
        if (nic.ipv6 && nic.ipv6.address) {
          setNic6Mode('static')
          setNic6Ip(nic.ipv6.address)
          setNic6Gw(nic.ipv6.gateway || '')
        } else {
          setNic6Mode('off')
          setNic6Ip('')
          setNic6Gw('')
        }
      }

      /** 表单 → nic 数组。helper 会自己补 flags 与空的 ipv4/ipv6。 */
      function nicsFromForm() {
        const nic = { type: 'veth', link: nicLink }
        // 空着就不写 —— 保持这台的原本行为，不突然改它的 MAC。
        if (nicMac.trim()) {
          nic.hwaddr = nicMac.trim()
          if (nicMacAuto) nic.hwaddrAuto = true
        }
        if (nicIpMode === 'static') {
          nic.ipv4 = { address: nicIp.trim() }
          if (nicGw.trim()) nic.ipv4.gateway = nicGw.trim()
        }
        if (nic6Mode === 'static') {
          nic.ipv6 = { address: nic6Ip.trim() }
          if (nic6Gw.trim()) nic.ipv6.gateway = nic6Gw.trim()
        }
        return [nic]
      }

      async function save() {
        let nics
        if (nicRawMode) {
          try {
            nics = JSON.parse(nicText)
          } catch {
            setToast({ bad: true, text: 'JSON 解析失败。' })
            return
          }
        } else {
          if (nicIpMode === 'static' && !nicIp.trim()) {
            setToast({ bad: true, text: '静态 IPv4 要给地址（带前缀，例如 10.0.3.230/24）。' })
            return
          }
          if (nic6Mode === 'static' && !nic6Ip.trim()) {
            setToast({ bad: true, text: '静态 IPv6 要给地址（带前缀，例如 2408:8207::5/64）。' })
            return
          }
          if (nicMac.trim() && !MAC_RE.test(nicMac.trim())) {
            setToast({ bad: true, text: 'MAC 格式不对：要 6 组两位十六进制，例如 00:16:3e:8a:1c:44。' })
            return
          }
          nics = nicsFromForm()
        }
        if (!Array.isArray(nics) || nics.length === 0) {
          setToast({ bad: true, text: '至少要有一块网卡。' })
          return
        }
        setBusy(true)
        try {
          const result = await jpost(`/containers/${encodeURIComponent(container.nodeId)}/${encodeURIComponent(container.name)}/network`, { nics, restart: true })
          setToast(result && result.status === 'pending'
            ? '已挂起，去下面「待确认」点确认；确认后会重启容器。'
            : '已保存。' + macSwapText(result && result.swaps))
        } catch (e) {
          setToast({ bad: true, text: e.message })
        } finally {
          setBusy(false)
        }
      }

      // 返回值里 helper 会说清楚哪些立即生效、哪些要重启，别自己编。
      function describeSave(result, liveText) {
        const parts = [liveText]
        if (result && result.hostnameLive === false) {
          parts.push('运行中的主机名没改成功（容器里可能没有 hostname 命令），重启后按 config 生效')
        }
        const need = Array.isArray(result && result.restartRequired) ? result.restartRequired : []
        if (need.length > 0) parts.push(need.join(' / ') + ' 要重启容器才生效')
        return parts.join('；')
      }

      // 基本与安全：写进 config，主机名会顺手在跑着的容器里也改掉。
      async function saveBasics() {
        setSettingsBusy(true)
        setSettingsToast(null)
        try {
          const result = await jpost(base + '/resources', {
            hostname: hostnameText.trim(),
            autostart: autostartOn,
            startOrder: startOrderText.trim(),
            startDelay: startDelayText.trim(),
            initCmd: initCmdText.trim(),
            capDrop: capDropText.trim(),
          })
          setSettingsToast({ text: describeSave(result, result && result.live ? '已保存并生效' : '已写进 config') })
          const fresh = await jget(base).catch(() => null)
          if (fresh) applyResourceState(fresh)
        } catch (e) {
          setSettingsToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setSettingsBusy(false)
        }
      }

      // 资源走同一个接口：不挂起、直接写 cgroup，容器在跑就当场生效。
      async function saveResources() {
        setResourceBusy(true)
        setResourceToast(null)
        try {
          const result = await jpost(base + '/resources', {
            cores: coresText.trim(),
            cpuQuota: cpuQuotaText.trim(),
            cpuWeight: cpuWeightText.trim(),
            memory: memoryText.trim(),
            memoryHigh: memoryHighText.trim(),
            swap: swapText.trim(),
            oomGroup: oomGroupOn,
            pids: pidsText.trim(),
            ioWeight: ioWeightText.trim(),
          })
          setResourceToast({
            text: describeSave(result, result && result.live
              ? '已立即生效：cgroup 改了，config 也写好了（下次开机还是这个值）'
              : '已写进 config。容器没在运行，下次启动生效'),
          })
          const fresh = await jget(base).catch(() => null)
          if (fresh) applyResourceState(fresh)
        } catch (e) {
          setResourceToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setResourceBusy(false)
        }
      }

      const linkChoices = bridgeList.length > 0
        ? bridgeList
        : [{ name: 'lxcbr0' }]

      /**
       * 在表单与原始 JSON 之间切换，两个方向都要把值带过去 ——
       * 否则切过去看到的是加载时的旧快照，改完再保存等于什么都没改。
       */
      function toggleRawMode() {
        if (!nicRawMode) {
          // 表单 → JSON：用当前表单值生成，不是那份加载时的 nicText
          setNicText(JSON.stringify(nicsFromForm(), null, 2))
          setNicRawMode(true)
          return
        }
        let parsed
        try {
          parsed = JSON.parse(nicText)
        } catch (e) {
          setToast({ bad: true, text: 'JSON 解析失败，先改好再收起来：' + (e && e.message ? e.message : e) })
          return
        }
        const first = Array.isArray(parsed) ? parsed[0] : null
        if (!first || typeof first !== 'object') {
          setToast({ bad: true, text: 'JSON 得是一个非空数组，第一项是网卡对象。' })
          return
        }
        const mac = String(first.hwaddr || '').trim()
        if (mac && !MAC_RE.test(mac)) {
          setToast({ bad: true, text: 'JSON 里的 hwaddr 格式不对：' + mac })
          return
        }
        applyNicToForm(first)
        setNicRawMode(false)
      }

      // 原始模式下整块表单置灰：两种模式只有一个生效，界面上就别让人以为改了这个也算。
      const nicForm = h('fieldset', {
        'data-cm-form': '',
        disabled: nicRawMode,
        style: { border: 'none', margin: 0, padding: 0, minWidth: 0, opacity: nicRawMode ? 0.45 : 1 },
      },
        sec('网络'),
        field('网桥', h('select', { 'data-cm-select': '', value: nicLink, onChange: e => setNicLink(e.target.value) },
          ...linkChoices.map(item => h('option', { key: item.name, value: item.name }, item.name + (item.address ? '（' + item.address + '）' : ''))))),
        field('MAC 地址', h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            'data-cm-input': '',
            value: nicMac,
            placeholder: '00:16:3e:8a:1c:44',
            spellCheck: false,
            style: { flex: '1', minWidth: '0', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', ...(nicMac.trim() && !MAC_RE.test(nicMac.trim()) ? { borderColor: 'var(--cm-danger)' } : {}) },
            onChange: e => { setNicMac(e.target.value); setNicMacAuto(false) },
          }),
          h('button', {
            'data-cm-btn': '',
            type: 'button',
            onClick: () => { setNicMac(randomMac()); setNicMacAuto(true) },
          }, '随机'))),
        !nicHadMac && !nicMac.trim()
          ? fieldWide('', h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
            '这台建的时候没写 hwaddr，MAC 由内核随机生成 —— 容器每重启一次就可能变。填上并保存就固定了。'))
          : null,
        field('IPv4', h('select', { 'data-cm-select': '', value: nicIpMode, onChange: e => setNicIpMode(e.target.value) },
          h('option', { value: 'dhcp' }, 'DHCP'),
          h('option', { value: 'static' }, '静态'))),
        nicIpMode === 'static'
          ? field('IPv4 地址', h('input', { 'data-cm-input': '', value: nicIp, placeholder: '10.0.3.230/24', onChange: e => setNicIp(e.target.value) }))
          : null,
        nicIpMode === 'static'
          ? field('IPv4 网关', h('input', { 'data-cm-input': '', value: nicGw, placeholder: '10.0.3.1，可留空', onChange: e => setNicGw(e.target.value) }))
          : null,
        field('IPv6', h('select', { 'data-cm-select': '', value: nic6Mode, onChange: e => setNic6Mode(e.target.value) },
          h('option', { value: 'off' }, '关闭'),
          h('option', { value: 'dhcp' }, 'DHCPv6'),
          h('option', { value: 'static' }, '静态'))),
        nic6Mode === 'dhcp'
          ? fieldWide('', h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
            'DHCPv6 靠容器里的客户端与宿主的 RA / DHCPv6 服务拿地址，插件不写死配置。'))
          : null,
        nic6Mode === 'static'
          ? field('IPv6 地址', h('input', { 'data-cm-input': '', value: nic6Ip, placeholder: '2408:8207::5/64', onChange: e => setNic6Ip(e.target.value) }))
          : null,
        nic6Mode === 'static'
          ? field('IPv6 网关', h('input', { 'data-cm-input': '', value: nic6Gw, placeholder: 'fe80::1，可留空', onChange: e => setNic6Gw(e.target.value) }))
          : null,
        sec('高级'),
        fieldWide('', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', { 'data-cm-btn': '', type: 'button', onClick: toggleRawMode },
            nicRawMode ? '收起原始 JSON' : '直接编辑原始 JSON'),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
            nicRawMode
              ? '当前以原始 JSON 为准，上面的字段不参与保存。'
              : '多网卡、macvlan、mtu 这些只能在这里改；切换时会把表单里的值带过去。'))),
        nicRawMode
          ? fieldWide('网卡数组（JSON）', h('textarea', {
            'data-cm-input': '',
            style: { width: '100%', minHeight: '180px', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 'var(--cm-f-sm)', whiteSpace: 'pre' },
            value: nicText,
            onChange: event => setNicText(event.target.value),
          }))
          : null)

      return h('div', null,
        h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '网络与地址'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
          '保存后先挂起，确认时写进 /var/lib/lxc/<名字>/config（自动备份）并重启容器生效。'),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        nicForm,
        h('div', { 'data-cm-actions': '' },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: save }, busy ? '保存中…' : '保存（会挂起）')),
        toast ? h('div', { 'data-cm-toast': '', ...(toast.bad ? { 'data-bad': '' } : {}) }, toast.text) : null,
      ),
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '基本与安全'),
          h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
            '写进 /var/lib/lxc/<名字>/config（写前自动备份）。主机名会顺手在运行中的容器里也改掉；',
            'capabilities、init 命令、启动顺序是启动那一刻才读的，改完要重启容器。'),
          h('div', { 'data-cm-form': '' },
            field('主机名', h('input', {
              'data-cm-input': '',
              value: hostnameText,
              placeholder: '留空 = 用容器名',
              onChange: e => setHostnameText(e.target.value),
            })),
            field('开机自启', h('select', { 'data-cm-select': '', value: autostartOn ? '1' : '0', onChange: e => setAutostartOn(e.target.value === '1') },
              h('option', { value: '0' }, '不开'),
              h('option', { value: '1' }, '开'))),
            field('启动顺序', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '0',
              value: startOrderText,
              placeholder: '越大越后启动，留空 = 默认',
              onChange: e => setStartOrderText(e.target.value),
            })),
            field('启动延迟（秒）', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '0',
              value: startDelayText,
              placeholder: '等几秒再起，留空 = 0',
              onChange: e => setStartDelayText(e.target.value),
            }))),
          h('div', { 'data-cm-form': '', style: { marginTop: '8px' } },
            fieldWide('init 命令', h('input', {
              'data-cm-input': '',
              value: initCmdText,
              placeholder: '留空 = 发行版默认 init（例如 /sbin/init；填 /bin/sh 就是直接进 shell）',
              onChange: e => setInitCmdText(e.target.value),
            })),
            fieldWide('丢弃的 capabilities', h('input', {
              'data-cm-input': '',
              value: capDropText,
              placeholder: '空格分隔，例如 sys_module mac_admin mac_override；留空 = 不丢弃',
              onChange: e => setCapDropText(e.target.value),
            }))),
          h('div', { 'data-cm-actions': '' },
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: settingsBusy, onClick: saveBasics }, settingsBusy ? '提交中…' : '保存')),
          settingsToast
            ? h('div', { ...(settingsToast.bad ? { 'data-cm-warn': '' } : { 'data-cm-dim': '' }), style: { marginTop: '6px' } }, settingsToast.text)
            : null),
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '资源（CPU / 内存 / 进程 / IO）'),
          h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
            '点「立即生效」就写进 cgroup，容器在跑也不用重启；同一份值会写回 config，下次开机照旧。留空 = 不限（权重留空 = 内核默认 100）。'),
          h('div', { 'data-cm-form': '' },
            field('CPU 绑核', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '1',
              value: coresText,
              placeholder: '核心数，例如 4，留空 = 不绑核',
              onChange: e => setCoresText(e.target.value),
            })),
            field('CPU 配额（核）', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '0',
              step: '0.1',
              value: cpuQuotaText,
              placeholder: '1.5 = 一个半核，留空 = 不限',
              onChange: e => setCpuQuotaText(e.target.value),
            })),
            field('CPU 权重', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '1',
              max: '10000',
              value: cpuWeightText,
              placeholder: '1..10000，默认 100',
              onChange: e => setCpuWeightText(e.target.value),
            })),
            field('内存上限', h('input', { 'data-cm-input': '', value: memoryText, placeholder: '512m，留空 = 不限', onChange: e => setMemoryText(e.target.value) })),
            field('内存软限', h('input', { 'data-cm-input': '', value: memoryHighText, placeholder: '超过先回收、不直接 OOM，留空 = 不限', onChange: e => setMemoryHighText(e.target.value) })),
            field('swap 上限', h('input', { 'data-cm-input': '', value: swapText, placeholder: '512m，留空 = 不限', onChange: e => setSwapText(e.target.value) })),
            field('PID 上限', h('input', { 'data-cm-input': '', value: pidsText, placeholder: '例如 512，留空 = 不限', onChange: e => setPidsText(e.target.value) })),
            field('IO 权重', h('input', {
              'data-cm-input': '',
              type: 'number',
              min: '1',
              max: '10000',
              value: ioWeightText,
              placeholder: '1..10000，默认 100',
              onChange: e => setIoWeightText(e.target.value),
            }))),
          h('div', { 'data-cm-form': '', style: { marginTop: '8px' } },
            field('内存耗尽时', h('select', { 'data-cm-select': '', value: oomGroupOn ? '1' : '0', onChange: e => setOomGroupOn(e.target.value === '1') },
              h('option', { value: '0' }, '只杀一个进程'),
              h('option', { value: '1' }, '整组一起终止（oom.group）')))),
          h('div', { 'data-cm-actions': '' },
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: resourceBusy, onClick: saveResources }, resourceBusy ? '应用中…' : '立即生效')),
          liveInfo
            ? h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { marginTop: '6px', fontSize: 'var(--cm-f-xs)', lineHeight: '1.7' } },
              'cgroup 实时值：cpuset=' + (liveInfo.cpuset || '不限')
              + '，cpu.max=' + (cpuQuotaFromMax(liveInfo.cpuMax) ? cpuQuotaFromMax(liveInfo.cpuMax) + ' 核' : '不限')
              + '，cpu.weight=' + (liveInfo.cpuWeight || '—')
              + '，memory.max=' + (liveInfo.memoryMax === 'max' ? '不限' : (humanBytes(liveInfo.memoryMax) || '—'))
              + (liveInfo.memoryCurrent ? '（已用 ' + humanBytes(liveInfo.memoryCurrent) + '）' : '')
              + '，swap.max=' + (liveInfo.swapMax === 'max' ? '不限' : (humanBytes(liveInfo.swapMax) || '—'))
              + '，pids=' + (liveInfo.pidsCurrent || '—') + '/' + (liveInfo.pidsMax === 'max' ? '不限' : (liveInfo.pidsMax || '—'))
              + '，io.weight=' + (ioWeightValue(liveInfo.ioWeight) || '—'))
            : null,
          resourceToast
            ? h('div', { ...(resourceToast.bad ? { 'data-cm-warn': '' } : { 'data-cm-dim': '' }), style: { marginTop: '6px' } }, resourceToast.text)
            : null),
      )
    }

    /* ───────────────────────── 新建容器 ───────────────────────── */

    // 端口 / 环境变量 / 挂载用「一行一条」的文本域，比一排加号按钮省事，也跟 docker/podman 的写法一致。
    // 解析失败在前端就报，后端仍会自己再校验一遍（不信任前端）。
    function parsePortLines(text) {
      const out = []
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const slash = line.split('/')
        const left = slash[0]
        const protocol = String(slash[1] || 'tcp').trim().toLowerCase()
        if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('端口协议只支持 tcp/udp：' + line)
        const parts = String(left).split(':').map(part => part.trim())
        const port = { containerPort: 0, protocol }
        if (parts.length === 1) {
          port.containerPort = Number(parts[0])
        } else if (parts.length === 2) {
          port.hostPort = Number(parts[0])
          port.containerPort = Number(parts[1])
        } else if (parts.length === 3) {
          port.hostIp = parts[0]
          port.hostPort = Number(parts[1])
          port.containerPort = Number(parts[2])
        } else {
          throw new Error('端口行看不懂：' + line + '（写成 8080:80 或 8080:80/udp）')
        }
        if (!Number.isInteger(port.containerPort) || port.containerPort <= 0) throw new Error('容器端口看不懂：' + line)
        if (port.hostPort !== undefined && (!Number.isInteger(port.hostPort) || port.hostPort <= 0)) throw new Error('宿主端口看不懂：' + line)
        out.push(port)
      }
      return out
    }

    function parseEnvLines(text) {
      const out = {}
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const index = line.indexOf('=')
        if (index <= 0) throw new Error('环境变量要写成 KEY=VALUE：' + line)
        out[line.slice(0, index).trim()] = line.slice(index + 1)
      }
      return out
    }

    function parseVolumeLines(text) {
      const out = []
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const parts = line.split(':')
        if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('挂载要写成 /宿主:/容器[:ro]：' + line)
        const volume = { source: parts[0], destination: parts[1] }
        if (parts.length > 2 && String(parts[2]).trim() === 'ro') volume.ro = true
        out.push(volume)
      }
      return out
    }

    function fieldWide(label, input) {
      return h('div', { 'data-cm-field': '', style: { gridColumn: '1 / -1' } }, h('label', null, label), input)
    }

    /** 表单里的分区小标题（grid 里独占整行，见 [data-cm-sec] 的 grid-column）。 */
    function sec(label) {
      return h('div', { 'data-cm-sec': '' }, label)
    }

    /**
     * 给容器网卡抽一个 MAC。前缀 00:16:3e 是 LXC / Xen 传统分给虚拟网卡的 OUI，
     * 用它就不会和真实厂商的网卡撞号；后三个字节随机。
     * 后端也会校验一遍，这里只是让表单有个说得过去的初始值。
     */
    function randomMac() {
      const tail = Array.from({ length: 3 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
      return '00:16:3e:' + tail.join(':')
    }

    const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/

/** 后端自动避让换掉的 MAC，编成一句人话；没换过就返回空串。 */
function macSwapText(swaps) {
  if (!Array.isArray(swaps) || swaps.length === 0) return ''
  return '　MAC 撞车已自动避让：' + swaps
    .map(one => (one.from + ' 归 ' + one.owner + '，换成 ' + one.to))
    .join('；') + '。'
}

    function linesBox(value, onChange, placeholder) {
      return h('textarea', {
        'data-cm-input': '',
        value,
        placeholder,
        spellCheck: false,
        style: { minHeight: '62px', resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--cm-f-sm)', lineHeight: '1.55' },
        onChange: event => onChange(event.target.value),
      })
    }

    function CreateContainerForm({ nodes, networks, bridges, defaultNodeId, draft, busy, onCreated }) {
      const d = draft || {}
      const [nodeId, setNodeId] = React.useState(d.nodeId || defaultNodeId || (nodes[0] ? nodes[0].id : ''))
      const node = nodes.find(item => item.id === nodeId) || nodes[0] || null
      const isLxc = Boolean(node && node.kind === 'lxc')

      const [name, setName] = React.useState(d.name || '')
      const [image, setImage] = React.useState(d.image || 'docker.io/library/alpine:latest')
      const [network, setNetwork] = React.useState(d.network || '')
      const [portsText, setPortsText] = React.useState(d.portsText || '')
      const [envText, setEnvText] = React.useState(d.envText || '')
      const [volumesText, setVolumesText] = React.useState(d.volumesText || '')
      const [commandText, setCommandText] = React.useState(d.commandText || '')
      const [restart, setRestart] = React.useState(d.restart || 'no')
      const [memory, setMemory] = React.useState(d.memory || '')
      const [cpus, setCpus] = React.useState(d.cpus || '')
      // LXC 的两个额外旋钮：绑核数与 swap 上限。Podman 侧用不到，共用状态无害。
      const [lxcCores, setLxcCores] = React.useState(d.cores || '')
      const [lxcSwap, setLxcSwap] = React.useState(d.swap || '')

      const [distro, setDistro] = React.useState(d.distro || 'alpine')
      const [release, setRelease] = React.useState(d.release || '3.22')
      const [arch, setArch] = React.useState(d.arch || 'arm64')
      // 候选列表不是白名单（白名单是后端的正则），选「其他」就切回手填。
      const [manualDistro, setManualDistro] = React.useState(false)
      const [manualRelease, setManualRelease] = React.useState(false)
      // 网桥列表是宿主实时扫出来的（lxcbr0 / br0 / …）。
      // LXC 默认就该走 NAT 那一套；br0 是用户自己搭的主网段桥，不替他选。
      const bridgeList = Array.isArray(bridges) ? bridges : []
      const hasNatBridge = bridgeList.some(item => item.name === 'lxcbr0')
      const defaultBridge = 'lxcbr0'
      const [lxcNet, setLxcNet] = React.useState(d.lxcNet || defaultBridge)
      const [ipMode, setIpMode] = React.useState(d.ipMode || 'dhcp')
      const [diskSize, setDiskSize] = React.useState(d.diskSize || '8G')
      // rootfs 后端：loop 是默认（一块 img，能限大小），dir 是宿主目录（文件面板直接能读、不占 loop 设备）
      const [backend, setBackend] = React.useState(d.backend || 'loop')
      const [dataDisks, setDataDisks] = React.useState(Array.isArray(d.dataDisks) ? d.dataDisks : [])
      const [ipAddress, setIpAddress] = React.useState(d.ipAddress || '')
      const [ipGateway, setIpGateway] = React.useState(d.ipGateway || '')
      // IPv6 三态：off（默认）/ dhcp / static。off 与 dhcp 都不写 LXC 配置。
      const [ip6Mode, setIp6Mode] = React.useState(d.ip6Mode || 'off')
      const [ip6Address, setIp6Address] = React.useState(d.ip6Address || '')
      const [ip6Gateway, setIp6Gateway] = React.useState(d.ip6Gateway || '')
      // 进表单就把 MAC 抽好：留空交给内核随机的话，每次启动 MAC 都会变，
      // DHCP 保留地址和按 MAC 写的防火墙规则就全废了。
      const [lxcMac, setLxcMac] = React.useState(d.lxcMac || randomMac())
  // 这个 MAC 是我们随手给的，还是用户自己定的？只影响「撞车时换不换」。
  const [lxcMacAuto, setLxcMacAuto] = React.useState(!d.lxcMac)
      const [start, setStart] = React.useState(d.start !== false)
      const [autostart, setAutostart] = React.useState(d.autostart === true)

      const [images, setImages] = React.useState([])
      const [suggestions, setSuggestions] = React.useState([])
      const [error, setError] = React.useState(null)
      const [working, setWorking] = React.useState(false)
      const [stage, setStage] = React.useState('')

      const nodeKey = node ? node.id : ''
      React.useEffect(() => {
        if (!nodeKey) return
        // Podman 节点返回数组；LXC 节点返回 { images, count, total, root }（系统镜像缓存）。
        jget('/images?node=' + encodeURIComponent(nodeKey))
          .then(data => setImages(Array.isArray(data) ? data : (data && Array.isArray(data.images) ? data.images : [])))
          .catch(() => setImages([]))
        jget('/lxc/templates').then(data => setSuggestions(data && Array.isArray(data.suggestions) ? data.suggestions : [])).catch(() => setSuggestions([]))
      }, [nodeKey])

      const releasesFor = current => {
        const found = suggestions.find(item => item.distro === current)
        return found && Array.isArray(found.releases) ? found.releases : []
      }

      /**
       * 候选 + 当前值去重。当前值是手填的、不在候选里时也放进选项，
       * 否则 select 会显示空白（浏览器找不到匹配项就退化成第一项或空）。
       */
      const optionsWith = (current, list) => {
        const all = Array.isArray(list) ? list.slice() : []
        if (current && !all.includes(current)) all.unshift(current)
        return all
      }

      /** 数据盘列表里改某一行的字段。 */
      const patchDisk = (index, patch) => setDataDisks(list => list.map((item, at) => (at === index ? { ...item, ...patch } : item)))

      function pickDistro(next) {
        setDistro(next)
        const releases = releasesFor(next)
        if (releases.length > 0) setRelease(releases[0])
      }

      async function submit() {
        if (!node) { setError('没有可用节点。'); return }
        setWorking(true)
        setError(null)
        setStage(isLxc ? '下载 rootfs 并创建…（可能要几分钟）' : '拉镜像并创建…')
        try {
          let body
          if (isLxc) {
            body = {
              node: node.id,
              name: name.trim(),
              distro: distro.trim(),
              release: release.trim(),
              arch,
              start,
              autostart,
              backend,
              ...(backend === 'loop' ? { diskSize: diskSize.trim() || '8G' } : {}),
              ...(dataDisks.filter(item => String(item.mount || '').trim()).length > 0
                ? {
                  dataDisks: dataDisks
                    .filter(item => String(item.mount || '').trim())
                    .map(item => ({
                      size: String(item.size || '').trim() || '8G',
                      mount: String(item.mount || '').trim(),
                    })),
                }
                : {}),
              ...(memory.trim() ? { memoryMax: memory.trim() } : {}),
              ...(lxcSwap.trim() ? { swapMax: lxcSwap.trim() } : {}),
              ...(lxcCores.trim() ? { cores: lxcCores.trim() } : {}),
              ...(lxcNet === 'none'
                ? { network: 'none' }
                : {
                  network: {
                    type: 'veth',
                    link: lxcNet,
                    hwaddr: lxcMac.trim() || undefined,
        hwaddrAuto: lxcMacAuto,
                    ipv4: ipMode === 'static'
                      ? { mode: 'static', address: ipAddress.trim(), gateway: ipGateway.trim() }
                      : { mode: 'dhcp' },
                    ipv6: ip6Mode === 'static'
                      ? { mode: 'static', address: ip6Address.trim(), gateway: ip6Gateway.trim() }
                      : { mode: ip6Mode },
                  },
                }),
            }
          } else {
            body = {
              node: node.id,
              image: image.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(network ? { network } : {}),
              ...(portsText.trim() ? { ports: parsePortLines(portsText) } : {}),
              ...(envText.trim() ? { env: parseEnvLines(envText) } : {}),
              ...(volumesText.trim() ? { volumes: parseVolumeLines(volumesText) } : {}),
              ...(commandText.trim() ? { command: commandText.trim().split(/\s+/) } : {}),
              ...(restart !== 'no' ? { restart } : {}),
              ...(memory.trim() ? { memory: memory.trim() } : {}),
              ...(cpus.trim() ? { cpus: cpus.trim() } : {}),
            }
          }
          const data = await jpost('/containers', body)
          onCreated(data)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setWorking(false)
          setStage('')
        }
      }

      const nodeOptions = nodes.map(item => h('option', { key: item.id, value: item.id }, item.label + '（' + item.kind + '）'))
      const nodeSelect = h('div', { 'data-cm-form': '' },
        field('节点', h('select', { 'data-cm-select': '', value: nodeId, onChange: e => setNodeId(e.target.value) }, ...nodeOptions)))

      const podmanFields = h('div', { 'data-cm-form': '' },
        h('datalist', { id: 'cm-image-list' }, ...images.map(item => h('option', { key: item.reference, value: item.reference }))),
        sec('基本信息'),
        field('镜像', h('input', { 'data-cm-input': '', value: image, list: 'cm-image-list', spellCheck: false, onChange: e => setImage(e.target.value) })),
        field('名字（可选）', h('input', { 'data-cm-input': '', value: name, placeholder: '留空用随机名', onChange: e => setName(e.target.value) })),
        field('网络', h('select', { 'data-cm-select': '', value: network, onChange: e => setNetwork(e.target.value) },
          h('option', { value: '' }, 'podman（默认）'),
          ...networks.filter(item => !node || item.nodeId === node.id).map(item => h('option', { key: item.nodeId + '/' + item.name, value: item.name }, item.name + (item.subnet ? ' · ' + item.subnet : ''))))),
        field('重启策略', h('select', { 'data-cm-select': '', value: restart, onChange: e => setRestart(e.target.value) },
          ...['no', 'on-failure', 'always', 'unless-stopped'].map(value => h('option', { key: value, value }, value)))),
        sec('资源'),
        field('内存上限', h('input', { 'data-cm-input': '', value: memory, placeholder: '256m / 1g，留空不限', onChange: e => setMemory(e.target.value) })),
        field('CPU 上限', h('input', { 'data-cm-input': '', value: cpus, placeholder: '1.5，留空不限', onChange: e => setCpus(e.target.value) })),
        sec('端口与挂载'),
        fieldWide('端口（一行一条）', linesBox(portsText, setPortsText, '8080:80\n8443:443/udp')),
        fieldWide('环境变量（一行一条）', linesBox(envText, setEnvText, 'TZ=Asia/Shanghai\nLANG=C.UTF-8')),
        fieldWide('挂载（一行一条）', linesBox(volumesText, setVolumesText, '/srv/data:/data\n/home/x:/x:ro')),
        fieldWide('启动命令（可选）', h('input', { 'data-cm-input': '', value: commandText, placeholder: '留空用镜像自带的', spellCheck: false, onChange: e => setCommandText(e.target.value) })))

      // 发行版 / 版本以前是 input + datalist —— 浏览器点输入框不会展开选项，看着像下拉坏了。
      // 换成原生 select（和架构、网桥同一套），另留「其他（手填）」保住手填的口子。
      const CUSTOM = '__custom__'
      const distroChoices = optionsWith(distro, suggestions.map(item => item.distro))
      const releaseChoices = optionsWith(release, releasesFor(distro))
      // 手填模式下给个「候选」小按钮退回下拉，不然进去就出不来。
      const manualRow = (value, onInput, back) => h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('input', { 'data-cm-input': '', value, style: { flex: '1', minWidth: '0' }, onChange: e => onInput(e.target.value.trim()) }),
        h('button', { 'data-cm-btn': '', onClick: back }, '候选'))

      const lxcFields = h('div', { 'data-cm-form': '' },
        sec('基本信息'),
        field('名字', h('input', { 'data-cm-input': '', value: name, placeholder: '例如 web-01', onChange: e => setName(e.target.value) })),
        field('发行版', manualDistro
          ? manualRow(distro, pickDistro, () => setManualDistro(false))
          : h('select', {
            'data-cm-select': '',
            value: distro,
            onChange: e => {
              const next = e.target.value
              if (next === CUSTOM) { setManualDistro(true); return }
              pickDistro(next)
            },
          }, ...distroChoices.map(value => h('option', { key: value, value }, value)),
            h('option', { key: CUSTOM, value: CUSTOM }, '其他（手填）'))),
        field('版本', manualRelease
          ? manualRow(release, setRelease, () => setManualRelease(false))
          : h('select', {
            'data-cm-select': '',
            value: release,
            onChange: e => {
              const next = e.target.value
              if (next === CUSTOM) { setManualRelease(true); return }
              setRelease(next)
            },
          }, ...releaseChoices.map(value => h('option', { key: value, value }, value)),
            h('option', { key: CUSTOM, value: CUSTOM }, '其他（手填）'))),
        field('架构', h('select', { 'data-cm-select': '', value: arch, onChange: e => setArch(e.target.value) },
          ...['arm64', 'amd64'].map(value => h('option', { key: value, value }, value)))),
        sec('网络'),
        field('网桥', h('select', { 'data-cm-select': '', value: lxcNet, onChange: e => setLxcNet(e.target.value) },
          // 选项只写「接口名（地址）」，不挂任何说明后缀 —— 描述一律放在下面的提示行里。
          // NAT 那一套永远排第一；宿主没启用也留这一项，否则默认值选不中。
          ...(hasNatBridge
            ? bridgeList.filter(item => item.name === 'lxcbr0').map(item => h('option', { key: item.name, value: item.name },
              item.name + (item.address ? '（' + item.address + '）' : '')))
            : [h('option', { key: 'lxcbr0', value: 'lxcbr0' }, 'lxcbr0')]),
          // 其余的桥（br0 这类）照样可选，只是排在后面。
          ...bridgeList.filter(item => item.name !== 'lxcbr0').map(item => h('option', { key: item.name, value: item.name },
            item.name + (item.address ? '（' + item.address + '）' : ''))),
          h('option', { key: 'none', value: 'none' }, '不接网络'))),
        bridgeList.length > 0 && lxcNet !== 'lxcbr0' && lxcNet !== 'none'
          ? fieldWide('', h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
            '挂 ' + lxcNet + ' 意味着容器直接进这个网段，和宿主同级；要 DHCP 才拿得到地址。'))
          : null,
        lxcNet === 'none'
          ? null
          : fieldWide('MAC 地址', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              'data-cm-input': '',
              value: lxcMac,
              spellCheck: false,
              style: { flex: '0 0 200px', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', ...(MAC_RE.test(lxcMac.trim()) ? {} : { borderColor: 'var(--cm-danger)' }) },
              onChange: e => { setLxcMac(e.target.value); setLxcMacAuto(false) },
            }),
            h('button', {
              'data-cm-btn': '',
              type: 'button',
              onClick: () => { setLxcMac(randomMac()); setLxcMacAuto(true) },
            }, '随机换一个'),
            h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
              MAC_RE.test(lxcMac.trim())
                ? (lxcMacAuto
                  ? '写死进 lxc.net.0.hwaddr —— 容器里 ip link 看到的永远是这一个。撞了会自动换一个。'
                  : '写死进 lxc.net.0.hwaddr —— 你指定的值，撞了会被拦下来，不会偷偷换掉。')
                : '格式不对：要 6 组两位十六进制，例如 00:16:3e:8a:1c:44。'))),
        // 不接网络就没有网卡，地址几栏一起藏掉（用 null，别留空 div 占位）。
        lxcNet === 'none'
          ? null
          : field('IPv4', h('select', { 'data-cm-select': '', value: ipMode, onChange: e => setIpMode(e.target.value) },
            h('option', { value: 'dhcp' }, 'DHCP'),
            h('option', { value: 'static' }, '静态'))),
        lxcNet !== 'none' && ipMode === 'static'
          ? field('IPv4 地址', h('input', { 'data-cm-input': '', value: ipAddress, placeholder: '10.0.3.200/24', onChange: e => setIpAddress(e.target.value) }))
          : null,
        lxcNet !== 'none' && ipMode === 'static'
          ? field('IPv4 网关', h('input', { 'data-cm-input': '', value: ipGateway, placeholder: '10.0.3.1，可留空', onChange: e => setIpGateway(e.target.value) }))
          : null,
        lxcNet === 'none'
          ? null
          : field('IPv6', h('select', { 'data-cm-select': '', value: ip6Mode, onChange: e => setIp6Mode(e.target.value) },
            h('option', { value: 'off' }, '关闭'),
            h('option', { value: 'dhcp' }, 'DHCPv6'),
            h('option', { value: 'static' }, '静态'))),
        lxcNet !== 'none' && ip6Mode === 'dhcp'
          ? fieldWide('', h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
            'DHCPv6 不在 LXC 配置里写死地址，靠容器内的客户端去拿 —— 宿主那边得有 RA 或 DHCPv6 服务，否则拿不到。'))
          : null,
        lxcNet !== 'none' && ip6Mode === 'static'
          ? field('IPv6 地址', h('input', { 'data-cm-input': '', value: ip6Address, placeholder: '2408:8207::5/64', onChange: e => setIp6Address(e.target.value) }))
          : null,
        lxcNet !== 'none' && ip6Mode === 'static'
          ? field('IPv6 网关', h('input', { 'data-cm-input': '', value: ip6Gateway, placeholder: 'fe80::1，可留空', onChange: e => setIp6Gateway(e.target.value) }))
          : null,
        sec('资源'),
        field('内存上限', h('input', { 'data-cm-input': '', value: memory, placeholder: '256m，留空不限', onChange: e => setMemory(e.target.value) })),
        field('swap 上限', h('input', { 'data-cm-input': '', value: lxcSwap, placeholder: '512m，留空不限', onChange: e => setLxcSwap(e.target.value) })),
        field('CPU 核心数', h('input', { 'data-cm-input': '', type: 'number', min: '1', value: lxcCores, placeholder: '例如 4，留空不绑核', onChange: e => setLxcCores(e.target.value) })),
        field('rootfs 后端', h('select', {
          'data-cm-select': '',
          value: backend,
          onChange: e => setBackend(e.target.value),
        },
        h('option', { value: 'loop' }, 'loop（一块虚拟磁盘，可限大小）'),
        h('option', { value: 'dir' }, 'dir（宿主上的目录，不占 loop 设备）'))),
        backend === 'loop'
          ? field('磁盘大小', h('input', { 'data-cm-input': '', value: diskSize, placeholder: '8G', onChange: e => setDiskSize(e.target.value) }))
          : field('磁盘大小', h('span', { 'data-cm-dim': '' }, 'dir 后端没有磁盘大小，rootfs 直接长在宿主文件系统上')),
        sec('磁盘'),
        fieldWide('额外数据盘', h('div', null,
          ...dataDisks.map((disk, index) => h('div', { key: 'cm-disk-' + index, style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
            h('input', { 'data-cm-input': '', value: disk.size || '', placeholder: '20G', style: { width: '96px' }, onChange: e => patchDisk(index, { size: e.target.value }) }),
            h('input', { 'data-cm-input': '', value: disk.mount || '', placeholder: '容器内挂载点，例如 data', style: { flex: '1' }, onChange: e => patchDisk(index, { mount: e.target.value }) }),
            h('button', { 'data-cm-btn': '', type: 'button', disabled: busy, onClick: () => setDataDisks(list => list.filter((_, at) => at !== index)) }, '×'))),
          h('button', { 'data-cm-btn': '', type: 'button', disabled: busy, onClick: () => setDataDisks(list => [...list, { size: '20G', mount: 'data' + (list.length || '') }]) }, '＋ 加一块数据盘'),
          h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '4px' } },
            backend === 'loop'
              ? 'rootfs 是 ' + (name.trim() || '<名字>') + '-0.img，数据盘按 -1、-2 往下排；都落在 /opt/dsh-container/lxc/' + (name.trim() || '<名字>') + '/。'
              : 'rootfs 是宿主上的目录 /var/lib/lxc/' + (name.trim() || '<名字>') + '/rootfs；数据盘仍然是 loop 镜像，落在 /opt/dsh-container/lxc/' + (name.trim() || '<名字>') + '/。'))),
        )

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, isLxc ? '新建 LXC 容器' : '新建 Podman 容器'),
          nodeSelect,
          isLxc ? lxcFields : podmanFields,
          isLxc ? h('div', { 'data-cm-actions': '' },
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: 'var(--cm-f-sm)' } },
              h('input', { type: 'checkbox', checked: start, onChange: e => setStart(e.target.checked) }), '创建后启动'),
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: 'var(--cm-f-sm)' } },
              h('input', { type: 'checkbox', checked: autostart, onChange: e => setAutostart(e.target.checked) }), '开机自启'),
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: working || busy, onClick: submit }, working ? (stage || '创建中…') : '创建'))
          : h('div', { 'data-cm-actions': '' },
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: working || busy, onClick: submit }, working ? (stage || '创建中…') : '创建'))),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px' } }, error) : null,
        h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
          isLxc
            ? 'LXC 要联网从 images.linuxcontainers.org 拉 rootfs，慢的话几分钟；rootless/权限问题会原样报错，不会假装成功。'
            : 'rootless Podman 绑不了 1024 以下的宿主端口；镜像名写全一点（docker.io/library/...）拉取更稳。'))
    }
    function NetworkCreateForm({ node, busy, onDone }) {
      const [name, setName] = React.useState('cm-net')
      const [driver, setDriver] = React.useState('bridge')
      const [subnet, setSubnet] = React.useState('10.99.0.0/24')
      const [gateway, setGateway] = React.useState('')
      const [internal, setInternal] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [working, setWorking] = React.useState(false)

      async function submit() {
        setWorking(true)
        try {
          const result = await jpost('/networks', {
            node: node.id,
            op: 'create',
            name,
            driver,
            ...(subnet ? { subnet } : {}),
            ...(gateway ? { gateway } : {}),
            ...(internal ? { internal: true } : {}),
          })
          setError(null)
          onDone()
          void result
        } catch (e) {
          setError(e.message)
        } finally {
          setWorking(false)
        }
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '新建网络'),
        h('div', { 'data-cm-form': '' },
          field('名字', h('input', { 'data-cm-input': '', value: name, onChange: e => setName(e.target.value) })),
          field('驱动', h('select', { 'data-cm-select': '', value: driver, onChange: e => setDriver(e.target.value) },
            ...['bridge', 'macvlan', 'ipvlan'].map(value => h('option', { key: value, value }, value)))),
          field('子网', h('input', { 'data-cm-input': '', value: subnet, onChange: e => setSubnet(e.target.value) })),
          field('网关（可选）', h('input', { 'data-cm-input': '', value: gateway, onChange: e => setGateway(e.target.value) })),
        ),
        h('div', { 'data-cm-actions': '' },
          h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: 'var(--cm-f-sm)' } },
            h('input', { type: 'checkbox', checked: internal, onChange: e => setInternal(e.target.checked) }),
            'internal（无出站）'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: working || busy, onClick: submit }, working ? '提交中…' : '创建（会挂起）')),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px' } }, error) : null,
        h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } },
          'rootless Podman 建 macvlan/ipvlan 网络需要 CAP_NET_ADMIN（宿主上要有 root 通道）；驱动一般已在内核里。失败时错误会原样显示。'),
      )
    }

    function field(label, input) {
      return h('div', { 'data-cm-field': '' }, h('label', null, label), input)
    }

    /* ───────────────────────── 图标 ───────────────────────── */

    /* ───────────────────── v0.3.0：项目视图（compose） ───────────────────── */

    const COMPOSE_REFRESH_MS = 12000
    // 顶层导航（对齐 cockpit-podman 的五段）：项目是落地页。
    /* ───────────────── Podman 的 secret（只看名字，永远没有明文） ───────────────── */

    function SecretsPane({ nodeId, onToast }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draftName, setDraftName] = React.useState('')
      const [draftValue, setDraftValue] = React.useState('')
      const [removing, setRemoving] = React.useState('')

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setData(await jget('/secrets?node=' + encodeURIComponent(nodeId)))
        } catch (err) {
          setData(null)
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [nodeId])

      React.useEffect(() => { load() }, [load])

      async function create() {
        const name = draftName.trim()
        if (!name || !draftValue) return
        setError('')
        try {
          await jpost('/secrets/create', { node: nodeId, name, value: draftValue })
          // 明文只活在这一刻：建完立刻从输入框里擦掉，不留在内存里
          setDraftName('')
          setDraftValue('')
          if (onToast) onToast('建好了 ' + name)
          load()
        } catch (err) {
          setError('建不了：' + (err && err.message ? err.message : String(err)))
        }
      }

      async function remove(name) {
        setError('')
        try {
          await jpost('/secrets/delete', { node: nodeId, name })
          setRemoving('')
          if (onToast) onToast('删掉了 ' + name)
          load()
        } catch (err) {
          setError('删不掉：' + (err && err.message ? err.message : String(err)))
        }
      }

      const items = data && Array.isArray(data.items) ? data.items : []

      return h('div', { 'data-cm-secrets': '' },
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, 'Podman secret'),
          h('div', { 'data-cm-dim': '', style: { marginTop: '4px' } },
            '值写完就再也读不回来（podman 本身不给回读），所以这里只列名字。挂到容器上用 --secret 名字。'),
          h('div', { 'data-cm-formrow': '', style: { marginTop: '10px' } },
            h('input', {
              'data-cm-input': '',
              value: draftName,
              placeholder: '名字，例如 db-password',
              onChange: event => setDraftName(event.target.value),
            }),
            h('input', {
              'data-cm-input': '',
              type: 'password',
              value: draftValue,
              placeholder: '值（只在这台浏览器里待一会）',
              onChange: event => setDraftValue(event.target.value),
            }),
            h('button', {
              'data-cm-btn': '',
              'data-primary': '',
              disabled: busy || !draftName.trim() || !draftValue,
              onClick: create,
            }, '建')),
          h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '4px' } },
            '新建只从面板走：AI 那边（container_secret）会被明确拒绝，密钥不该经过模型。')),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        h('div', { 'data-cm-card': '' },
          busy && !data ? h('div', { 'data-cm-dim': '' }, '读…') : null,
          items.length === 0 && data
            ? h('div', { 'data-cm-dim': '' }, '还没有 secret。')
            : null,
          items.map(item => h('div', { key: item.id || item.name, 'data-cm-srow': '' },
            h('div', { 'data-cm-grow': '' },
              h('div', { 'data-cm-qname': '' }, item.name),
              h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
                [item.driver, '建 ' + item.createdAt, item.updatedAt && item.updatedAt !== item.createdAt ? '改 ' + item.updatedAt : '']
                  .filter(Boolean).join(' · '))),
            removing === item.name
              ? h('span', { 'data-cm-facts': '' },
                h('button', { 'data-cm-btn': '', 'data-cm-compact': '', 'data-danger': '', onClick: () => remove(item.name) }, '真删'),
                h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: () => setRemoving('') }, '算了'))
              : h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: () => setRemoving(item.name) }, '删')))))
    }

    /* ───────────────── Quadlet（systemd 管的容器定义） ───────────────── */

    const QUADLET_SAMPLE = [
      '[Unit]',
      'Description=demo container',
      '',
      '[Container]',
      'Image=docker.io/library/alpine:3.22',
      'PublishPort=8080:80',
      'Volume=demo-data.volume:/data',
      '',
      '[Install]',
      'WantedBy=default.target',
    ].join('\n')

    function QuadletPane({ nodeId, onToast }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setData(await jget('/quadlets?node=' + encodeURIComponent(nodeId)))
        } catch (err) {
          setData(null)
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [nodeId])

      React.useEffect(() => { load() }, [load])

      async function act(op, unit) {
        setError('')
        try {
          const result = await jpost('/quadlets/' + op, { node: nodeId, unit })
          if (onToast) onToast(result && result.unit ? ('已 ' + op + ' ' + result.unit) : 'unit 已重新生成')
          load()
        } catch (err) {
          setError((err && err.message ? err.message : String(err)))
        }
      }

      if (error && !data) {
        return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, error))
      }
      if (!data) return h('div', { 'data-cm-dim': '' }, busy ? '读 quadlet 目录…' : '还没有数据。')

      const supported = data.supported === true
      const items = Array.isArray(data.items) ? data.items : []
      const dirs = Array.isArray(data.dirs) ? data.dirs : []

      const head = h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, 'Quadlet'),
        h('div', { 'data-cm-dim': '' },
          supported
            ? 'systemd 管的容器定义。改完文件要「重新生成」才生效。'
            : '这台机还用不了 Quadlet。'),
        supported
          ? h('div', { 'data-cm-facts': '', style: { marginTop: '8px', justifyContent: 'flex-start' } },
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act('reload') }, '重新生成 unit'),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: load }, busy ? '读…' : '刷新'))
          : h('div', { 'data-cm-hintbox': '', style: { marginTop: '8px' } }, data.reason || ''),
        h('div', { 'data-cm-dim': '', style: { marginTop: '6px' } }, '目录：' + dirs.join('  /  ')),
        supported
          ? null
          : h('details', { 'data-cm-dsec': '', style: { marginTop: '10px' } },
            h('summary', {}, 'Quadlet 文件长这样（Podman 4.4+ 才有生成器）'),
            h('pre', { 'data-cm-dout': '' }, QUADLET_SAMPLE)))

      if (!supported || items.length === 0) {
        return h('div', { 'data-cm-quadlet': '' },
          head,
          supported
            ? h('div', { 'data-cm-card': '' },
              h('div', { 'data-cm-dim': '' }, '这些目录里还没有 quadlet 文件。'))
            : null,
          error ? h('div', { 'data-cm-warn': '' }, error) : null)
      }

      return h('div', { 'data-cm-quadlet': '' },
        head,
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        h('div', { 'data-cm-card': '' },
          items.map(item => h('div', { key: item.path, 'data-cm-qrow': '' },
            h('span', { 'data-cm-dot': '', ...(item.state && item.state.activeState === 'active'
              ? { 'data-on': '' }
              : item.state && item.state.loadState === 'not-found' ? { 'data-bad': '' } : { 'data-off': '' }) }),
            h('div', { 'data-cm-grow': '' },
              h('div', { 'data-cm-qname': '' }, item.unit,
                h('span', { 'data-cm-dim': '', style: { marginLeft: '8px' } },
                  item.state
                    ? item.state.activeState + ' / ' + item.state.loadState
                    : '状态问不到')),
              h('div', { 'data-cm-dim': '', 'data-cm-qmeta': '' },
                [item.file, item.image || '', item.pod ? 'pod ' + item.pod : '',
                  item.publish && item.publish.length ? item.publish.join(' ') : '']
                  .filter(Boolean).join(' · '))),
            supported
              ? h('span', { 'data-cm-facts': '' },
                h('button', { 'data-cm-btn': '', 'data-cm-compact': '', disabled: busy, onClick: () => act('start', item.unit) }, '启动'),
                h('button', { 'data-cm-btn': '', 'data-cm-compact': '', disabled: busy, onClick: () => act('stop', item.unit) }, '停止'))
              : null))))
    }

    /* ───────────────── 能力体检（rootless 到底能做什么） ───────────────── */

    // Dot 只认 on / off / warn / bad 四种色（跟容器状态同一套语义）
    const CHECK_TONE = { ok: 'on', degraded: 'warn', missing: 'bad', unknown: 'off' }

    function CapabilityPane({ nodes, onToast }) {
      const usable = nodes.filter(node => node.available)
      const [nodeId, setNodeId] = React.useState(usable[0] ? usable[0].id : null)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async (refresh) => {
        if (!nodeId) return
        setBusy(true)
        setError('')
        try {
          setData(await jget('/capabilities?node=' + encodeURIComponent(nodeId) + (refresh ? '&refresh=1' : '')))
        } catch (err) {
          setData(null)
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [nodeId])

      React.useEffect(() => { load(false) }, [load])

      if (usable.length === 0) {
        return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, '没有可用的节点。'))
      }

      const checks = data && Array.isArray(data.checks) ? data.checks : []
      const counts = {}
      for (const check of checks) counts[check.state] = (counts[check.state] || 0) + 1

      function copyFix(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
            if (onToast) onToast('命令已复制')
          } else if (onToast) {
            onToast('浏览器不给剪贴板权限，手动选一下')
          }
        } catch {
          if (onToast) onToast('复制失败，手动选一下')
        }
      }

      return h('div', { 'data-cm-cap': '' },
        h('div', { 'data-cm-chipwrap': '' },
          h('div', { 'data-cm-chips': '' },
            nodes.map(node => h('button', {
              key: node.id,
              'data-cm-chip': '',
              ...(node.id === nodeId ? { 'data-on': '' } : {}),
              disabled: !node.available,
              title: node.available ? node.label : (node.reason || '这个节点不可用'),
              onClick: () => { if (node.available) setNodeId(node.id) },
            }, node.label))),
          h('button', {
            'data-cm-btn': '',
            disabled: busy || !nodeId,
            onClick: () => load(true),
          }, busy ? '探…' : '重新探测')),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        !error && !data ? h('div', { 'data-cm-dim': '' }, '探测中…') : null,
        data
          ? h('div', null,
            h('div', {
              'data-cm-card': '',
              'data-cm-capsum': '',
            },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, data.node + ' 的能力'),
            h('div', { 'data-cm-dim': '' },
              [counts.ok ? counts.ok + ' 项可用' : '', counts.degraded ? counts.degraded + ' 项受限' : '',
                counts.missing ? counts.missing + ' 项缺失' : '', counts.unknown ? counts.unknown + ' 项没探出来' : '']
                .filter(Boolean).join(' · ') || '没有可判定的项'),
            data.lxcBackends && data.lxcBackends.length
              ? h('div', { 'data-cm-dim': '' }, 'LXC 能用的存储后端：' + data.lxcBackends.join(' / '))
              : null),
            h('div', { 'data-cm-caplist': '' },
              checks.map(check => h('div', { key: check.id, 'data-cm-caprow': '' },
                h(Dot, { tone: CHECK_TONE[check.state] || 'off' }),
                h('div', { 'data-cm-grow': '' },
                  h('div', { 'data-cm-capname': '' }, check.label,
                    h('span', { 'data-cm-dim': '', style: { marginLeft: '8px' } }, check.id)),
                  h('div', { 'data-cm-dim': '', 'data-cm-capdetail': '' }, check.detail)),
                check.fix
                  ? h('button', {
                    'data-cm-btn': '',
                    'data-cm-compact': '',
                    title: check.fix,
                    onClick: () => copyFix(check.fix),
                  }, '复制修复命令')
                  : null))),
          h(AuthzCard, { onToast }))
          : null)
    }

    /* ── AI 权限：三档角色 + deny 黑名单（只有面板能改，AI 不能给自己提权） ── */

    function AuthzCard({ onToast }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          setData(await jget('/authz'))
          setError('')
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      async function pick(role) {
        setBusy(true)
        try {
          await jpost('/authz/set', { role })
          await load()
          if (onToast) onToast('AI 现在是 ' + role)
        } catch (err) {
          setError('改不了：' + (err && err.message ? err.message : String(err)))
        } finally {
          setBusy(false)
        }
      }

      if (!data) {
        return error
          ? h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, error))
          : null
      }

      const matrix = Array.isArray(data.matrix) ? data.matrix : []
      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, 'AI 权限'),
        h('div', { 'data-cm-dim': '', style: { marginTop: '4px' } },
          '这道闸门管的是 AI 能「发起」什么，不是替人省确认：危险操作永远还要你在待确认里点一下。'),
        h('div', { 'data-cm-facts': '', style: { marginTop: '8px', flexWrap: 'wrap' } },
          matrix.map(row => h('button', {
            key: row.role,
            'data-cm-btn': '',
            'data-cm-compact': '',
            ...(row.role === data.role ? { 'data-primary': '' } : {}),
            disabled: busy,
            title: row.text,
            onClick: () => pick(row.role),
          }, row.role))),
        h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '6px' } },
          (matrix.find(row => row.role === data.role) || {}).text || ''),
        data.deny && data.deny.length > 0
          ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } },
            '配置里还有 deny 名单挡着这些工具：' + data.deny.join('、'))
          : null,
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } }, error) : null)
    }

    /* ───────────────── 容器内网络排障 ───────────────── */

    function ContainerDiagnosePane({ nodeId, name, running }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [host, setHost] = React.useState('1.1.1.1')
      const [port, setPort] = React.useState('443')

      const run = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const query = '/diagnose?node=' + encodeURIComponent(nodeId) +
            '&ref=' + encodeURIComponent(name) +
            '&host=' + encodeURIComponent(host) +
            '&port=' + encodeURIComponent(port)
          setState(await jget(query))
        } catch (err) {
          setState(null)
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [nodeId, name, host, port])

      React.useEffect(() => {
        if (running) run()
        // 只在挂上 / 容器名变化时自动跑一次；host / port 改了要点按钮，别每敲一个字就进容器。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [running, nodeId, name])

      if (!running) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-hintbox': '' },
            '容器没在运行。诊断要进容器里跑 ip / getent / nc，起它一下再来。'))
      }

      const notes = state && Array.isArray(state.notes) ? state.notes : []
      const sections = state && Array.isArray(state.sections) ? state.sections : []

      return h('div', { 'data-cm-diag': '' },
        h('div', { 'data-cm-fhead': '' },
          h('span', { 'data-cm-dim': '' }, '目标'),
          h('input', {
            'data-cm-input': '',
            'data-cm-diaghost': '',
            value: host,
            onChange: event => setHost(event.target.value),
            placeholder: '1.1.1.1',
          }),
          h('input', {
            'data-cm-input': '',
            'data-cm-diagport': '',
            value: port,
            onChange: event => setPort(event.target.value),
            placeholder: '443',
          }),
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: run }, busy ? '跑…' : '跑一遍')),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        notes.length
          ? h('div', { 'data-cm-dnotes': '' },
            notes.map((note, index) => h('div', {
              key: 'note-' + index,
              'data-cm-dnote': '',
              'data-level': note.level,
            }, note.text)))
          : null,
        sections.length
          ? h('div', { 'data-cm-dsecs': '' },
            sections.map(section => h('details', {
              key: section.id,
              'data-cm-dsec': '',
              open: section.id === 'routes' || undefined,
            },
            h('summary', {}, section.label),
            h('pre', { 'data-cm-dout': '' }, section.text || '（没有输出）'))))
          : (busy ? h('div', { 'data-cm-dim': '' }, '进容器跑诊断…') : h('div', { 'data-cm-dim': '' }, '还没有结果。')),
      )
    }

    /* ───────────────── 容器内文件（浏览 / 编辑 / 上传下载） ───────────────── */

    const FILE_VIEW_LIMIT = 8 * 1024 * 1024

    function fileParentOf(path) {
      if (!path || path === '/') return '/'
      const cut = String(path).lastIndexOf('/')
      return cut <= 0 ? '/' : String(path).slice(0, cut)
    }

    /** 二进制文件下载：base64 → Blob，走 a[download]。 */
    function downloadBytes(name, base64) {
      try {
        const binary = atob(String(base64 ?? ''))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
        const link = document.createElement('a')
        link.href = url
        link.download = name || 'download.bin'
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 4000)
      } catch { /* 浏览器不让下载就算了，文件还在容器里 */ }
    }

    function ContainerFilesPane({ nodeId, name, nodeKind, running, onToast }) {
      const lxc = nodeKind === 'lxc'
      const [path, setPath] = React.useState('/')
      const [dir, setDir] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [newDir, setNewDir] = React.useState('')
      const [removing, setRemoving] = React.useState('')
      const [uploading, setUploading] = React.useState(false)
      const query = '?node=' + encodeURIComponent(nodeId) + '&ref=' + encodeURIComponent(name)

      const load = React.useCallback(async target => {
        setBusy(true)
        setError('')
        try {
          setDir(await jget('/files' + query + '&path=' + encodeURIComponent(target)))
        } catch (err) {
          setDir(null)
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [query])

      React.useEffect(() => { load('/') }, [load])

      function goTo(target) {
        setOpen(null)
        setDraft('')
        setPath(target)
        load(target)
      }

      function join(dirPath, name) {
        return (dirPath === '/' ? '' : dirPath) + '/' + name
      }

      async function openEntry(entry) {
        const target = join(path, entry.name)
        if (entry.type === 'dir') {
          goTo(target)
          return
        }
        if (entry.size > FILE_VIEW_LIMIT) {
          setError('这个文件 ' + sizeText(entry.size) + '，超过 8MB，不在面板里打开。用「终端」看它。')
          return
        }
        setBusy(true)
        setError('')
        try {
          const read = await jget('/files/read' + query + '&path=' + encodeURIComponent(target))
          setOpen({ ...read, original: read.text == null ? '' : read.text })
          setDraft(read.text == null ? '' : read.text)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      async function save() {
        if (!open || open.binary) return
        setSaving(true)
        setError('')
        try {
          await jpost('/files/write', { node: nodeId, ref: name, path: open.path, text: draft })
          setOpen({ ...open, original: draft, size: draft.length })
          if (onToast) onToast('已写入 ' + open.path)
          load(path)
        } catch (err) {
          setError('写不进去：' + (err && err.message ? err.message : String(err)))
        } finally {
          setSaving(false)
        }
      }

      async function makeDir() {
        const dirName = newDir.trim()
        if (!dirName) return
        setError('')
        try {
          await jpost('/files/mkdir', { node: nodeId, ref: name, path: join(path, dirName) })
          setNewDir('')
          if (onToast) onToast('建好了 ' + join(path, dirName))
          load(path)
        } catch (err) {
          setError('建不了：' + (err && err.message ? err.message : String(err)))
        }
      }

      async function removeEntry(entryName) {
        setError('')
        try {
          await jpost('/files/remove', { node: nodeId, ref: name, path: join(path, entryName) })
          setRemoving('')
          if (onToast) onToast('删掉了 ' + join(path, entryName))
          load(path)
        } catch (err) {
          setError('删不掉：' + (err && err.message ? err.message : String(err)))
        }
      }

      function onUpload(event) {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (file.size > FILE_VIEW_LIMIT) {
          setError('这个文件 ' + sizeText(file.size) + '，超过 8MB，传不上去。用「终端」里的工具传大文件。')
          return
        }
        setUploading(true)
        setError('')
        const reader = new FileReader()
        reader.onerror = () => { setUploading(false); setError('读本地文件失败。') }
        reader.onload = async () => {
          try {
            const text = String(reader.result || '')
            const base64 = text.slice(text.indexOf(',') + 1)
            await jpost('/files/write', { node: nodeId, ref: name, path: join(path, file.name), base64 })
            if (onToast) onToast('传上去了 ' + file.name)
            load(path)
          } catch (err) {
            setError('传不上去：' + (err && err.message ? err.message : String(err)))
          } finally {
            setUploading(false)
          }
        }
        reader.readAsDataURL(file)
      }

      function crumbs() {
        const parts = String(path).split('/').filter(Boolean)
        const nodes = [h('button', {
          key: 'root',
          'data-cm-crumb': '',
          onClick: () => goTo('/'),
        }, '/')]
        let built = ''
        for (const part of parts) {
          built += '/' + part
          nodes.push(h('span', { key: 'sep-' + built, 'data-cm-crumbsep': '' }, '›'))
          nodes.push(h('button', {
            key: built,
            'data-cm-crumb': '',
            onClick: () => goTo(built),
          }, part))
        }
        return nodes
      }

      const dirty = Boolean(open) && !open.binary && draft !== open.original
      const entries = dir && Array.isArray(dir.entries) ? dir.entries : []

      const head = h('div', { 'data-cm-fhead': '' },
        h('div', { 'data-cm-crumbs': '' }, crumbs()),
        h('div', { 'data-cm-facts': '' },
          h('button', {
            'data-cm-btn': '', 'data-cm-compact': '',
            disabled: busy,
            onClick: () => load(path),
          }, busy ? '读…' : '刷新'),
          // 上传用 <label> 包一个隐藏 input：浏览器自己会打开文件选择框，
          // 不需要 useRef + .click()（那样还得担心 ref 被当成字符串传下去）。
          h('label', {
            'data-cm-btn': '', 'data-cm-compact': '',
            'data-upload': uploading ? 'busy' : 'idle',
            title: '上传文件到当前目录',
            style: { cursor: uploading ? 'progress' : 'pointer' },
          },
          uploading ? '传…' : '上传',
          h('input', { type: 'file', style: { display: 'none' }, onChange: onUpload })),
          h('input', {
            'data-cm-input': '',
            'data-cm-fnew': '',
            placeholder: '新目录名',
            value: newDir,
            onChange: event => setNewDir(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') makeDir() },
          }),
          h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: makeDir, disabled: !newDir.trim() }, '建目录')))

      let paneBody = null
      if (!lxc && !running) {
        paneBody = h('div', { 'data-cm-hintbox': '' },
          '容器没在运行。Podman 列目录要进容器里跑命令，所以现在列不出来；已经知道路径的单个文件仍可读写。')
      } else if (error && !dir) {
        paneBody = h('div', { 'data-cm-warn': '' }, error)
      } else if (busy && !dir) {
        paneBody = h('div', { 'data-cm-dim': '' }, '读目录…')
      } else {
        const rows = entries.map(entry => {
          const active = Boolean(open) && open.path === join(path, entry.name)
          const confirmHere = removing === entry.name
          return h('div', {
            key: entry.name,
            'data-cm-frow': '',
            ...(active ? { 'data-on': '' } : {}),
          },
          h('button', {
            'data-cm-fopen': '',
            'data-kind': entry.type,
            title: entry.type === 'dir' ? '进这个目录' : '打开这个文件',
            onClick: () => openEntry(entry),
          },
          h('span', { 'data-cm-ficon': '', 'data-kind': entry.type }, entry.type === 'dir' ? '▸' : entry.type === 'symlink' ? '↗' : '·'),
          h('span', { 'data-cm-fname': '' }, entry.name)),
          h('span', { 'data-cm-fsize': '' }, entry.type === 'dir' ? '目录' : sizeText(entry.size)),
          confirmHere
            ? h('span', { 'data-cm-facts': '' },
              h('button', { 'data-cm-btn': '', 'data-cm-compact': '', 'data-danger': '', onClick: () => removeEntry(entry.name) }, '真删'),
              h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: () => setRemoving('') }, '算了'))
            : h('button', {
              'data-cm-btn': '', 'data-cm-compact': '',
              title: '删掉 ' + entry.name,
              onClick: () => setRemoving(entry.name),
            }, '删'))
        })
        paneBody = h('div', { 'data-cm-flist': '' },
          path === '/' ? null : h('div', { 'data-cm-frow': '', key: '..' },
            h('button', { 'data-cm-fopen': '', 'data-kind': 'dir', onClick: () => goTo(fileParentOf(path)) },
              h('span', { 'data-cm-ficon': '', 'data-kind': 'dir' }, '←'),
              h('span', { 'data-cm-fname': '' }, '..'))),
          rows.length ? rows : h('div', { 'data-cm-dim': '' }, '这个目录是空的。'),
          dir && dir.truncated ? h('div', { 'data-cm-dim': '' }, '项太多，只列了前 2000 个。') : null)
      }

      const editorBody = open
        ? h('div', { 'data-cm-feditor': '' },
          h('div', { 'data-cm-feh': '' },
            h('div', { 'data-cm-fename': '', title: open.path }, open.path),
            h('div', { 'data-cm-facts': '' },
              h('span', { 'data-cm-dim': '' }, sizeText(open.size) + (open.binary ? ' · 二进制' : ' ·utf8')),
              open.binary
                ? h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: () => downloadBytes(open.name, open.base64) }, '下载')
                : h('button', {
                  'data-cm-btn': '', 'data-cm-compact': '',
                  onClick: () => downloadText(open.name, draft),
                }, '下载'),
              h('button', { 'data-cm-btn': '', 'data-cm-compact': '', onClick: () => { setOpen(null); setDraft('') } }, '关闭'))),
          open.binary
            ? h('div', { 'data-cm-hintbox': '' }, '这是二进制文件，面板里只给下载，不在文本框里改。')
            : h('textarea', {
              'data-cm-ftext': '',
              spellCheck: false,
              value: draft,
              onChange: event => setDraft(event.target.value),
            }),
          h('div', { 'data-cm-facts': '' },
            !open.binary && dirty
              ? h('button', { 'data-cm-btn': '', 'data-primary': '', 'data-cm-compact': '', disabled: saving, onClick: save }, saving ? '写…' : '保存')
              : null,
            !open.binary && dirty ? h('span', { 'data-cm-dim': '' }, '改过，没保存') : null,
            !open.binary && !dirty ? h('span', { 'data-cm-dim': '' }, '没有改动') : null))
        : null

      return h('div', { 'data-cm-files': '' },
        head,
        error && dir ? h('div', { 'data-cm-warn': '' }, error) : null,
        h('div', { 'data-cm-fgrid': '' },
          h('div', { 'data-cm-fcol': '' }, paneBody),
          editorBody))
    }

    /* ───────────────────────── 活动日志（审计） ───────────────────────── */

    const AUDIT_FILTERS = [
      ['all', '全部'],
      ['panel', '人点的'],
      ['api', '接口调的'],
      ['danger', '危险动作'],
    ]

    const AUDIT_DANGER = ['delete', 'destroy', 'down', 'adopt', 'remove', 'snapshot', 'restore', 'commit', 'network']

    function clockText(iso) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return String(iso || '')
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
        pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function auditOk(row) {
      if (!row) return true
      if (typeof row.ok === 'boolean') return row.ok
      if (row.detail && typeof row.detail.ok === 'boolean') return row.detail.ok
      const result = String(row.error || row.result || '')
      if (!result) return true
      return !/fail|error|失败/i.test(result)
    }

    function ActivityPane() {
      const [rows, setRows] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [filter, setFilter] = React.useState('all')
      const [limit, setLimit] = React.useState(300)
      const alive = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const value = await jget('/audit?limit=' + limit)
          if (!alive.current) return
          setRows(Array.isArray(value) ? value : [])
          setError(null)
        } catch (e) {
          if (alive.current) setError(e && e.message ? e.message : String(e))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [limit])

      React.useEffect(() => { alive.current = true; load() }, [load])

      const shown = rows.filter((row) => {
        if (filter === 'panel') return row.principal === 'panel'
        if (filter === 'api') return row.principal === 'api'
        if (filter === 'danger') {
          const action = String(row.action || '').toLowerCase()
          return AUDIT_DANGER.some((word) => action.includes(word))
        }
        return true
      })

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, '活动日志'),
            h('div', { 'data-cm-grow': '' }),
            ...AUDIT_FILTERS.map((entry) => h('button', {
              key: entry[0],
              'data-cm-chip': '',
              ...(filter === entry[0] ? { 'data-on': '' } : {}),
              onClick: () => setFilter(entry[0]),
            }, entry[1])),
            h('button', { 'data-cm-btn': '', disabled: loading, onClick: () => { setLoading(true); load() } }, '刷新')),
          h('div', { 'data-cm-dim': '', style: { margin: '6px 0 10px', fontSize: 'var(--cm-f-xs)' } },
            '最近 ' + shown.length + ' 条 · 谁点过危险操作、AI 发起过什么，都记在 audit.jsonl 里')),
        h('div', { 'data-cm-card': '' },
          error
            ? h('div', { 'data-cm-warn': '' }, '读不到活动日志：' + error)
            : loading && rows.length === 0
              ? h('div', { 'data-cm-empty': '' }, '读取中…')
              : shown.length === 0
                ? h('div', { 'data-cm-empty': '' }, '这个筛选下还没有记录。')
                : h('div', { 'data-cm-audit': '' },
                  h('div', { 'data-cm-audit-row': '', 'data-head': '' },
                    h('span', null, '时间'), h('span', null, '谁'), h('span', null, '动作'),
                    h('span', null, '目标'), h('span', null, '结果')),
                  ...shown.map((row, index) => {
                    const ok = auditOk(row)
                    const target = [row.node, row.target].filter(Boolean).join(' / ')
                    return h('div', {
                      key: String(row.ts || row.at || '') + '#' + index,
                      'data-cm-audit-row': '',
                      ...(ok ? {} : { 'data-bad': '' }),
                    },
                      h('span', { 'data-cm-mono': '' }, clockText(row.ts || row.at)),
                      h('span', null, h('span', { 'data-cm-audit-tag': '', ...(row.principal === 'panel' ? { 'data-panel': '' } : {}) }, row.principal || '?')),
                      h('span', { 'data-cm-mono': '', title: String(row.action || '') }, String(row.action || '—')),
                      h('span', { title: target }, target || '—'),
                      h('span', null, ok ? 'ok' : String(row.error || row.result || 'fail')))
                  })))
      )
    }

    // 顶部五段：两套运行时各占一页，宿主网络、能力体检、审计各自独立。
    // 体检单独一页而不是塞进 Podman：它探的是「这台机能不能做某件事」（subuid / uidmap / 驱动 /
    // cgroup / linger），跟哪个运行时归属无关，挂在某一页底下会让人以为只管那一边。
    const VIEWS = [
      ['podman', 'Podman'],
      ['lxc', 'LXC'],
      ['host', '宿主网络'],
      ['capability', '体检'],
      ['activity', '活动'],
    ]

    // 每页自己的子 tab。Podman 那套是原来就有的，LXC 是新的。
    const PODMAN_TABS = [
      ['projects', '项目'],
      ['containers', '容器'],
      ['images', '镜像'],
      ['volumes', '卷'],
      ['networks', '网络'],
      ['secrets', '密钥'],
      ['quadlet', 'Quadlet'],
    ]
    const LXC_TABS = [
      ['containers', '容器'],
      ['images', '镜像'],
      ['networks', '网络'],
      ['storage', '存储'],
      ['backup', '备份'],
    ]
    const HOST_TABS = [
      ['interfaces', '网卡'],
      ['routes', '路由'],
      ['dns', 'DNS'],
      ['firewall', '防火墙'],
      ['diagnose', '诊断'],
    ]


    function ProjectsPane({ onOpenContainer, onPending }) {
      const [data, setData] = React.useState(null)
      const [runtime, setRuntime] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [tab, setTab] = React.useState('services')
      const [rootDraft, setRootDraft] = React.useState('')
      const [portTarget, setPortTarget] = React.useState(null)
      const [recreateTarget, setRecreateTarget] = React.useState('')
      const alive = React.useRef(true)
      const rootTouched = React.useRef(false)

      const refresh = React.useCallback(async () => {
        try {
          const list = await jget('/compose/projects')
          if (!alive.current) return
          setData(list)
          setError(null)
          if (!rootTouched.current) setRootDraft(list && list.layout ? (list.layout.root || '') : '')
        } catch (e) {
          if (!alive.current) return
          setError(e && e.message ? e.message : String(e))
        } finally {
          if (alive.current) setLoading(false)
        }
        try {
          const rt = await jget('/compose/runtime')
          if (alive.current) setRuntime(rt)
        } catch {
          if (alive.current) setRuntime(null)
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        refresh()
        let timer = null
        const tick = () => {
          timer = setTimeout(() => {
            if (document.hidden) {
              tick()
              return
            }
            refresh().then(tick, tick)
          }, COMPOSE_REFRESH_MS)
        }
        timer = setTimeout(tick, COMPOSE_REFRESH_MS)
        return () => {
          alive.current = false
          if (timer) clearTimeout(timer)
        }
      }, [refresh])

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 6000)
        return () => clearTimeout(timer)
      }, [toast])

      const openProject = async (name) => {
        setSelected(name)
        setTab('services')
        setPortTarget(null)
        setDetail(null)
        try {
          const value = await jget('/compose/projects/' + encodeURIComponent(name))
          if (alive.current) setDetail(value)
        } catch (e) {
          if (alive.current) setToast({ bad: true, text: '读项目详情失败：' + (e && e.message ? e.message : String(e)) })
        }
      }

      const reloadDetail = async (name) => {
        const target = name || selected
        if (!target) return
        try {
          const value = await jget('/compose/projects/' + encodeURIComponent(target))
          if (alive.current) setDetail(value)
        } catch {
          // 详情刷失败不打断页面，下次轮询会补上
        }
      }

      async function act(promise, successText) {
        setBusy(true)
        try {
          const result = await promise
          if (result && result.status === 'pending') {
            setToast('已挂起，在下面「待确认」里点一次才执行：' + (result.message || result.summary || ''))
            if (onPending) onPending()
          } else if (result && result.ok === false) {
            setToast({ bad: true, text: (result.message || '没成功') + (result.hint ? ' ' + result.hint : '') })
          } else if (successText) {
            setToast(successText)
          }
          await refresh()
          await reloadDetail()
          return result
        } catch (e) {
          setToast({ bad: true, text: e && e.message ? e.message : String(e) })
          return null
        } finally {
          setBusy(false)
        }
      }

      async function saveRoot() {
        const value = rootDraft.trim()
        if (!value) return
        setBusy(true)
        try {
          const saved = await jpost('/config', { compose: { root: value } })
          rootTouched.current = false
          setToast('根目录已保存：' + value + '（podman/ 与 lxc/ 会在下面自动出现）')
          if (saved && saved.layout && saved.layout.problem) {
            setToast({ bad: true, text: '目录建不了：' + (saved.layout.problem.detail || '') + (saved.layout.problem.hint ? ' — ' + saved.layout.problem.hint : '') })
          }
          await refresh()
        } catch (e) {
          setToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      function projectName(project) {
        return project && (project.name || project.projectName) || ''
      }

      function projectPorts(project) {
        const ports = []
        for (const service of project.services || []) {
          for (const port of service.expectedPorts || []) {
            if (port && port.raw) ports.push(port.raw)
          }
        }
        return ports
      }

      /* ── 左侧：根目录 + 项目列表 ── */
      const projects = data && Array.isArray(data.projects) ? data.projects : []
      const orphans = data && Array.isArray(data.orphans) ? data.orphans : []

      const leftChildren = []
      leftChildren.push(h('div', { key: 'root', 'data-cm-search': '', style: { display: 'flex', gap: '6px' } },
        h('input', {
          key: 'root-input',
          placeholder: '容器根目录（如 /opt/dsh-container）',
          value: rootDraft,
          onChange: event => { rootTouched.current = true; setRootDraft(event.target.value) },
          onKeyDown: event => { if (event.key === 'Enter') saveRoot() },
        }),
        h('button', {
          key: 'root-save',
          'data-cm-btn': '',
          disabled: busy || !rootDraft.trim(),
          onClick: saveRoot,
        }, '存')))

      if (selected && detail) {
        leftChildren.push(h('div', { key: 'back', 'data-cm-search': '', style: { display: 'flex', gap: '6px' } },
          h('button', { key: 'back-btn', 'data-cm-btn': '', onClick: () => { setSelected(null); setDetail(null); setTab('services') } }, '← 全部项目')))
      }

      const rows = []
      for (const project of projects) {
        const name = projectName(project)
        const running = project.counts ? project.counts.running : 0
        const total = project.counts ? project.counts.total : 0
        const ports = projectPorts(project)
        rows.push(h('button', {
          key: 'p-' + name,
          'data-cm-projcard': '',
          ...(selected === name ? { 'data-on': '' } : {}),
          onClick: () => openProject(name),
        },
          h('div', { 'data-cm-line': '' },
            h(Dot, { tone: project.broken ? 'warn' : (running > 0 ? 'on' : 'off') }),
            h('strong', null, name),
            h('div', { 'data-cm-grow': '' }),
            h('span', {
              'data-cm-tag': '',
              ...(project.broken ? { 'data-bad': '' } : running > 0 ? { 'data-ok': '' } : {}),
            }, project.broken ? '读不了' : (running + '/' + total))),
          h('div', { key: 'meta', 'data-cm-dim': '', style: { marginTop: '4px', fontSize: 'var(--cm-f-xs)' } },
            project.broken
              ? (project.problem || 'compose 文件有问题')
              : [project.fileName, project.stale ? '文件比容器新' : null].filter(Boolean).join(' · ')),
          ports.length > 0
            ? h('div', { key: 'ports', 'data-cm-dim': '', style: { marginTop: '2px', fontSize: 'var(--cm-f-xs)', wordBreak: 'break-all' } },
              ports.slice(0, 5).join('  ') + (ports.length > 5 ? '  …' : ''))
            : null))
      }
      if (rows.length === 0) {
        rows.push(h('div', { key: 'no-project', 'data-cm-hintbox': '' },
          loading ? '读取中…' : '这个目录下还没有 compose 项目。建一个子目录，把 docker-compose.yml 放进去就会出现在这里。'))
      }
      leftChildren.push(h('div', { key: 'scroll', 'data-cm-scroll': '' }, ...rows))

      if (orphans.length > 0) {
        leftChildren.push(h('div', { key: 'orphans', 'data-cm-group': '', style: { borderTop: '1px solid var(--cm-line)' } },
          h('div', { 'data-cm-ghead': '' }, '未分组容器'),
          h('div', { 'data-cm-dim': '', style: { padding: '0 6px 6px', fontSize: 'var(--cm-f-xs)' } },
            orphans.length + ' 个容器不属于任何项目（手工 podman run 的）。'),
          ...orphans.slice(0, 8).map(item => h('div', {
            key: 'o-' + item.name,
            'data-cm-row': '',
            onClick: () => onOpenContainer && onOpenContainer(item.nodeId, item.name),
          },
            h(Dot, { tone: item.running ? 'on' : 'off' }),
            h('div', { 'data-cm-rmain': '' },
              h('div', { 'data-cm-rname': '' }, item.name),
              h('div', { 'data-cm-rmeta': '' }, [item.state, item.image].filter(Boolean).join(' · ')))))))
      }

      const left = h('div', { key: 'left', 'data-cm-list': '' }, ...leftChildren)

      /* ── 右侧 ── */
      function emptyState() {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '项目'),
          h('div', { 'data-cm-dim': '' },
            projects.length === 0
              ? '还没有项目。基础目录下的每个一级子目录，只要里面有 compose 文件，就会成为一个项目。'
              : '从左边选一个项目，看它的服务、端口和 YAML。'),
          h('div', { 'data-cm-hintbox': '' },
            '一个目录一个项目：compose.yaml / compose.yml / docker-compose.yaml / docker-compose.yml 都认，优先取第一个匹配。'))
      }

      function runtimeCard() {
        if (!runtime) return null
        if (runtime.ready) return null
        return h('div', { 'data-cm-card': '', style: { borderColor: 'color-mix(in srgb,var(--cm-warn) 50%,transparent)' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'podman-compose 还没就绪'),
          h('div', { 'data-cm-dim': '' }, runtime.hint || '需要在本机建一个 venv 并装上 podman-compose。'),
          h('div', { 'data-cm-line': '', style: { marginTop: '8px' } },
            h('button', {
              'data-cm-btn': '',
              'data-primary': '',
              disabled: busy,
              onClick: () => act(jpost('/compose/runtime/install'), '装好了'),
            }, '一键安装'),
            h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
              '会建 ' + (runtime.venv || 'venv') + ' 并装 podman-compose ' + (runtime.expected || '') + '，要联网，可能几分钟。')))
      }

      function detailView() {
        if (!selected) return emptyState()
        if (!detail) return h('div', { 'data-cm-empty': '' }, '读取中…')
        const name = projectName(detail)
        const counts = detail.counts || { running: 0, total: 0 }
        return h('div', null,
          h('div', { 'data-cm-card': '' },
            h('div', { 'data-cm-line': '' },
              h(Dot, { tone: counts.running > 0 ? 'on' : 'off' }),
              h('strong', { style: { fontSize: 'var(--cm-f-lg)' } }, name),
              h('span', { 'data-cm-dim': '' }, counts.running + '/' + counts.total + ' 个服务在跑'),
              h('div', { 'data-cm-grow': '' }),
              h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: () => act(jpost('/compose/projects/' + encodeURIComponent(name) + '/up'), '已启动') }, '启动'),
              h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act(jpost('/compose/projects/' + encodeURIComponent(name) + '/restart'), '已重启') }, '重启'),
              h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => act(jpost('/compose/projects/' + encodeURIComponent(name) + '/down'), '已停止') }, '停止'),
              h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => act(jpost('/compose/projects/' + encodeURIComponent(name) + '/adopt'), '已接管') }, '接管现有容器')),
            h('div', { 'data-cm-hintbox': '' },
              '文件：' + (detail.file || '') + (detail.stale ? '（比容器新，改完记得重建）' : '')),
            detail.unsupported && detail.unsupported.length > 0
              ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } },
                '这些键本插件还不支持：' + detail.unsupported.map(item => (item.service ? item.service + '.' : '') + item.key).join('、'))
              : null),
          h('div', { 'data-cm-tabs': '', style: { paddingLeft: 0 } },
            ...['services', 'yaml', 'logs'].map(key => h('button', {
              key,
              'data-cm-tab': '',
              ...(tab === key ? { 'data-on': '' } : {}),
              onClick: () => setTab(key),
            }, key === 'services' ? '服务' : key === 'yaml' ? 'YAML' : '日志'))),
          tab === 'yaml'
            ? h(YamlEditor, { key: 'yaml:' + name, projectName: name, onSaved: () => { reloadDetail(name); refresh() } })
            : tab === 'logs'
              ? h(ProjectLogs, { key: 'logs:' + name, projectName: name, services: (detail.services || []).map(item => item.name) })
              : servicesView(detail, name))
      }

      function servicesView(project, name) {
        const services = project.services || []
        if (services.length === 0) return h('div', { 'data-cm-empty': '' }, '这个 compose 文件里没有服务。')
        return h('div', null,
          h('div', { 'data-cm-card': '' },
            h('table', { 'data-cm-table': '' },
              h('thead', null, h('tr', null,
                h('th', null, '服务'), h('th', null, '镜像'), h('th', null, '状态'), h('th', null, '端口'), h('th', null, ''))),
              h('tbody', null, ...services.map(service => h('tr', { key: service.name },
                h('td', null, service.name),
                h('td', { 'data-cm-dim': '' }, service.image || '—'),
                h('td', null, h('span', {
                  'data-cm-tag': '',
                  ...(service.state === 'running' ? { 'data-ok': '' } : service.state === 'missing' ? { 'data-bad': '' } : {}),
                }, service.state)),
                h('td', null, (service.expectedPorts || []).map(port => port.raw).join(', ') || '—'),
                h('td', null, h('span', { 'data-cm-facts': '' },
                  h('button', {
                    'data-cm-btn': '',
                    'data-cm-compact': '',
                    disabled: busy,
                    onClick: () => setPortTarget(portTarget === service.name ? null : service.name),
                  }, '改端口'),
                  recreateTarget === service.name
                    ? h('span', { 'data-cm-facts': '' },
                      h('button', {
                        'data-cm-btn': '',
                        'data-cm-compact': '',
                        'data-danger': '',
                        disabled: busy,
                        onClick: () => act(
                          jpost('/compose/projects/' + encodeURIComponent(name) + '/services/' + encodeURIComponent(service.name) + '/recreate'),
                          '已重建 ' + service.name,
                        ).then(() => setRecreateTarget('')),
                      }, '确认重建'),
                      h('button', { 'data-cm-btn': '', 'data-cm-compact': '', disabled: busy, onClick: () => setRecreateTarget('') }, '算了'))
                    : h('button', {
                      'data-cm-btn': '',
                      'data-cm-compact': '',
                      disabled: busy,
                      title: '先 pull 这个服务的镜像，再只重建它（别的服务不动）',
                      onClick: () => setRecreateTarget(service.name),
                    }, '拉新重建')))))))),
          portTarget
            ? h(PortEditor, {
              key: 'ports:' + name + ':' + portTarget,
              projectName: name,
              service: services.find(item => item.name === portTarget) || { name: portTarget, expectedPorts: [] },
              onDone: () => { setPortTarget(null); reloadDetail(name); refresh() },
            })
            : null)
      }

      const right = h('div', { key: 'right', 'data-cm-detail': '', style: { flex: '1' } },
        h('div', { 'data-cm-dbody': '' },
          error
            ? h('div', { 'data-cm-card': '' },
              h('div', { 'data-cm-warn': '' }, '读不到项目：' + error),
              h('div', { 'data-cm-hintbox': '' }, '根目录没配或不可用时先在上面填一个。'))
            : h('div', null, h('div', { key: 'runtime', style: { display: 'contents' } }, runtimeCard()), h('div', { key: 'main', style: { display: 'contents' } }, detailView()))))

      const toastView = toast
        ? h('div', { key: 'toast', 'data-cm-toast': '', ...(toast && toast.bad ? { 'data-bad': '' } : {}) }, toast && toast.text ? toast.text : String(toast))
        : null

      return h('div', { 'data-cm-body': '', style: { flex: '1', minHeight: '0' } },
        left,
        right,
        toastView)
    }

    /* 端口编辑：一行一个，法子和 compose 的短语法一致。 */
    function PortEditor({ projectName, service, onDone }) {
      const current = (service.expectedPorts || []).map(port => port.raw).join('\n')
      const [text, setText] = React.useState(current)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      async function save() {
        setBusy(true)
        setError(null)
        try {
          const ports = text.split('\n').map(line => line.trim()).filter(Boolean)
          const result = await jpost('/compose/projects/' + encodeURIComponent(projectName) + '/services/' + encodeURIComponent(service.name) + '/ports', { ports })
          if (onDone) onDone(result)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '改 ' + service.name + ' 的端口'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '6px' } },
          '一行一个：宿主:容器，例如 8080:80；只写容器端口就表示随机映射；末尾加 /udp 走 UDP。'),
        h('textarea', {
          'data-cm-editor': '',
          style: { minHeight: '90px' },
          value: text,
          placeholder: '8080:80\n127.0.0.1:9000:9000/udp',
          onChange: event => setText(event.target.value),
        }),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } }, error) : null,
        h('div', { 'data-cm-line': '', style: { marginTop: '8px' } },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: save }, busy ? '保存中…' : '写回 compose 文件'),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => onDone && onDone(null) }, '取消'),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, '写之前会备份，写之后要「重启」才生效。')))
    }

    /* YAML 编辑器：先读原文，保存时后端会先校验再落盘。 */
    function YamlEditor({ projectName, onSaved }) {
      const [text, setText] = React.useState('')
      const [original, setOriginal] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        jget('/compose/projects/' + encodeURIComponent(projectName) + '/yaml')
          .then(value => {
            if (!alive) return
            setText(value.text || '')
            setOriginal(value.text || '')
            setNote('文件：' + value.file + '（备份 ' + (value.backups || []).length + ' 份）')
          })
          .catch(e => { if (alive) setError(e && e.message ? e.message : String(e)) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [projectName])

      async function save() {
        setBusy(true)
        setError(null)
        try {
          await jpost('/compose/projects/' + encodeURIComponent(projectName) + '/yaml', { text })
          setOriginal(text)
          setNote('已写回，旧文件有备份。')
          if (onSaved) onSaved()
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      if (loading) return h('div', { 'data-cm-empty': '' }, '读取中…')
      const dirty = text !== original
      return h('div', null,
        h('div', { 'data-cm-line': '' },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { 'data-cm-btn': '', disabled: busy || !dirty, onClick: () => setText(original) }, '还原'),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, dirty ? '有未保存的改动' : '没有改动'),
          h('div', { 'data-cm-grow': '' }),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, note || '')),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px' } }, error) : null,
        h('textarea', {
          'data-cm-editor': '',
          spellCheck: false,
          value: text,
          onChange: event => setText(event.target.value),
        }),
        h('div', { 'data-cm-hintbox': '' },
          '保存时会先解析一遍：写坏了会报第几行第几列，文件不动。注释和别的服务都保留。'))
    }

    /* 项目日志：一次拉一个服务，不 follow。 */
    function ProjectLogs({ projectName, services }) {
      const [service, setService] = React.useState('')
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const load = React.useCallback(async (target) => {
        setBusy(true)
        setError(null)
        try {
          const query = '/compose/projects/' + encodeURIComponent(projectName) + '/logs?tail=300' + (target ? '&service=' + encodeURIComponent(target) : '')
          const value = await jget(query)
          setText(value.text || '（没有输出）')
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
          setText('')
        } finally {
          setBusy(false)
        }
      }, [projectName])

      React.useEffect(() => { load('') }, [load])

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
          h('select', {
            'data-cm-input': '',
            value: service,
            onChange: event => { setService(event.target.value); load(event.target.value) },
          },
            h('option', { value: '' }, '全部服务'),
            ...(services || []).map(name => h('option', { key: name, value: name }, name))),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => load(service) }, busy ? '读取中…' : '刷新'),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, '最近 300 行。')),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        h('pre', { 'data-cm-logbox': '' }, text))
    }

    /* ───────────────────── LXC：快照 / 挂载 ───────────────────── */

    function SnapshotsPane({ container, onToast }) {
      const [items, setItems] = React.useState([])
      const [note, setNote] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [comment, setComment] = React.useState('')
      const [confirmTarget, setConfirmTarget] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const value = await jget('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/snapshots')
          setItems(Array.isArray(value.snapshots) ? value.snapshots : [])
          setNote(value.note || '')
          setError(value.supported === false && value.detail ? value.detail : null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [container.nodeId, container.name])

      React.useEffect(() => { load() }, [load])

      async function act(op, snapshot, text) {
        setBusy(true)
        try {
          const result = await jpost('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/snapshots', {
            op,
            snapshot,
            comment: comment.trim() || undefined,
          })
          const queued = noteJobResult(result)
          if (queued) {
            onToast && onToast(queued)
          } else if (result && result.status === 'pending') {
            onToast && onToast('已挂起，在下面「待确认」里点确认：' + (result.summary || ''))
          } else {
            onToast && onToast(text)
          }
          setConfirmTarget(null)
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: (e && e.message ? e.message : String(e)) })
        } finally {
          setBusy(false)
        }
      }

      function snapshotsTable() {
        const rowsList = items.map((item) => {
          return h('tr', { key: item.name },
            h('td', null, item.name),
            h('td', { 'data-cm-dim': '', style: { wordBreak: 'break-all' } }, item.detail || '—'),
            h('td', null,
              h('div', { 'data-cm-line': '' },
                h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setConfirmTarget({ op: 'restore', name: item.name }) }, '回滚'),
                h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => setConfirmTarget({ op: 'delete', name: item.name }) }, '删除'))))
        })
        return h('table', { 'data-cm-table': '' },
          h('thead', null, h('tr', null,
            h('th', null, '名字'),
            h('th', null, '信息'),
            h('th', null, ''))),
          h('tbody', null, ...rowsList))
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '快照（' + items.length + '）'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: load }, '刷新')),
        note ? h('div', { 'data-cm-hintbox': '', style: { marginBottom: '8px' } }, note) : null,
        h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
          h('input', {
            'data-cm-input': '',
            style: { flex: '1', minWidth: '180px' },
            placeholder: '快照备注（可选）',
            value: comment,
            onChange: event => setComment(event.target.value),
          }),
          h('button', {
            'data-cm-btn': '',
            'data-primary': '',
            disabled: busy,
            onClick: () => act('create', null, '已开始建快照'),
          }, '建快照')),
        error ? h('div', { 'data-cm-warn': '', style: { marginBottom: '8px' } }, error) : null,
        loading
          ? h('div', { 'data-cm-empty': '' }, '读取中…')
          : items.length === 0
            ? h('div', { 'data-cm-empty': '' }, '还没有快照。')
            : snapshotsTable(),
        confirmTarget
          ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, confirmTarget.op === 'restore'
              ? '回滚到 ' + confirmTarget.name + '？当前 rootfs 会被覆盖，容器会被停掉。'
              : '删除快照 ' + confirmTarget.name + '？'),
            h('button', {
              'data-cm-btn': '',
              'data-danger': '',
              disabled: busy,
              onClick: () => act(confirmTarget.op, confirmTarget.name, confirmTarget.op === 'restore' ? '已回滚' : '已删除'),
            }, '确认'),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setConfirmTarget(null) }, '算了'))
          : null)
    }

    function LxcCloneCard({ container, onToast }) {
      const [name, setName] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const suggestion = container.name + '-copy'

      async function run() {
        const target = (name.trim() || suggestion)
        setBusy(true)
        setError(null)
        try {
          const result = await jpost('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/clone', { newName: target })
          const queued = noteJobResult(result)
          onToast && onToast(queued || ('已克隆成 ' + (result && result.name ? result.name : target)))
          setName('')
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '克隆'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
          '整份复制 rootfs 成一个新容器（停止状态）。源容器得先停掉；ext4 上很占磁盘。'),
        error ? h('div', { 'data-cm-warn': '', style: { marginBottom: '8px' } }, error) : null,
        h('div', { 'data-cm-line': '' },
          h('input', {
            'data-cm-input': '',
            style: { flex: '1', minWidth: '160px' },
            placeholder: suggestion,
            value: name,
            onChange: event => setName(event.target.value),
          }),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: run }, busy ? '克隆中…' : '克隆')))
    }

    function MountsPane({ container, onToast }) {
      const [text, setText] = React.useState('')
      const [original, setOriginal] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        jget('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/mounts')
          .then((value) => {
            if (!alive) return
            const lines = (value.mounts || []).map(item => item.host + '  ' + item.target)
            setText(lines.join('\n'))
            setOriginal(lines.join('\n'))
          })
          .catch((e) => { if (alive) setError(e && e.message ? e.message : String(e)) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [container.nodeId, container.name])

      async function save() {
        setBusy(true)
        setError(null)
        try {
          const mounts = text.split('\n').map(line => line.trim()).filter(Boolean).map((line) => {
            const parts = line.split(/\s+/)
            return { host: parts[0], target: parts[1] || parts[0] }
          })
          const result = await jpost('/containers/' + encodeURIComponent(container.nodeId) + '/' + encodeURIComponent(container.name) + '/mounts', { mounts })
          if (result && result.status === 'pending') {
            onToast && onToast('已挂起，在下面「待确认」里点确认：' + (result.summary || ''))
          } else {
            onToast && onToast('挂载点已写入 config')
            setOriginal(text)
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      if (loading) return h('div', { 'data-cm-empty': '' }, '读取中…')
      const dirty = text !== original

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '挂载点'),
          h('div', { 'data-cm-grow': '' }),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, dirty ? '有未保存的改动' : '没有改动')),
        h('div', { 'data-cm-hintbox': '', style: { marginBottom: '8px' } },
          '一行一个：宿主路径 容器路径。写进 lxc.mount.entry，容器下次启动时生效。'),
        error ? h('div', { 'data-cm-warn': '', style: { marginBottom: '8px' } }, error) : null,
        h('textarea', {
          'data-cm-editor': '',
          style: { minHeight: '140px' },
          spellCheck: false,
          value: text,
          placeholder: '/srv/data  /data',
          onChange: event => setText(event.target.value),
        }),
        h('div', { 'data-cm-line': '', style: { marginTop: '8px' } },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { 'data-cm-btn': '', disabled: busy || !dirty, onClick: () => setText(original) }, '还原')))
    }

    /* ───────────────────── 终端（xterm.js + WebSocket） ───────────────────── */

    let xtermPromise = null
    let fitPromise = null

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('加载失败：' + src))
        document.head.appendChild(script)
      })
    }

    function ensureXterm() {
      if (window.Terminal) return Promise.resolve()
      if (xtermPromise) return xtermPromise
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = API + '/static/xterm/xterm.css'
      document.head.appendChild(link)
      xtermPromise = loadScript(API + '/static/xterm/xterm.js').then(() => {
        if (!window.Terminal) throw new Error('xterm.js 加载了但没有 window.Terminal')
      })
      return xtermPromise
    }

    function ensureFit() {
      if (window.FitAddon && window.FitAddon.FitAddon) return Promise.resolve()
      if (fitPromise) return fitPromise
      fitPromise = loadScript(API + '/static/xterm/addon-fit.js').then(() => {
        if (!window.FitAddon || !window.FitAddon.FitAddon) throw new Error('addon-fit 加载了但没挂上 FitAddon')
      })
      return fitPromise
    }

    /**
     * 从 DSH 的主题令牌里取一套 xterm 配色。
     * 令牌本身是亮/暗双套定义（body / body[data-ds-dark-theme]），所以这里不用判主题，
     * 换主题时重新读一次就行 —— 见下面的 MutationObserver。
     */
    function readTermTheme() {
      const fallback = {
        background: '#101114',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: 'rgba(128,128,128,.3)',
      }
      if (typeof window === 'undefined' || !document.body) return fallback
      const style = window.getComputedStyle(document.body)
      const read = (name, fb) => {
        const value = (style.getPropertyValue(name) || '').trim()
        return value || fb
      }
      return {
        background: read('--dsw-alias-bg-layer-1', fallback.background),
        foreground: read('--dsw-alias-label-primary', fallback.foreground),
        cursor: read('--dsw-alias-label-primary', fallback.cursor),
        selectionBackground: read('--dsw-alias-interactive-bg-hover-accent', fallback.selectionBackground),
        // 亮色主题下终端是白底，xterm 默认那套深色 ANSI 调色板会看不见（尤其黄和青色），
        // 所以把常用的几个换成 DSH 自己的静态色板。
        black: read('--dsw-static-neutral-bluish-1000', '#0f1115'),
        red: read('--dsw-static-red-600', '#dc2626'),
        green: read('--dsw-static-green-500', '#22c55e'),
        yellow: read('--dsw-static-amber-600', '#dd8629'),
        blue: read('--dsw-static-blue-600', '#2563eb'),
        magenta: read('--dsw-static-violet-600', '#7c3aed'),
        cyan: read('--dsw-static-blue-400', '#60a5fa'),
        white: read('--dsw-static-neutral-bluish-00', '#ffffff'),
        brightBlack: read('--dsw-alias-label-tertiary', '#8b9096'),
      }
    }

    function terminalSocketUrl(nodeId, name) {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      // 查询参数名还是 ref（后端接口约定），传进来的是容器名
      const query = '?node=' + encodeURIComponent(nodeId) + '&ref=' + encodeURIComponent(name)
      return scheme + '://' + window.location.host + API + '/terminal' + query
    }

    function TerminalPane({ nodeId, name }) {
      // 字号偏好：常量与读写都收在函数体内 —— TerminalPane 要能被整段抽出来单独渲染
      // （react-ref 测试走的就是这条路），模块级依赖放外面会变成未定义变量。
      const TERM_SIZE_KEY = 'cm-terminal-font-size'
      const TERM_MIN_SIZE = 11
      const TERM_MAX_SIZE = 20
      const TERM_DEFAULT_SIZE = 13

      const readTermFontSize = () => {
        try {
          const saved = Number(window.localStorage.getItem(TERM_SIZE_KEY))
          if (Number.isFinite(saved) && saved >= TERM_MIN_SIZE && saved <= TERM_MAX_SIZE) return saved
        } catch { /* localStorage 被禁（SSR 也没有 window）就用默认 */ }
        return TERM_DEFAULT_SIZE
      }

      const saveTermFontSize = (size) => {
        try { window.localStorage.setItem(TERM_SIZE_KEY, String(size)) } catch { /* 忽略 */ }
      }

      const hostRef = React.useRef(null)
      // 实例都挂 ref 上：字号、清屏、全屏要直接摸到它们，但不该触发重建（重建会断连接）。
      const termRef = React.useRef(null)
      const fitRef = React.useRef(null)
      const socketRef = React.useRef(null)
      const [fontSize, setFontSize] = React.useState(() => readTermFontSize())
      const [full, setFull] = React.useState(false)
      const [state, setState] = React.useState('loading')
      const [message, setMessage] = React.useState('')
      const [tick, setTick] = React.useState(0)

      // 建实例时读一次；之后改字号走 options，不动 deps。
      const sizeRef = React.useRef(fontSize)
      sizeRef.current = fontSize

      React.useEffect(() => { saveTermFontSize(fontSize) }, [fontSize])

      // 改字号后必须重新 fit，否则右下角空一块或者被裁。
      React.useEffect(() => {
        const term = termRef.current
        if (!term) return
        try { term.options.fontSize = fontSize } catch { /* 忽略 */ }
        try { fitRef.current?.fit() } catch { /* 忽略 */ }
      }, [fontSize])

      // 全屏时 Esc 退出。
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setFull(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

      React.useEffect(() => {
        let disposed = false
        let term = null
        let fit = null
        let socket = null
        let observer = null
        let themeWatcher = null

        const fail = (text) => {
          if (disposed) return
          setState('error')
          setMessage(text)
        }

        const sendInput = (data) => {
          const live = socketRef.current
          if (!live || live.readyState !== 1) return
          try { live.send(JSON.stringify({ type: 'input', data })) } catch { /* 连接刚好断了，丢掉这次输入 */ }
        }

        Promise.all([ensureXterm(), ensureFit()])
          .then(() => {
            if (disposed || !hostRef.current) return
            term = new window.Terminal({
              theme: readTermTheme(),
              cursorBlink: true,
              cursorStyle: 'block',
              fontSize: sizeRef.current,
              lineHeight: 1.2,
              fontFamily: "'JetBrains Mono','Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
              scrollback: 5000,
              allowProposedApi: false,
              macOptionIsMeta: true,
              rightClickSelectsWord: true,
            })
            termRef.current = term
            fit = new window.FitAddon.FitAddon()
            fitRef.current = fit
            try { term.loadAddon(fit) } catch { /* addon 没挂上也还能用，只是不自动缩放 */ }
            try {
              term.open(hostRef.current)
            } catch (openError) {
              fail('xterm 挂不到容器上：' + (openError && openError.message ? openError.message : String(openError)))
              return
            }
            try { fit.fit() } catch { /* 还没布局好，稍后再试 */ }

            // xterm 会把按键直接喂给 PTY，Ctrl+Shift+C/V 得自己拦下来，
            // 否则浏览器那边的复制粘贴永远轮不到。
            term.attachCustomKeyEventHandler((event) => {
              if (event.type !== 'keydown') return true
              const key = String(event.key || '').toLowerCase()
              if (event.ctrlKey && event.shiftKey && key === 'c') {
                const picked = term.getSelection()
                if (picked) {
                  try { navigator.clipboard.writeText(picked) } catch { /* 没权限就算了，还能手动选 */ }
                  try { term.clearSelection() } catch { /* 忽略 */ }
                }
                return false
              }
              if (event.ctrlKey && event.shiftKey && key === 'v') {
                try {
                  navigator.clipboard.readText().then(text => { if (text) sendInput(text) }).catch(() => { /* 没权限 */ })
                } catch { /* 忽略 */ }
                return false
              }
              return true
            })

            socket = new WebSocket(terminalSocketUrl(nodeId, name))
            socketRef.current = socket
            socket.onopen = () => {
              if (disposed) return
              setState('ready')
              try {
                socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
              } catch { /* 忽略 */ }
              try { term.focus() } catch { /* 忽略 */ }
            }
            socket.onmessage = (event) => {
              let frame = null
              try { frame = JSON.parse(event.data) } catch { return }
              if (!frame || typeof frame.type !== 'string') return
              if (frame.type === 'data' && typeof frame.data === 'string') {
                try { term.write(frame.data) } catch (writeError) {
                  fail('终端写入失败：' + (writeError && writeError.message ? writeError.message : String(writeError)))
                }
                return
              }
              if (frame.type === 'ready') {
                setState('ready')
                try { term.focus() } catch { /* 忽略 */ }
                return
              }
              if (frame.type === 'error') {
                fail(frame.message || '终端出错')
                return
              }
              if (frame.type === 'exit') {
                term.write('\r\n[进程已退出' + (frame.code != null ? '，code=' + frame.code : '') + ']\r\n')
                setState('closed')
                return
              }
            }
            socket.onerror = () => fail('WebSocket 连不上（可能被反代挡了，或者会话过期）')
            socket.onclose = () => {
              if (disposed) return
              setState((prev) => (prev === 'error' ? prev : 'closed'))
            }
            term.onData(sendInput)

            if (typeof ResizeObserver === 'function') {
              observer = new ResizeObserver(() => {
                try { fit.fit() } catch { /* 忽略 */ }
              })
              observer.observe(hostRef.current)
            }

            if (typeof MutationObserver === 'function' && document.body) {
              themeWatcher = new MutationObserver(() => {
                if (disposed || !term) return
                try { term.options.theme = readTermTheme() } catch { /* 忽略 */ }
              })
              themeWatcher.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
            }
          })
          .catch((error) => fail(error && error.message ? error.message : String(error)))

        return () => {
          disposed = true
          if (observer) { try { observer.disconnect() } catch { /* 忽略 */ } }
          if (themeWatcher) { try { themeWatcher.disconnect() } catch { /* 忽略 */ } }
          if (socket) { try { socket.close() } catch { /* 忽略 */ } }
          if (term) { try { term.dispose() } catch { /* 忽略 */ } }
          termRef.current = null
          fitRef.current = null
          socketRef.current = null
        }
      }, [nodeId, name, tick])

      const statusLabel = state === 'ready' ? '已连接' : state === 'loading' ? '连接中…' : state === 'closed' ? '已断开' : '出错了'
      const statusTag = state === 'ready' ? { 'data-ok': '' } : state === 'error' ? { 'data-bad': '' } : state === 'closed' ? { 'data-warn': '' } : {}
      const canNarrow = fontSize > TERM_MIN_SIZE
      const canWiden = fontSize < TERM_MAX_SIZE

      const overlay = state === 'ready' ? null : h('div',
        { 'data-cm-term-overlay': '', ...(state === 'error' ? { 'data-bad': '' } : {}) },
        h('div', { 'data-cm-overlay-title': '' }, state === 'loading' ? '连接中…' : state === 'closed' ? '连接已断开' : '连不上'),
        h('div', { 'data-cm-overlay-msg': '' },
          state === 'loading'
            ? '正在打开容器内的 shell…'
            : state === 'error'
              ? (message || '未知错误')
              : '可能是容器停了、会话过期，或者反代把连接掐了。'),
        h('button', {
          'data-cm-btn': '', 'data-primary': '', type: 'button',
          onClick: () => setTick(value => value + 1),
        }, '重新连接'))

      return h('div', { 'data-cm-term-wrap': '', ...(full ? { 'data-cm-full': '' } : {}) },
        h('div', { 'data-cm-term-bar': '' },
          h('span', { 'data-cm-tag': '', ...statusTag }, statusLabel),
          h('span', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, name + ' · 容器内 shell'),
          h('div', { 'data-cm-grow': '' }),
          h('div', { 'data-cm-term-bar-group': '' },
            h('button', { type: 'button', title: '缩小字号', disabled: !canNarrow, onClick: () => setFontSize(value => Math.max(TERM_MIN_SIZE, value - 1)) }, 'A−'),
            h('span', { 'data-cm-term-size': '' }, String(fontSize)),
            h('button', { type: 'button', title: '放大字号', disabled: !canWiden, onClick: () => setFontSize(value => Math.min(TERM_MAX_SIZE, value + 1)) }, 'A＋')),
          h('div', { 'data-cm-term-bar-group': '' },
            h('button', { type: 'button', title: '清屏（只清显示，不动 shell 的历史）', onClick: () => { try { termRef.current?.clear() } catch { /* 忽略 */ } } }, '清屏'),
            h('button', { type: 'button', title: full ? '退出全屏（Esc）' : '全屏', onClick: () => setFull(value => !value) }, full ? '还原' : '全屏'),
            h('button', { type: 'button', title: '重新连接', onClick: () => setTick(value => value + 1) }, '重连'))),
        h('div', { 'data-cm-term': '', ref: hostRef }, overlay))
    }

    /* ───────────────────── 镜像 / 卷 ───────────────────── */

    /** 从 bond.options 字符串里抠一个键（mode=active-backup,miimon=100）。 */
    function bondOption(options, key) {
      const match = new RegExp('(?:^|,)' + key + '=([^,]+)').exec(String(options ?? ''))
      return match ? match[1].trim() : ''
    }

    /** 多行文本 <-> 数组。 */
    function linesOf(text) {
      return String(text ?? '')
        .split(/\n/)
        .map(line => line.trim())
        .filter(Boolean)
    }

    function draftFromConnection(data) {
      return {
        method: data.ipv4.method || 'auto',
        addresses: (data.ipv4.addresses || []).join('\n'),
        gateway: data.ipv4.gateway || '',
        dns: (data.ipv4.dns || []).join(' '),
        dnsSearch: (data.ipv4.dnsSearch || []).join(' '),
        routes: (data.ipv4.routes || []).join('\n'),
        neverDefault: Boolean(data.ipv4.neverDefault),
        ipv6Method: data.ipv6.method || 'auto',
        ipv6Addresses: (data.ipv6.addresses || []).join('\n'),
        ipv6Gateway: data.ipv6.gateway || '',
        ipv6Dns: (data.ipv6.dns || []).join(' '),
        mtu: data.ethernet.mtu ? String(data.ethernet.mtu) : '',
        clonedMac: data.ethernet.clonedMac || '',
        autoconnect: Boolean(data.autoconnect),
        autoconnectPriority: String(data.autoconnectPriority ?? 0),
        zone: data.zone || '',
        bridgeStp: Boolean(data.bridge.stp),
        bridgePriority: data.bridge.priority ? String(data.bridge.priority) : '',
        bridgeForwardDelay: data.bridge.forwardDelay ? String(data.bridge.forwardDelay) : '',
        bondMode: bondOption(data.bond.options, 'mode') || 'active-backup',
        bondMiimon: bondOption(data.bond.options, 'miimon') || '100',
        wgPort: data.wireguard.listenPort ? String(data.wireguard.listenPort) : '',
      }
    }

    /** 表单值 -> 给后端的 patch。空字符串当「清空」，不是「不改」。 */
    function patchFromDraft(draft, data) {
      const patch = {
        method: draft.method,
        addresses: linesOf(draft.addresses),
        gateway: draft.gateway.trim(),
        dns: linesOf(draft.dns.replace(/,/g, ' ')).join(' ').split(/\s+/).filter(Boolean),
        dnsSearch: linesOf(draft.dnsSearch.replace(/,/g, ' ')).join(' ').split(/\s+/).filter(Boolean),
        routes: linesOf(draft.routes),
        neverDefault: Boolean(draft.neverDefault),
        autoconnect: Boolean(draft.autoconnect),
        autoconnectPriority: Number(draft.autoconnectPriority) || 0,
        zone: draft.zone.trim(),
        ipv6: {
          method: draft.ipv6Method,
          addresses: linesOf(draft.ipv6Addresses),
          gateway: draft.ipv6Gateway.trim(),
          dns: linesOf(draft.ipv6Dns.replace(/,/g, ' ')).join(' ').split(/\s+/).filter(Boolean),
        },
      }
      if (data.type !== '802-3-ethernet' || true) {
        patch.mtu = draft.mtu ? Number(draft.mtu) : 0
        patch.clonedMac = draft.clonedMac.trim()
      }
      if (data.type === 'bridge') {
        patch.bridge = {
          stp: Boolean(draft.bridgeStp),
          priority: Number(draft.bridgePriority) || 32768,
          forwardDelay: Number(draft.bridgeForwardDelay) || 15,
        }
      }
      if (data.type === 'bond') {
        patch.bond = { mode: draft.bondMode, miimon: Number(draft.bondMiimon) || 100 }
      }
      if (data.type === 'wireguard') {
        patch.wireguard = { listenPort: Number(draft.wgPort) || 0 }
      }
      return patch
    }

    function ConnectionEditor({ name, busy, run, onClose }) {
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [draft, setDraft] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        setState({ loading: true, error: null, data: null })
        jget('/net/connections/' + encodeURIComponent(name) + '/full')
          .then(data => {
            if (cancelled) return
            setState({ loading: false, error: null, data })
            setDraft(draftFromConnection(data))
          })
          .catch(e => {
            if (cancelled) return
            setState({ loading: false, error: e && e.message ? e.message : String(e), data: null })
          })
        return () => { cancelled = true }
      }, [name])

      if (state.loading) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-dim': '' }, '读连接配置中…'))
      if (state.error) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-warn': '' }, state.error),
          h('button', { 'data-cm-btn': '', style: { marginTop: '8px' }, onClick: onClose }, '返回'))
      }
      const data = state.data
      const set = key => e => setDraft(Object.assign({}, draft, { [key]: e.target.value }))
      const check = key => e => setDraft(Object.assign({}, draft, { [key]: e.target.checked }))

      const save = () => {
        const patch = patchFromDraft(draft, data)
        run(jpost('/net/connections/' + encodeURIComponent(name), { patch }), '改动已挂起，去待确认里点一下')
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } },
          '编辑 ' + data.name,
          h('span', { 'data-cm-dim': '', style: { marginLeft: '8px', fontWeight: '400' } }, data.type)),
        data.readOnly ? h('div', { 'data-cm-warn': '', style: { marginBottom: '8px' } }, '这条连接是只读的，改不动。') : null,

        h('div', { 'data-cm-sec': '' }, '通用'),
        h('div', { 'data-cm-formrow': '' },
          field('连接名', h('input', { 'data-cm-input': '', value: data.name, disabled: true })),
          field('接口', h('input', { 'data-cm-input': '', value: data.interfaceName, disabled: true })),
          field('优先级', h('input', { 'data-cm-input': '', type: 'number', value: draft.autoconnectPriority, onChange: set('autoconnectPriority') })),
          field('防火墙 zone', h('input', { 'data-cm-input': '', value: draft.zone, placeholder: '例如 public', onChange: set('zone') }))),
        h('label', { 'data-cm-check': '' },
          h('input', { type: 'checkbox', checked: draft.autoconnect, onChange: check('autoconnect') }),
          '开机自动连接'),

        h('div', { 'data-cm-sec': '' }, 'IPv4'),
        h('div', { 'data-cm-formrow': '' },
          field('方式', h('select', { 'data-cm-input': '', value: draft.method, onChange: set('method') },
            ...[['auto', '自动（DHCP）'], ['manual', '手动'], ['disabled', '关掉 IPv4'], ['ignore', '不管 IPv4']]
              .map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
          field('网关', h('input', { 'data-cm-input': '', value: draft.gateway, placeholder: '留空 = 不设', onChange: set('gateway') }))),
        field('地址（每行一个，带前缀）', h('textarea', {
          'data-cm-input': '',
          rows: 2,
          value: draft.addresses,
          placeholder: '192.168.1.10/24',
          onChange: set('addresses'),
        })),
        field('DNS（空格或逗号分隔）', h('input', { 'data-cm-input': '', value: draft.dns, placeholder: '203.0.113.53 1.1.1.1', onChange: set('dns') })),
        field('搜索域', h('input', { 'data-cm-input': '', value: draft.dnsSearch, placeholder: 'lan example.com', onChange: set('dnsSearch') })),
        field('静态路由（每行：目的 网关 metric）', h('textarea', {
          'data-cm-input': '',
          rows: 2,
          value: draft.routes,
          placeholder: '10.0.0.0/8 10.1.1.1 50',
          onChange: set('routes'),
        })),
        h('label', { 'data-cm-check': '' },
          h('input', { type: 'checkbox', checked: draft.neverDefault, onChange: check('neverDefault') }),
          '不要把这条当默认路由'),

        h('div', { 'data-cm-sec': '' }, 'IPv6'),
        h('div', { 'data-cm-formrow': '' },
          field('方式', h('select', { 'data-cm-input': '', value: draft.ipv6Method, onChange: set('ipv6Method') },
            ...[['auto', '自动'], ['manual', '手动'], ['disabled', '关掉 IPv6'], ['ignore', '不管 IPv6']]
              .map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
          field('网关', h('input', { 'data-cm-input': '', value: draft.ipv6Gateway, onChange: set('ipv6Gateway') }))),
        field('地址（每行一个，带前缀）', h('textarea', {
          'data-cm-input': '',
          rows: 2,
          value: draft.ipv6Addresses,
          placeholder: 'fd00::10/64',
          onChange: set('ipv6Addresses'),
        })),
        field('DNS', h('input', { 'data-cm-input': '', value: draft.ipv6Dns, placeholder: '2400:3200::1', onChange: set('ipv6Dns') })),

        data.type === '802-3-ethernet'
          ? h('div', null,
            h('div', { 'data-cm-sec': '' }, '以太网'),
            h('div', { 'data-cm-formrow': '' },
              field('MTU（留空 = 自动）', h('input', { 'data-cm-input': '', type: 'number', value: draft.mtu, placeholder: '1500', onChange: set('mtu') })),
              field('克隆 MAC', h('input', { 'data-cm-input': '', value: draft.clonedMac, placeholder: '留空 = 用真 MAC', onChange: set('clonedMac') }))))
          : null,

        data.type === 'bridge'
          ? h('div', null,
            h('div', { 'data-cm-sec': '' }, '网桥'),
            h('label', { 'data-cm-check': '' },
              h('input', { type: 'checkbox', checked: draft.bridgeStp, onChange: check('bridgeStp') }),
              '开启 STP'),
            h('div', { 'data-cm-formrow': '' },
              field('优先级（越小越优先）', h('input', { 'data-cm-input': '', type: 'number', value: draft.bridgePriority, placeholder: '32768', onChange: set('bridgePriority') })),
              field('转发延迟（秒）', h('input', { 'data-cm-input': '', type: 'number', value: draft.bridgeForwardDelay, placeholder: '15', onChange: set('bridgeForwardDelay') }))))
          : null,

        data.type === 'bond'
          ? h('div', null,
            h('div', { 'data-cm-sec': '' }, '链路聚合'),
            h('div', { 'data-cm-formrow': '' },
              field('模式', h('select', { 'data-cm-input': '', value: draft.bondMode, onChange: set('bondMode') },
                ...[['active-backup', 'active-backup（主备）'], ['balance-rr', 'balance-rr（轮询）'],
                  ['balance-xor', 'balance-xor'], ['802.3ad', '802.3ad（LACP）'], ['broadcast', 'broadcast']]
                  .map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
              field('miimon（毫秒）', h('input', { 'data-cm-input': '', type: 'number', value: draft.bondMiimon, placeholder: '100', onChange: set('bondMiimon') }))))
          : null,

        data.type === 'vlan'
          ? h('div', null,
            h('div', { 'data-cm-sec': '' }, 'VLAN'),
            h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
              'VLAN id ' + (data.vlan.id || '—') + '，挂载在 ' + (data.vlan.parent || '—') + ' 上。改这两项要删了重建。'))
          : null,

        data.type === 'wireguard'
          ? h('div', null,
            h('div', { 'data-cm-sec': '' }, 'WireGuard'),
            h('div', { 'data-cm-formrow': '' },
              field('监听端口', h('input', { 'data-cm-input': '', type: 'number', value: draft.wgPort, onChange: set('wgPort') })),
              field('私钥', h('input', { 'data-cm-input': '', value: data.wireguard.privateKey || '', disabled: true }))),
            h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginBottom: '6px' } },
              data.wireguard.peerError
                ? '对端读不到：' + data.wireguard.peerError
                : '对端 ' + (data.wireguard.peers || []).length + ' 个'),
            ...(data.wireguard.peers || []).map(peer => h('div', { key: peer.publicKey, 'data-cm-netrow': '' },
              h('div', { 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)' } }, peer.publicKey.slice(0, 20) + '…'),
              h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)' } },
                (peer.endpoint || '无 endpoint') + ' · 允许 ' + (peer.allowedIps || []).join(', ') +
                ' · 收 ' + sizeText(peer.rxBytes) + ' 发 ' + sizeText(peer.txBytes) +
                (peer.latestHandshake ? ' · ' + new Date(peer.latestHandshake * 1000).toLocaleString() : ' · 还没握过手')))))
          : null,

        h('div', { 'data-cm-formrow': '', style: { marginTop: '12px' } },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: save }, '保存（会挂起）'),
          h('button', { 'data-cm-btn': '', onClick: onClose }, '收起'),
          h('button', {
            'data-cm-btn': '',
            'data-danger': '',
            disabled: busy,
            onClick: () => run(
              jpost('/net/connections/' + encodeURIComponent(name) + '/delete', {}),
              '删除已挂起，去待确认里点一下'),
          }, '删除连接')))
    }

    function HostInterfacesView({ hostNet, busy, run, editing, onEdit }) {
      const [openIf, setOpenIf] = React.useState('')
      // 新建连接的入口原来挂在旧的混合「网络」页上，分页之后挪到这里。
      const [netCreating, setNetCreating] = React.useState(false)
      const data = hostNet.data
      const rateRef = React.useRef(null)
      const [rates, setRates] = React.useState({})

      // 收发字节是累计值，两次采样一减再除时间才是速率。
      React.useEffect(() => {
        if (!data || !data.ok || !Array.isArray(data.interfaces)) return
        const now = Date.now()
        const prev = rateRef.current
        if (prev && now > prev.at) {
          const seconds = (now - prev.at) / 1000
          const next = {}
          for (const item of data.interfaces) {
            const before = prev.stats[item.name]
            if (!before) continue
            next[item.name] = {
              rx: Math.max(0, (item.stats.rxBytes - before.rx) / seconds),
              tx: Math.max(0, (item.stats.txBytes - before.tx) / seconds),
            }
          }
          setRates(next)
        }
        const snapshot = {}
        for (const item of data.interfaces) {
          snapshot[item.name] = { rx: item.stats.rxBytes, tx: item.stats.txBytes }
        }
        rateRef.current = { at: now, stats: snapshot }
      }, [data])

      if (!data || !data.ok) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-warn': '' }, hostNet.problem ? '读不到宿主网络：' + hostNet.problem : '读取中…'))
      }
      const neighbors = data.neighbors || []
      const toggleIf = name => setOpenIf(openIf === name ? '' : name)

      return h('div', null,
        h('div', { 'data-cm-formrow': '', style: { marginBottom: '10px' } },
          h('button', {
            'data-cm-btn': '',
            ...(netCreating ? {} : { 'data-primary': '' }),
            onClick: () => setNetCreating(!netCreating),
          }, netCreating ? '收起' : '＋ 新建连接')),
        netCreating ? h(ConnectionCreateForm, { busy, run, onClose: () => setNetCreating(false) }) : null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '宿主网卡（' + data.interfaces.length + '）'),
          h('div', { 'data-cm-dim': '', style: { marginBottom: '4px', fontSize: 'var(--cm-f-xs)' } },
            '点一行展开邻居表。速率与驱动来自 /sys。'),
          ...data.interfaces.map(item => {
            const open = openIf === item.name
            const mine = neighbors.filter(entry => entry.device === item.name)
            return h('div', { key: item.name, 'data-cm-netrow': '' },
              h('div', {
                style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
                onClick: () => toggleIf(item.name),
              },
                h(Dot, { tone: item.state === 'up' ? 'on' : 'off' }),
                h('strong', null, item.name),
                h('span', { 'data-cm-dim': '' }, item.type + (item.driver ? ' · ' + item.driver : '')),
                h('div', { 'data-cm-grow': '' }),
                item.speed ? h('span', { 'data-cm-dim': '', 'data-cm-mono': '' }, item.speed + ' Mb/s') : null,
                rates[item.name]
                  ? h('span', { 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)', color: 'var(--cm-accent)' } },
                    sizeText(rates[item.name].rx) + '/s ↓ ' + sizeText(rates[item.name].tx) + '/s ↑')
                  : null,
                h('span', { 'data-cm-dim': '', 'data-cm-mono': '' },
                  sizeText(item.stats.rxBytes) + ' ↓ / ' + sizeText(item.stats.txBytes) + ' ↑'),
                h('span', { 'data-cm-dim': '' }, open ? '−' : '+')),
              h('div', { 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-sm)', marginTop: '2px' } },
                (item.addresses || []).filter(entry => entry.family === 'inet').map(entry => entry.address + '/' + entry.prefix).join('  ') || '没有 IPv4'),
              h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '1px' } },
                'MTU ' + item.mtu + ' · MAC ' + item.mac),
              open
                ? h('div', { style: { marginTop: '6px' } },
                  h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginBottom: '2px' } },
                    mine.length ? '邻居 ' + mine.length + ' 条' : '还没有邻居记录'),
                  ...mine.slice(0, 15).map(entry => h('div', {
                    key: entry.address,
                    'data-cm-mono': '',
                    style: { fontSize: 'var(--cm-f-xs)', color: 'var(--cm-text-dim)' },
                  }, entry.address + '  ' + (entry.mac || '—') + '  ' + entry.state)))
                : null)
          })),

        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'NetworkManager 连接'),
          h('div', { 'data-cm-dim': '', style: { marginBottom: '6px', fontSize: 'var(--cm-f-xs)' } },
            '点「编辑」改配置。启停、删除、新建都会先挂起，等你在待确认里点。'),
          ...(data.connections || []).map(conn => h('div', { key: conn.name, 'data-cm-netrow': '' },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(Dot, { tone: conn.state === 'activated' ? 'on' : 'off' }),
              h('strong', null, conn.name),
              h('span', { 'data-cm-dim': '' }, conn.type + (conn.device ? ' / ' + conn.device : '')),
              h('div', { 'data-cm-grow': '' }),
              h('span', { 'data-cm-dim': '', 'data-cm-mono': '' }, conn.state)),
            h('div', { 'data-cm-formrow': '', style: { marginTop: '4px' } },
              h('button', {
                'data-cm-btn': '',
                onClick: () => onEdit(editing === conn.name ? '' : conn.name),
              }, editing === conn.name ? '收起' : '编辑'),
              conn.device
                ? h('button', {
                  'data-cm-btn': '',
                  disabled: busy,
                  onClick: () => run(
                    jpost('/net/connections/' + encodeURIComponent(conn.name) + '/state', { up: conn.state !== 'activated' }),
                    (conn.state === 'activated' ? '停用' : '启用') + '已挂起，去待确认里点一下'),
                }, conn.state === 'activated' ? '停用' : '启用')
                : null)))),

        editing ? h(ConnectionEditor, { name: editing, busy, run, onClose: () => onEdit('') }) : null)
    }
    const CONNECTION_TYPE_CHOICES = [
      ['bridge', '网桥'],
      ['bond', '链路聚合'],
      ['vlan', 'VLAN'],
      ['wireguard', 'WireGuard'],
      ['ethernet', '以太网'],
      ['macvlan', 'macvlan'],
      ['dummy', '虚拟接口（dummy）'],
    ]
    function ConnectionCreateForm({ busy, run, onClose }) {
      const [type, setType] = React.useState('bridge')
      const [name, setName] = React.useState('')
      const [ifname, setIfname] = React.useState('')
      const [parent, setParent] = React.useState('')
      const [vlanId, setVlanId] = React.useState('10')
      const [method, setMethod] = React.useState('manual')
      const [addresses, setAddresses] = React.useState('')
      const [gateway, setGateway] = React.useState('')
      const [dns, setDns] = React.useState('')

      const needIfname = type === 'ethernet' || type === 'bridge' || type === 'bond' || type === 'wireguard'
      const needParent = type === 'vlan' || type === 'macvlan'
      const canSubmit = name.trim().length > 0 && !busy

      const submit = () => {
        const spec = { type, name: name.trim() }
        if (needIfname) spec.interfaceName = ifname.trim() || name.trim()
        if (needParent) spec.parent = parent.trim()
        if (type === 'vlan') spec.vlanId = Number(vlanId) || 0
        spec.patch = {
          method,
          addresses: linesOf(addresses),
          gateway: gateway.trim(),
          dns: linesOf(dns.replace(/,/g, ' ')).join(' ').split(/\s+/).filter(Boolean),
        }
        run(jpost('/net/connections/create', spec), '新建已挂起，去待确认里点一下')
      }

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '新建连接'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px', fontSize: 'var(--cm-f-xs)' } },
          '建完会立刻激活。team 需要 teamd，这台机没有，所以不在列表里。'),
        h('div', { 'data-cm-formrow': '' },
          field('类型', h('select', { 'data-cm-input': '', value: type, onChange: e => setType(e.target.value) },
            ...CONNECTION_TYPE_CHOICES.map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
          field('连接名', h('input', { 'data-cm-input': '', value: name, placeholder: '例如 br-lab', onChange: e => setName(e.target.value) }))),
        needIfname
          ? field('接口名（留空 = 用连接名）', h('input', { 'data-cm-input': '', value: ifname, placeholder: name || 'br-lab', onChange: e => setIfname(e.target.value) }))
          : null,
        needParent
          ? h('div', { 'data-cm-formrow': '' },
            field('挂在哪块网卡上', h('input', { 'data-cm-input': '', value: parent, placeholder: 'enp125s0f0', onChange: e => setParent(e.target.value) })),
            type === 'vlan'
              ? field('VLAN id', h('input', { 'data-cm-input': '', type: 'number', value: vlanId, onChange: e => setVlanId(e.target.value) }))
              : null)
          : null,
        h('div', { 'data-cm-formrow': '' },
          field('IPv4 方式', h('select', { 'data-cm-input': '', value: method, onChange: e => setMethod(e.target.value) },
            ...[['manual', '手动'], ['auto', '自动（DHCP）'], ['disabled', '关掉'], ['ignore', '不管']]
              .map(pair => h('option', { key: pair[0], value: pair[0] }, pair[1])))),
          field('网关', h('input', { 'data-cm-input': '', value: gateway, placeholder: '留空 = 不设', onChange: e => setGateway(e.target.value) }))),
        field('地址（每行一个，带前缀）', h('textarea', {
          'data-cm-input': '',
          rows: 2,
          value: addresses,
          placeholder: '10.99.0.1/24',
          onChange: e => setAddresses(e.target.value),
        })),
        field('DNS', h('input', { 'data-cm-input': '', value: dns, placeholder: '留空 = 不设', onChange: e => setDns(e.target.value) })),
        h('div', { 'data-cm-formrow': '', style: { marginTop: '10px' } },
          h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: !canSubmit, onClick: submit }, '创建（会挂起）'),
          h('button', { 'data-cm-btn': '', onClick: onClose }, '收起')))
    }

    function HostRoutesView({ hostNet }) {
      const data = hostNet.data
      if (!data || !data.ok) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-warn': '' }, hostNet.problem ? '读不到宿主网络：' + hostNet.problem : '读取中…'))
      }
      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '路由表（' + data.routes.length + '）'),
        h('table', { 'data-cm-table': '' },
          h('thead', null, h('tr', null,
            h('th', null, '目标'), h('th', null, '网关'), h('th', null, '网卡'), h('th', null, '来源'), h('th', null, 'metric'))),
          h('tbody', null, ...data.routes.map((route, index) => h('tr', { key: route.destination + '#' + index },
            h('td', { 'data-cm-mono': '' }, route.destination),
            h('td', { 'data-cm-mono': '', 'data-cm-dim': '' }, route.gateway || '—'),
            h('td', { 'data-cm-mono': '' }, route.device || '—'),
            h('td', { 'data-cm-dim': '' }, route.protocol || '—'),
            h('td', { 'data-cm-dim': '' }, route.metric ? String(route.metric) : '—')))))
      )
    }

    function ConnectionDnsForm({ connections, busy, run }) {
      const [picked, setPicked] = React.useState('')
      const [dns, setDns] = React.useState('')
      const usable = (connections || []).filter(item => item.device)
      const value = picked || (usable[0] ? usable[0].name : '')
      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '改某条连接的 DNS'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px', fontSize: 'var(--cm-f-xs)' } },
          '只动 NetworkManager 连接里的 ipv4.dns。改完那条连接要重启一次才生效，所以走待确认，主网卡会断一下。'),
        h('div', { 'data-cm-formrow': '' },
          h('select', {
            value,
            onChange: e => setPicked(e.target.value),
            'data-cm-input': '',
            style: { flex: '0 0 210px' },
          }, ...usable.map(item => h('option', { key: item.name, value: item.name }, item.name))),
          h('input', {
            'data-cm-input': '',
            placeholder: '1.1.1.1 8.8.8.8（空格隔开，留空 = 清空）',
            value: dns,
            onChange: e => setDns(e.target.value),
            style: { flex: '1 1 auto' },
          }),
          h('button', {
            'data-cm-btn': '',
            disabled: busy || !value,
            onClick: () => run(
              jpost('/net/connections/' + encodeURIComponent(value), {
                patch: { dns: dns.trim() ? dns.trim().split(/\s+/) : [] },
              }),
              '改 DNS 已挂起，去待确认里点一下'),
          }, '改 DNS')))
    }

    function FirewallPane() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const load = React.useCallback(async () => {
        setState({ loading: true, data: null, error: null })
        try {
          const value = await jget('/net/firewall')
          setState({ loading: false, data: value, error: null })
        } catch (e) {
          setState({ loading: false, data: null, error: e && e.message ? e.message : String(e) })
        }
      }, [])
      React.useEffect(() => { load() }, [load])
      if (state.loading) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-dim': '' }, '读 nft 规则中…'))
      if (state.error) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, state.error))
      const data = state.data
      if (!data || !data.ok) {
        return h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-warn': '' }, (data && data.reason) || '读不到防火墙。'),
          h('div', { 'data-cm-dim': '', style: { marginTop: '8px', fontSize: 'var(--cm-f-xs)' } },
            'nft 需要 root。本机 sudo -n 可用时才能读；读不到不代表没有规则。'))
      }
      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, 'nftables（' + data.tables.length + ' 张表）'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px', fontSize: 'var(--cm-f-xs)' } },
          '这里只读骨架。改防火墙能一下把自己关在外面，所以本面板不做写；要看全文用下面的「复制规则」。'),
        ...data.tables.map(table => h('div', { key: table.family + table.name, 'data-cm-netrow': '' },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('strong', null, table.name),
            h('span', { 'data-cm-dim': '' }, table.family),
            h('div', { 'data-cm-grow': '' }),
            h('span', { 'data-cm-dim': '' }, table.chains + ' 条链')),
          table.managedBy
            ? h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } }, '由 ' + table.managedBy + ' 管，别手改')
            : null)),
        data.raw
          ? h('button', {
            'data-cm-btn': '',
            onClick: () => downloadText('nft-ruleset.txt', data.raw),
          }, '复制规则全文')
          : null)
    }

    function DiagnosePane() {
      const [target, setTarget] = React.useState('')
      const [count, setCount] = React.useState(4)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const ping = async () => {
        const host = target.trim()
        if (!host) return
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          setResult(await jpost('/net/diagnose', { target: host, count }))
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '连通性诊断'),
        h('div', { 'data-cm-dim': '', style: { marginBottom: '8px', fontSize: 'var(--cm-f-xs)' } },
          '从这台机往外 ping。填 IP 或域名，不带参数。'),
        h('div', { 'data-cm-formrow': '' },
          h('input', {
            'data-cm-input': '',
            placeholder: '8.8.8.8 或 baidu.com',
            value: target,
            onChange: e => setTarget(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') ping() },
            style: { flex: '1 1 auto' },
          }),
          h('select', {
            value: String(count),
            onChange: e => setCount(Number(e.target.value)),
            'data-cm-input': '',
            style: { flex: '0 0 90px' },
          }, [1, 2, 4, 6, 10].map(n => h('option', { key: n, value: String(n) }, n + ' 个包'))),
          h('button', { 'data-cm-btn': '', disabled: busy || !target.trim(), onClick: ping }, busy ? 'ping 中…' : 'ping')),
        error ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px' } }, error) : null,
        result
          ? h('div', { style: { marginTop: '10px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(Dot, { tone: result.ok ? 'on' : 'off' }),
              h('strong', null, result.target),
              h('span', { 'data-cm-dim': '' }, result.ok ? '通' : '不通')),
            result.rtt
              ? h('div', { 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-sm)', marginTop: '4px' } },
                'rtt min/avg/max = ' + result.rtt.min + ' / ' + result.rtt.avg + ' / ' + result.rtt.max + ' ms',
                result.lossPercent ? ' · 丢包 ' + result.lossPercent + '%' : '')
              : h('div', { 'data-cm-dim': '', style: { marginTop: '4px', fontSize: 'var(--cm-f-sm)' } }, result.reason || ''),
            h('pre', { 'data-cm-mono': '', style: { margin: '6px 0 0', fontSize: 'var(--cm-f-xs)', whiteSpace: 'pre-wrap' } },
              result.output || ''))
          : null)
    }

    function HostDnsView({ hostNet, busy, run }) {
      const data = hostNet.data
      const dns = data && data.dns ? data.dns : []
      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '系统 DNS（/etc/resolv.conf）'),
          dns.length === 0
            ? h('div', { 'data-cm-dim': '' }, '没有配置 nameserver。')
            : h('div', { 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-sm)' } }, dns.join('\n'))),
        h(ConnectionDnsForm, { connections: data && data.connections ? data.connections : [], busy, run }))
    }

    function ImagesPane({ nodeId, onToast, onPending }) {
      const [items, setItems] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [reference, setReference] = React.useState('')
      const [confirmTarget, setConfirmTarget] = React.useState(null)
      const [searching, setSearching] = React.useState(false)
      const [found, setFound] = React.useState(null)
      const [updates, setUpdates] = React.useState(null)
      const [checking, setChecking] = React.useState(false)

      const load = React.useCallback(async () => {
        if (!nodeId) {
          setLoading(false)
          return
        }
        try {
          const value = await jget('/images?node=' + encodeURIComponent(nodeId))
          setItems(Array.isArray(value) ? value : [])
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [nodeId])

      React.useEffect(() => { load() }, [load])

      async function pull() {
        const name = reference.trim()
        if (!name) return
        setBusy(true)
        try {
          await jpost('/images/pull', { node: nodeId, reference: name })
          onToast && onToast('已拉取 ' + name)
          setReference('')
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: '拉取失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setBusy(false)
        }
      }

      /** 查更新：只比 digest。没装 skopeo 就是 unknown，不给假的「已是最新」。 */
      async function checkUpdates() {
        setChecking(true)
        try {
          const value = await jget('/image-updates?node=' + encodeURIComponent(nodeId) + '&limit=12')
          const map = {}
          for (const row of (value && value.items) || []) map[row.reference] = row
          setUpdates({ map, summary: value })
        } catch (e) {
          setUpdates({ map: {}, summary: { ok: false, reason: e && e.message ? e.message : String(e) } })
        } finally {
          setChecking(false)
        }
      }

      const updateOf = item => (updates && updates.map ? updates.map[item.reference] : null)
      const UPDATE_LABEL = { current: '最新', stale: '有新版', unknown: '比不了' }
      const UPDATE_TONE = { current: 'on', stale: 'warn', unknown: 'off' }

      /** 去 Docker Hub 搜一下：不通就直说，别挡着直接填名字拉取。 */
      async function search() {
        const keyword = reference.trim()
        if (!keyword) { onToast && onToast({ bad: true, text: '先填个关键词，比如 nginx。' }); return }
        setSearching(true)
        try {
          const value = await jget('/images/search?q=' + encodeURIComponent(keyword))
          setFound(value && typeof value === 'object' ? value : { ok: false, results: [], reason: '返回格式不对。' })
        } catch (e) {
          setFound({ ok: false, results: [], reason: e && e.message ? e.message : String(e) })
        } finally {
          setSearching(false)
        }
      }

      async function remove(name) {
        setBusy(true)
        try {
          const result = await jpost('/images/delete', { node: nodeId, reference: name })
          if (result && result.status === 'pending') {
            onToast && onToast('已挂起，在下面「待确认」里点确认：' + (result.summary || ''))
            if (onPending) onPending()
          } else {
            onToast && onToast('已删除 ' + name)
          }
          setConfirmTarget(null)
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: '删除失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setBusy(false)
        }
      }

      const searchItems = found && found.ok
        ? found.results.map(row => h('button', {
          key: row.name,
          'data-cm-btn': '',
          style: { justifyContent: 'flex-start', textAlign: 'left', fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 'var(--cm-f-xs)' },
          onClick: () => { setReference(row.name); setFound(null) },
        }, row.name + (row.official ? '  ★官方' : '') + (row.pulls ? '  ' + row.pulls + ' pulls' : '') +
          (row.description ? '  — ' + row.description.slice(0, 40) : '')))
        : []
      const searchView = !found
        ? null
        : !found.ok
          ? h('div', { 'data-cm-warn': '' }, '搜不了：' + (found.reason || '未知原因'))
          : searchItems.length === 0
            ? h('div', { 'data-cm-dim': '' }, 'Docker Hub 上没搜到「' + reference.trim() + '」。')
            : h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)' } },
              '点一个填进上面的框：',
              h('div', { style: { marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' } }, ...searchItems))

      if (!nodeId) return h('div', { 'data-cm-empty': '' }, '没有可用的 Podman 节点。')

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '拉取镜像'),
          h('div', { 'data-cm-line': '' },
            h('input', {
              'data-cm-input': '',
              style: { flex: '1', minWidth: '220px' },
              placeholder: 'docker.io/library/alpine:latest',
              value: reference,
              onChange: event => setReference(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') pull() },
            }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy || !reference.trim(), onClick: pull }, busy ? '处理中…' : '拉取'),
            h('button', { 'data-cm-btn': '', disabled: searching || !reference.trim(), onClick: search }, searching ? '搜…' : '搜一下')),
          h('div', { 'data-cm-hintbox': '' }, '镜像名要带 registry 或本地能解析到；拉取会走网络，慢的话多等一会。「搜一下」是去 Docker Hub 按关键词找，不通也不挡你直接填名字。'),
          searchView ? h('div', { style: { marginTop: '8px' } }, searchView) : null),
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '镜像（' + items.length + '）'),
            h('div', { 'data-cm-grow': '' }),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: load }, '刷新'),
            h('button', { 'data-cm-btn': '', disabled: checking, onClick: checkUpdates }, checking ? '问仓库…' : '查更新')),
          updates && updates.summary && updates.summary.items
            ? h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginBottom: '6px' } },
              '查了 ' + updates.summary.checked + ' 个镜像，' + updates.summary.stale + ' 个有新版' +
              (updates.summary.skipped > 0 ? '，还有 ' + updates.summary.skipped + ' 个这轮没查（一次最多 12 个）' : '') +
              (updates.summary.unknown > 0 ? '，' + updates.summary.unknown + ' 个比不了' : '') + '。' +
              (updates.summary.hasSkopeo ? '' : ' 本机没装 skopeo，远端 digest 问不到 —— 装上才能真的比。'))
            : null,
          error ? h('div', { 'data-cm-warn': '' }, error) : null,
          loading
            ? h('div', { 'data-cm-empty': '' }, '读取中…')
            : items.length === 0
              ? h('div', { 'data-cm-empty': '' }, '还没有镜像。')
              : h('table', { 'data-cm-table': '' },
                h('thead', null, h('tr', null,
                  h('th', null, '镜像'), h('th', null, '标签'), h('th', null, '大小'), h('th', null, '创建'),
                  h('th', null, '更新'), h('th', null, ''))),
                h('tbody', null, ...items.map(item => h('tr', { key: item.reference },
                  h('td', null, item.repository),
                  h('td', { 'data-cm-dim': '' }, item.tag),
                  h('td', null, item.size != null ? formatBytesShort(item.size) : '—'),
                  h('td', { 'data-cm-dim': '' }, item.created ? String(item.created).replace('T', ' ').slice(0, 19) : '—'),
                  h('td', null, updateOf(item)
                    ? h('span', { 'data-cm-facts': '', title: updateOf(item).reason || '' },
                      h(Dot, { tone: UPDATE_TONE[updateOf(item).state] || 'off' }),
                      UPDATE_LABEL[updateOf(item).state] || updateOf(item).state)
                    : h('span', { 'data-cm-dim': '' }, '—')),
                  h('td', null, h('button', {
                    'data-cm-btn': '',
                    'data-danger': '',
                    disabled: busy,
                    onClick: () => setConfirmTarget(item.reference),
                  }, '删除')))))),
          confirmTarget
            ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', null, '删除镜像 ' + confirmTarget + '？还有容器在用它时会失败。确认后还要在下面「待确认」点一次。'),
              h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => remove(confirmTarget) }, '确认删除'),
              h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setConfirmTarget(null) }, '算了'))
            : null))
    }

    /* ── LXC 页：镜像缓存 ── */

    function LxcImagesPane({ nodeId, onToast, onPending }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [confirmTarget, setConfirmTarget] = React.useState(null)

      const load = React.useCallback(async () => {
        if (!nodeId) {
          setLoading(false)
          return
        }
        try {
          const value = await jget('/images?node=' + encodeURIComponent(nodeId))
          // LXC 返回的是对象（不是 Podman 那种数组），形状不对就当空
          setData(value && typeof value === 'object' && !Array.isArray(value) ? value : { images: [], count: 0, total: 0 })
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [nodeId])

      React.useEffect(() => { load() }, [load])

      async function remove(name) {
        setBusy(true)
        try {
          const result = await jpost('/images/delete', { node: nodeId, reference: name })
          onToast && onToast(result && result.status === 'pending'
            ? '已挂起，去下面「待确认」点确认才会真删。'
            : '已删除 ' + name)
          setConfirmTarget(null)
          onPending && onPending()
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: '删除失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setBusy(false)
        }
      }

      if (loading) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-dim': '' }, '读取中…'))
      if (error) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, error))
      if (!nodeId) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, '没有可用的 LXC 节点。'))

      const images = Array.isArray(data && data.images) ? data.images : []
      const root = (data && data.root) || ''
      const totalText = humanBytes(data && data.total) || '0'

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '系统镜像缓存'),
          h('div', { 'data-cm-dim': '', style: { marginBottom: '8px' } },
            'dsh 建的 LXC 容器都从这里取系统镜像。第一次建某个发行版会下载一份存下来，之后就是秒级。'),
          h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)', marginBottom: '10px', wordBreak: 'break-all' } },
            root + '　共 ' + (data && data.count ? data.count : 0) + ' 份 / ' + totalText),
          images.length === 0
            ? h('div', { 'data-cm-dim': '' }, '还没有缓存。建一个 LXC 容器就会在这里落一份。')
            : h('div', null, images.map(item => h('div', {
              key: item.name,
              style: { padding: '8px 0', borderTop: '1px solid var(--cm-line)' },
            },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('strong', null, item.name),
                item.expired ? h('span', { 'data-cm-tag': '', 'data-warn': '' }, '已过期') : null,
                h('div', { 'data-cm-grow': '' }),
                h('span', { 'data-cm-dim': '', 'data-cm-mono': '' }, item.size || ''),
                confirmTarget === item.name
                  ? h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => remove(item.name) },
                    busy ? '删除中…' : '确认删')
                  : h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => setConfirmTarget(item.name) }, '删除')),
              h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '2px' } },
                [item.distro + ' ' + item.release + ' · ' + item.arch,
                  item.expiry ? (item.expired ? '缓存已过期，下次建会重新下载' : '有效到 ' + new Date(item.expiry * 1000).toLocaleDateString()) : '',
                  item.mtime ? '下载于 ' + new Date(item.mtime).toLocaleString() : ''].filter(Boolean).join('　')))))),
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '说明'),
          h('div', { 'data-cm-kv': '' },
            h('b', null, '放哪'),
            h('span', { 'data-cm-mono': '' }, root || '（未配置）'),
            h('b', null, '过期'),
            h('span', null, 'LXC 模板给每份缓存标了过期时间，到期后建容器会重新下载。'),
            h('b', null, '删除'),
            h('span', null, '删了下次建这个发行版要重新下一遍，所以走「待确认」。'))))
    }

    /* ── LXC 页：存储 ── */

    function LxcStoragePane({ nodeId }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        if (!nodeId) {
          setLoading(false)
          return () => { alive = false }
        }
        jget('/lxc/storage?node=' + encodeURIComponent(nodeId))
          .then(value => { if (alive) { setData(value); setError(null) } })
          .catch(e => { if (alive) setError(e && e.message ? e.message : String(e)) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [nodeId])

      if (loading) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-dim': '' }, '读取中…'))
      if (error) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, error))
      if (!nodeId) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, '没有可用的 LXC 节点。'))

      const disk = data && data.disk
      const images = (data && data.images) || { count: 0, size: '—' }
      const containers = Array.isArray(data && data.containers) ? data.containers : []
      // humanBytes 会四舍五入，formatBytesShort 只认整倍数（8589934593 会原样吐数字）
      const containersTotal = humanBytes(data && data.containersTotal) || '—'

      return h('div', null,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '占位'),
          h('div', { 'data-cm-kv': '' },
            h('b', null, '镜像缓存'),
            h('span', null, images.count + ' 份 / ' + (images.size || '—')),
            h('b', null, '容器磁盘'),
            h('span', null, containers.length + ' 个容器 / ' + containersTotal),
            h('b', null, '分区'),
            h('span', null, disk
              ? `${humanBytes(disk.used)} / ${humanBytes(disk.total)}（已用 ${disk.percent}%，剩 ${humanBytes(disk.free)}）`
              : '读不到'),
            h('b', null, '根目录'),
            h('span', { 'data-cm-mono': '' }, (data && data.root) || ''))) ,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '每个容器的虚拟磁盘'),
          containers.length === 0
            ? h('div', { 'data-cm-dim': '' }, '还没有容器。')
            : h('div', null, containers.map(item => h('div', {
              key: item.name,
              style: { padding: '8px 0', borderTop: '1px solid var(--cm-line)' },
            },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('strong', null, item.name),
                h('div', { 'data-cm-grow': '' }),
                h('span', { 'data-cm-mono': '', 'data-cm-dim': '' }, item.size || humanBytes(item.bytes))),
              h('div', { 'data-cm-dim': '', 'data-cm-mono': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '2px' } },
                (item.disks || []).map(entry => entry.file + ' ' + entry.size).join('　')))))))
    }

    /**
     * LXC 备份：导出 / 导入 / 归档管理。
     *
     * 这里要老实交代一件事故级的事：ext4 + loop 后端上，导出的是一整份 rootfs，
     * 一个 8G 容器就是 8G 归档。所以页面顶部先把这件事写出来，别让人以为「点一下很便宜」。
     */
    function LxcBackupPane({ nodeId, containers, onToast, onPending }) {
      const [items, setItems] = React.useState([])
      const [dir, setDir] = React.useState('')
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [pick, setPick] = React.useState('')
      const [instanceOnly, setInstanceOnly] = React.useState(true)
      const [importFile, setImportFile] = React.useState('')
      const [importName, setImportName] = React.useState('')
      const [policy, setPolicy] = React.useState(null)
      const [policyError, setPolicyError] = React.useState('')
      const [due, setDue] = React.useState([])
      const [events, setEvents] = React.useState([])

      const loadPolicy = React.useCallback(async () => {
        try {
          const value = await jget('/backup')
          setPolicy(value.policy)
          setDue(Array.isArray(value.due) ? value.due : [])
          setEvents(Array.isArray(value.events) ? value.events : [])
          setPolicyError(value.warn || '')
        } catch (err) {
          setPolicyError(err && err.message ? err.message : String(err))
        }
      }, [])

      React.useEffect(() => { loadPolicy() }, [loadPolicy])

      async function savePolicy(patch) {
        try {
          const saved = await jpost('/backup/policy', patch)
          setPolicy(saved)
          setPolicyError('')
          await loadPolicy()
          onToast && onToast('备份策略已保存')
        } catch (err) {
          setPolicyError('存不了：' + (err && err.message ? err.message : String(err)))
        }
      }

      async function runBackupNow() {
        setBusy(true)
        try {
          const result = await jpost('/backup/run', {})
          const bits = []
          if (result.skipped) bits.push('跳过了：' + result.skipped)
          if (Array.isArray(result.started) && result.started.length) bits.push('导出了 ' + result.started.join('、'))
          if (Array.isArray(result.removed) && result.removed.length) bits.push('删了 ' + result.removed.length + ' 份旧归档')
          onToast && onToast(bits.join('；') || '这轮没有到期的东西')
          await loadPolicy()
          await load()
        } catch (err) {
          onToast && onToast({ bad: true, text: '跑不了：' + (err && err.message ? err.message : String(err)) })
        } finally {
          setBusy(false)
        }
      }

      function toggleTarget(name) {
        if (!policy) return
        const current = Array.isArray(policy.targets) ? policy.targets : []
        const next = current.includes(name) ? current.filter(item => item !== name) : [...current, name]
        savePolicy({ targets: next })
      }

      const load = React.useCallback(async () => {
        if (!nodeId) {
          setLoading(false)
          return
        }
        try {
          const value = await jget('/lxc/exports?node=' + encodeURIComponent(nodeId)
            + (dir.trim() ? '&dir=' + encodeURIComponent(dir.trim()) : ''))
          setItems(Array.isArray(value.files) ? value.files : [])
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [nodeId, dir])

      React.useEffect(() => { load() }, [load])

      async function doExport() {
        if (!nodeId) return
        if (!pick) { onToast && onToast({ bad: true, text: '先选一个容器。' }); return }
        setBusy(true)
        try {
          const result = await jpost('/lxc/export', {
            node: nodeId,
            name: pick,
            dir: dir.trim() || undefined,
            instanceOnly,
          })
          const queued = noteJobResult(result)
          onToast && onToast(queued || '已导出')
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      async function doImport() {
        if (!nodeId) return
        const file = importFile.trim()
        const name = importName.trim()
        if (!file || !name) { onToast && onToast({ bad: true, text: '归档路径与新容器名都要给。' }); return }
        setBusy(true)
        try {
          const result = await jpost('/lxc/import', { node: nodeId, file, name })
          const queued = noteJobResult(result)
          onToast && onToast(queued || '已导入')
          setImportFile('')
          setImportName('')
        } catch (e) {
          onToast && onToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      async function removeArchive(name) {
        if (!nodeId) return
        setBusy(true)
        try {
          const result = await jpost('/lxc/exports/delete', { node: nodeId, name, dir: dir.trim() || undefined })
          if (result && result.status === 'pending') {
            onPending && onPending()
            onToast && onToast('删除已挂起 —— 去页面底部「待确认」点一下。')
          } else {
            onToast && onToast('已删除归档')
            await load()
          }
        } catch (e) {
          onToast && onToast({ bad: true, text: e && e.message ? e.message : String(e) })
        } finally {
          setBusy(false)
        }
      }

      if (!nodeId) return h('div', { 'data-cm-card': '' }, h('div', { 'data-cm-warn': '' }, '没有可用的 LXC 节点（要装 root helper）。'))

      /** 归档表单独提出来：一行五个 td 挤在 JSX 里，括号一多就看不清谁闭谁。 */
      function archiveTable() {
        const rows = items.map(entry => h('tr', { key: entry.name },
          h('td', { style: { wordBreak: 'break-all' } }, entry.name),
          h('td', { 'data-cm-mono': '' }, humanBytes(entry.bytes) || '—'),
          h('td', { 'data-cm-dim': '' }, clockText(entry.at)),
          h('td', null, h('div', { 'data-cm-line': '' },
            h('button', {
              'data-cm-btn': '',
              disabled: busy,
              onClick: () => {
                setImportFile(entry.path)
                setImportName(String(entry.name).replace(/\.tar.*$/, ''))
              },
            }, '导入这个'),
            h('button', {
              'data-cm-btn': '',
              'data-danger': '',
              disabled: busy,
              onClick: () => removeArchive(entry.name),
            }, '删除')))))
        return h('table', { 'data-cm-table': '' },
          h('thead', null, h('tr', null,
            h('th', null, '归档'), h('th', null, '大小'), h('th', null, '时间'), h('th', null, ''))),
          h('tbody', null, ...rows))
      }

      const backupCard = !policy
        ? null
        : h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-line': '' },
            h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0, margin: 0 } }, '自动备份'),
            h('div', { 'data-cm-grow': '' }),
            h('button', {
              'data-cm-btn': '',
              disabled: busy,
              ...(policy.enabled ? { 'data-primary': '' } : {}),
              onClick: () => savePolicy({ enabled: !policy.enabled }),
            }, policy.enabled ? '已开启，点一下关掉' : '关着的，点一下开启')),
          h('div', { 'data-cm-dim': '', style: { marginTop: '4px' } },
            '到点自动导出选中的容器，并按「留几份 / 留几天」删旧归档。只做 LXC —— Podman 的备份正解是 compose 文件加卷，不假装打包 rootfs。'),
          h('div', { 'data-cm-facts': '', style: { marginTop: '8px', flexWrap: 'wrap' } },
            h('span', { 'data-cm-dim': '' }, '要备份的容器：'),
            containers.length === 0
              ? h('span', { 'data-cm-dim': '' }, '（没有 LXC 容器）')
              : containers.map(container => h('button', {
                key: container.name,
                'data-cm-chip': '',
                ...((policy.targets || []).includes(container.name) ? { 'data-on': '' } : {}),
                onClick: () => toggleTarget(container.name),
              }, container.name))),
          h('div', { 'data-cm-formrow': '', style: { marginTop: '8px' } },
            h('label', { 'data-cm-dim': '' }, '每 ',
              h('input', {
                'data-cm-input': '',
                style: { width: '70px' },
                type: 'number',
                min: 1,
                max: 720,
                value: policy.everyHours,
                onChange: event => setPolicy({ ...policy, everyHours: Number(event.target.value) || 1 }),
                onBlur: () => savePolicy({ everyHours: policy.everyHours }),
              }), ' 小时一次'),
            h('label', { 'data-cm-dim': '' }, '留 ',
              h('input', {
                'data-cm-input': '',
                style: { width: '70px' },
                type: 'number',
                min: 1,
                max: 64,
                value: policy.keepCount,
                onChange: event => setPolicy({ ...policy, keepCount: Number(event.target.value) || 1 }),
                onBlur: () => savePolicy({ keepCount: policy.keepCount }),
              }), ' 份'),
            h('label', { 'data-cm-dim': '' }, '且不超过 ',
              h('input', {
                'data-cm-input': '',
                style: { width: '70px' },
                type: 'number',
                min: 1,
                max: 3650,
                value: policy.keepDays,
                onChange: event => setPolicy({ ...policy, keepDays: Number(event.target.value) || 1 }),
                onBlur: () => savePolicy({ keepDays: policy.keepDays }),
              }), ' 天'),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: runBackupNow }, busy ? '跑…' : '现在跑一轮')),
          policy.enabled && (policy.targets || []).length === 0
            ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } }, '开着但一个容器都没选，等于没开。上面点容器名加进来。')
            : null,
          due.length > 0
            ? h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '6px' } },
              '现在到期的：' + due.map(item => item.name + (item.lastAt ? '（上次 ' + clockText(item.lastAt) + '）' : '（还没导过）')).join('、'))
            : h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '6px' } }, '现在没有到期的。'),
          policyError ? h('div', { 'data-cm-warn': '', style: { marginTop: '6px' } }, policyError) : null,
          events.length > 0
            ? h('div', { 'data-cm-dim': '', style: { fontSize: 'var(--cm-f-xs)', marginTop: '6px' } },
              '最近：' + events.slice(-3).map(event => event.text).join(' / '))
            : null)

      return h('div', null,
        backupCard,
        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '导出容器'),
          h('div', { 'data-cm-hintbox': '', style: { marginBottom: '8px' } },
            '导出的是整份 rootfs：ext4 + loop 上一个 8G 容器就是 8G 归档，慢也占盘。',
            '归档落在宿主的备份目录里，容器本身不动。'),
          error ? h('div', { 'data-cm-warn': '', style: { marginBottom: '8px' } }, error) : null,
          h('div', { 'data-cm-formrow': '' },
            h('select', {
              'data-cm-select': '',
              value: pick,
              disabled: busy,
              onChange: event => setPick(event.target.value),
            },
              h('option', { value: '' }, '选一个容器…'),
              ...containers.map(container => h('option', { key: container.name, value: container.name },
                container.name + (container.state === 'running' ? '（运行中）' : '')))),
            h('input', {
              'data-cm-input': '',
              style: { flex: '1', minWidth: '200px' },
              placeholder: '归档目录（留空 = 默认 /var/lib/dsh-container-manager/exports）',
              value: dir,
              onChange: event => setDir(event.target.value),
            }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy || !pick, onClick: doExport },
              busy ? '处理中…' : '导出'),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => load() }, '刷新')),
          h('label', { 'data-cm-checkline': '' },
            h('input', {
              type: 'checkbox',
              checked: instanceOnly,
              onChange: event => setInstanceOnly(event.target.checked),
            }),
            '只导实例，不带快照（推荐）')),

        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '从归档导入'),
          h('div', { 'data-cm-hintbox': '', style: { marginBottom: '8px' } },
            '归档必须是 lxc export 产出的 .tar / .tar.gz / .tar.xz；导入后的容器是停止状态，名字不能和现有的重。'),
          h('div', { 'data-cm-formrow': '' },
            h('input', {
              'data-cm-input': '',
              style: { flex: '2', minWidth: '240px' },
              placeholder: '归档绝对路径，例如 /var/lib/dsh-container-manager/exports/xxx.tar.gz',
              value: importFile,
              onChange: event => setImportFile(event.target.value),
            }),
            h('input', {
              'data-cm-input': '',
              placeholder: '新容器名',
              value: importName,
              onChange: event => setImportName(event.target.value),
            }),
            h('button', { 'data-cm-btn': '', 'data-primary': '', disabled: busy, onClick: doImport },
              busy ? '处理中…' : '导入'))),

        h('div', { 'data-cm-card': '' },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '归档（' + items.length + '）'),
          loading
            ? h('div', { 'data-cm-dim': '' }, '读取中…')
            : (items.length === 0
              ? h('div', { 'data-cm-dim': '' }, '这个目录里还没有归档。')
              : archiveTable())))
    }

    function VolumesPane({ nodeId, onToast, onPending }) {
      const [items, setItems] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [confirmTarget, setConfirmTarget] = React.useState(null)

      const load = React.useCallback(async () => {
        if (!nodeId) {
          setLoading(false)
          return
        }
        try {
          const value = await jget('/volumes?node=' + encodeURIComponent(nodeId))
          setItems(Array.isArray(value) ? value : [])
          setError(null)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      }, [nodeId])

      React.useEffect(() => { load() }, [load])

      async function remove(name) {
        setBusy(true)
        try {
          const result = await jpost('/volumes/delete', { node: nodeId, name })
          if (result && result.status === 'pending') {
            onToast && onToast('已挂起，在下面「待确认」里点确认：' + (result.summary || ''))
            if (onPending) onPending()
          } else {
            onToast && onToast('已删除卷 ' + name)
          }
          setConfirmTarget(null)
          await load()
        } catch (e) {
          onToast && onToast({ bad: true, text: '删除失败：' + (e && e.message ? e.message : String(e)) })
        } finally {
          setBusy(false)
        }
      }

      if (!nodeId) return h('div', { 'data-cm-empty': '' }, '没有可用的 Podman 节点。')

      return h('div', { 'data-cm-card': '' },
        h('div', { 'data-cm-line': '', style: { marginBottom: '8px' } },
          h('div', { 'data-cm-ghead': '', style: { paddingLeft: 0 } }, '卷（' + items.length + '）'),
          h('div', { 'data-cm-grow': '' }),
          h('button', { 'data-cm-btn': '', disabled: busy, onClick: load }, '刷新')),
        h('div', { 'data-cm-hintbox': '', style: { marginBottom: '8px' } },
          'compose 项目里的「命名卷」会出现在这里；bind mount 用的是宿主目录，不在这。'),
        error ? h('div', { 'data-cm-warn': '' }, error) : null,
        loading
          ? h('div', { 'data-cm-empty': '' }, '读取中…')
          : items.length === 0
            ? h('div', { 'data-cm-empty': '' }, '还没有卷。')
            : h('table', { 'data-cm-table': '' },
              h('thead', null, h('tr', null,
                h('th', null, '名字'), h('th', null, '驱动'), h('th', null, '挂载点'), h('th', null, ''))),
              h('tbody', null, ...items.map(item => h('tr', { key: item.name },
                h('td', null,
                  item.name,
                  item.anonymous ? h('span', { 'data-cm-tag': '', 'data-warn': '', style: { marginLeft: '6px' } }, '匿名') : null),
                h('td', { 'data-cm-dim': '' }, item.driver || '—'),
                h('td', { 'data-cm-dim': '', style: { wordBreak: 'break-all' } }, item.mountpoint || '—'),
                h('td', null, h('button', {
                  'data-cm-btn': '',
                  'data-danger': '',
                  disabled: busy,
                  onClick: () => setConfirmTarget(item.name),
                }, '删除')))))),
        confirmTarget
          ? h('div', { 'data-cm-warn': '', style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, '删除卷 ' + confirmTarget + '？里面的数据会一起没，找不回来。'),
            h('button', { 'data-cm-btn': '', 'data-danger': '', disabled: busy, onClick: () => remove(confirmTarget) }, '确认删除'),
            h('button', { 'data-cm-btn': '', disabled: busy, onClick: () => setConfirmTarget(null) }, '算了'))
          : null)
    }

    function ContainerIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z' }),
        h('path', { d: 'M4 7.5 12 12l8-4.5M12 12v9' }),
        h('circle', { cx: 19.2, cy: 5.2, r: 2.2, fill: 'var(--dsw-alias-state-success-primary,#22c55e)', stroke: 'none' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-container-manager')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-container-manager: 面板样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel))

        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          label: () => '容器',
        }, ContainerIcon))
      },
    }
  },
})
