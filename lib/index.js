/**
 * dsh-container-manager —— host 半入口
 *
 * 三块：
 *   1. 10 个 AI 工具（只读 + 安全动作 + 创建；删除/改配置走待确认）
 *   2. 一段系统提示词：把「这台机器是什么情况、危险操作怎么走」写进模型上下文
 *   3. /api/container-manager：面板的数据与动作接口
 *
 * 浏览器半在 ../client.js（左侧「容器」主面板）。
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { PREFIX, createApi } from './api.js'
import { createActions } from './actions.js'
import { createAudit } from './audit.js'
import { createComposeService } from './compose/service.js'
import { createConfigStore, paths } from './config.js'
import { createNodeRegistry } from './nodes.js'
import { createPendingStore } from './pending.js'
import { createTerminalService } from './terminal.js'
import { registerTools } from './tools.js'

export const name = 'dsh-container-manager'

const INSTALL_SCRIPT = fileURLToPath(new URL('../helper/install-helper.sh', import.meta.url))
const PACKAGE = createRequire(import.meta.url)('../package.json')

function logLine(message) {
  try {
    process.stdout.write('[container-manager] ' + String(message) + '\n')
  } catch {
    // 写不出去不影响功能
  }
}

const PROMPT_LINES = [
  '## 容器台（dsh-container-manager）',
  '',
  '这台机器上有两套容器运行时可以管：',
  '',
  '- **本机 Podman**（节点 local-podman）：rootless、netavark 后端。能 list / inspect / logs /',
  '  start / stop / restart / pause / unpause / create / delete，能建 bridge 网络、把容器接入或移出网络，',
  '  能用 container_limits 改内存与 CPU 上限，用 container_stats 看实时占用（CPU/内存/PIDs + 宿主负载），',
  '  用 container_rename 改名，用 container_commit 把容器存成镜像（这条走挂起）。',
  '  rootless 的限制是真的：静态 IP、1024 以下的宿主端口、rootful 的东西不要假装能做到，',
  '  报错就如实转述。**这台机的 podman 4.3.1 在 rootless 下不写 cgroup 限制**：',
  '  `podman update --memory` 会返回成功但 memory.max 仍是 max，插件会检测到并报错 —— 照实转给用户，',
  '  别把「命令返回 0」说成「限制生效了」。',
  '- **本机 LXC**（节点 local-lxc）：必须装 root helper（dsh-lxcd）。没装时工具会返回',
  '  HELPER_DOWN 和一条安装命令 —— 把命令给用户，不要让用户以为你在管 LXC。',
  '  装了就能 container_create（kind=lxc，拉 images.linuxcontainers.org 的 rootfs，可能几分钟）、',
  '  用 container_config 改开机自启与内存上限。',
  '',
  '### 创建不是危险操作',
  '',
  '- container_create 直接执行、直接返回结果，不挂起。建完容器会自动启动（LXC 可用 start:false 关掉）。',
  '- 创建前先确认镜像名/发行版版本是对的、端口没被占；建完用 container_inspect 确认状态，别凭猜汇报。',
  '',
  '### 危险操作怎么走',
  '',
  '- delete（LXC 侧叫 destroy）、网络 create/remove/connect/disconnect、改 LXC 网卡配置、',
  '  改 LXC 启动项：这些一律返回 {status:"pending", token, message}。**这不是失败，是挂起**。',
  '- 你必须告诉用户：「去左侧『容器』面板的『待确认』里点一下」。AI 没有确认通道，',
  '  不要重复发起同一条操作，不要试图绕过，也不要自己宣布已经完成。',
  '- 用户可以拒绝或让它过期（默认 10 分钟）；过期后要重新发起。',
  '',
  '### compose 项目（推荐路径）',
  '',
  '- 容器分组用 podman-compose：根目录（默认 /opt/dsh-container/podman）下每个一级子目录是一个项目，',
  '  目录里必须有一份 compose 文件（compose.yaml / docker-compose.yml 等）。',
  '- 读：compose_projects 列表，compose_inspect 看详情与 YAML 原文。',
  '- 启停：compose_action op=up / restart / logs；op=down / adopt 会停或删容器，走挂起。',
  '- 改端口：compose_set_ports（写回 YAML、保留注释、自动备份），改完要 op=up 才生效。',
  '  这是 cockpit-podman 做不到的事，端口不需要重建容器也能改。',
  '- podman-compose 没装就先 compose_action op=install-runtime（要联网，慢）；装不上时降级为只读，',
  '  别假装能 up。up 之前会自动预检宿主端口，冲突会直接返回原因。',
  '',
  '### LXC 的快照 / 克隆 / 挂载点',
  '',
  '- lxc_snapshot op=list 只读；create / restore / delete 都动 rootfs，走挂起。',
  '  ext4 上快照是整份复制，占空间也慢，建之前提醒用户。',
  '- lxc_clone 直接执行（源容器必须先停）。lxc_mounts op=set 会改宿主上的 config，走挂起。',
  '',
  '### 干活顺序',
  '',
  '1. 先 container_nodes 看谁可用（不可用就别往下走）。',
  '2. 再 container_list / compose_projects / container_inspect / container_logs 读现状。',
  '3. 要动手时用 container_action / container_create / container_limits / container_config /',
  '   container_rename / container_commit / network_manage / compose_action / compose_set_ports /',
  '   lxc_snapshot / lxc_mounts；危险动作交代清楚「已在面板挂起」。',
  '   container_stats 单次要 1~2 秒，别连着刷；要趋势就隔几秒取一次。',
  '4. 动完再用只读工具确认结果，别凭想象汇报。',
  '### 宿主网络（注意别把本机弄断网）',
  '',
  '- 这台机的网络全由 NetworkManager 管（主网卡 DHCP，wgjump 是 NM 托管的 WireGuard）；',
  '  容器网络是 podman netavark；防火墙是纯 nftables（没有 ufw / firewalld）。',
  '- 看现状用 network_host（op=interfaces / routes / dns / connections / firewall / diagnose），全只读。',
  '- 改宿主配置用 network_host_apply（DNS / 静态 IP / 启停连接）：一律返回 pending，',
  '  并会重启那条连接 —— 远程连接会断一下。交代清楚「已挂起」，别重复发起。',
  '- lxcbr0 / docker0 这类 externally 托管的连接改不动，如实转述报错。',
  '',  '5. 别拿用户的业务容器做实验：要验证就用新建的临时容器。',
]

const PROMPT = PROMPT_LINES.join('\n')

/**
 * 构造请求校验。
 * 优先用 Connection 的 Host/Origin + 浏览器凭证；没有 Connection 时退到严格的本机判断。
 */
function makeVerify(ctx) {
  function connection() {
    try {
      if (typeof ctx.get === 'function') return ctx.get('connection')
      return ctx.connection
    } catch {
      return undefined
    }
  }

  return function verify(req) {
    const conn = connection()
    if (conn && typeof conn.requestRejection === 'function') {
      try {
        const rejection = conn.requestRejection({ headers: req.headers })
        if (rejection) return { ok: false, status: rejection, reason: 'Connection 拒绝（HTTP ' + rejection + '）。刷新页面试试。' }
        return { ok: true }
      } catch (error) {
        return { ok: false, status: 401, reason: '认证失败：' + (error && error.message ? error.message : String(error)) }
      }
    }

    // 没有 Connection 的部署（headless / 精简组合）：只接受本机 Host，拒绝跨站 Origin。
    const hostHeader = String(req.headers.host ?? '').toLowerCase()
    const hostname = hostHeader.replace(/:\d+$/, '')
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
    if (!allowed.has(hostname)) {
      return { ok: false, status: 403, reason: 'Host 不被允许：' + (hostHeader || '(空)') }
    }
    const origin = req.headers.origin
    if (origin) {
      try {
        const parsed = new URL(String(origin))
        if (!allowed.has(parsed.hostname)) return { ok: false, status: 403, reason: '跨站 Origin：' + origin }
      } catch {
        return { ok: false, status: 403, reason: 'Origin 解析失败。' }
      }
    }
    return { ok: true }
  }
}

export function apply(root, config = {}) {
  const configStore = createConfigStore(config)
  const dataPaths = paths()
  const audit = createAudit({ file: dataPaths.audit, keepLines: configStore.get().auditKeepLines })
  const pendings = createPendingStore({
    file: dataPaths.pending,
    ttlSeconds: configStore.get().confirmTtlSeconds,
  })
  const helperHint = () => 'sudo bash ' + INSTALL_SCRIPT
  const registry = createNodeRegistry(configStore, { helperHint, lxc: { helperHint } })
  const compose = createComposeService({ configStore, registry, audit })
  const actions = createActions({ registry, configStore, pendings, audit, compose })

  logLine('已加载：数据目录 ' + dataPaths.dir + '，安装脚本 ' + INSTALL_SCRIPT)

  root.inject(['tools'], (ctx) => {
    try {
      registerTools(ctx, { registry, actions, configStore, compose })
    } catch (error) {
      logLine('注册工具失败：' + (error && error.message ? error.message : String(error)))
    }
  })

  root.inject(['systemPrompt'], (ctx) => {
    try {
      ctx.effect(() => ctx.systemPrompt.section({
        name: 'container-manager:env',
        order: 905,
        text: PROMPT,
      }), 'dsh-container-manager: 容器台提示词')
    } catch (error) {
      logLine('注册提示词失败：' + (error && error.message ? error.message : String(error)))
    }
  })

  root.inject(['webServer'], (ctx) => {
    const server = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
    if (!server || typeof server.register !== 'function') {
      logLine('没有 webServer：面板接口未挂载（headless 下正常）。')
      return
    }
    const verify = makeVerify(ctx)
    const api = createApi({
      registry,
      configStore,
      pendings,
      actions,
      audit,
      verify,
      helperHint,
      compose,
      info: { name: PACKAGE.name, version: PACKAGE.version },
    })
    try {
      ctx.effect(() => server.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          Promise.resolve(api.handle(req, res)).catch((error) => {
            logLine('接口异常：' + (error && error.stack ? error.stack : String(error)))
            try {
              res.statusCode = 500
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '容器台内部错误，看 DSH 日志。' } }))
            } catch {
              // 响应已经结束
            }
          })
        },
      }), 'dsh-container-manager: ' + PREFIX)
      logLine('已挂 ' + PREFIX)
    } catch (error) {
      logLine('挂接口失败：' + (error && error.message ? error.message : String(error)))
    }

    // 终端走 WebSocket：和 REST 共用同一套认证，只是换了个协议。
    if (typeof server.registerUpgrade === 'function') {
      const terminal = createTerminalService({ registry, verify })
      try {
        ctx.effect(() => server.registerUpgrade({
          path: PREFIX + '/terminal',
          handler: (req, socket, head) => terminal.handleUpgrade(req, socket, head),
        }), 'dsh-container-manager: ' + PREFIX + '/terminal')
        logLine('已挂 ' + PREFIX + '/terminal（WebSocket）')
      } catch (error) {
        logLine('挂终端失败：' + (error && error.message ? error.message : String(error)))
      }
    } else {
      logLine('这个 webServer 不支持 registerUpgrade：终端功能关掉了。')
    }
  })
}

export { PROMPT }
