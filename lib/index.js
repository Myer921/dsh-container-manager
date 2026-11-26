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

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { PREFIX, createApi } from './api.js'
import { createActions } from './actions.js'
import { createAudit } from './audit.js'
import { createCapabilityProbe } from './capabilities.js'
import { createComposeService } from './compose/service.js'
import { createConfigStore, paths } from './config.js'
import { createFileService } from './files.js'
import { createJobStore } from './jobs.js'
import { createAlerter } from './alerts.js'
import { createBackupScheduler } from './backup.js'
import { createMetricsStore, createSampler } from './metrics.js'
import { createNodeRegistry } from './nodes.js'
import { createPendingStore } from './pending.js'
import { createPlanner } from './plan.js'
import { createTerminalService } from './terminal.js'
import { registerTools } from './tools.js'
import { createTrashStore } from './trash.js'
import { createSnapshotScheduler } from './snapshot-policy.js'
import { safeJson } from './util.js'

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
    if (conn && typeof conn.admit === 'function') {
      try {
        const admission = conn.admit({ headers: req.headers })
        if (admission && admission.rejection) {
          return { ok: false, status: admission.rejection, reason: 'Connection 拒绝（HTTP ' + admission.rejection + '）。刷新页面试试。' }
        }
        if (admission && admission.peer) {
          return { ok: true, principal: admission.peer.principal ?? { kind: 'owner' } }
        }
        return { ok: false, status: 401, reason: 'Connection 没有返回 Peer 身份。' }
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
    return { ok: true, principal: { kind: 'owner' } }
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
  // 长任务队列：克隆 / 快照 / 导出 / 提交这些不能挂在 HTTP 请求里等。
  const jobs = createJobStore({
    file: dataPaths.jobs,
    maxRunning: configStore.get().jobsMaxRunning,
    onChange: record => {
      if (!record || !['done', 'failed', 'cancelled', 'interrupted'].includes(record.status)) return
      try {
        audit.append({
          principal: record.principal ?? 'system',
          node: record.node ?? 'job',
          action: 'job.' + record.status,
          target: record.target ?? record.id,
          result: record.status,
          detail: { jobId: record.id, kind: record.kind, error: record.error ?? null },
        })
      } catch {
        // 审计失败由 health 单独报告
      }
    },
  })
  const capabilities = createCapabilityProbe()
  const planner = createPlanner({ registry, compose })
  const files = createFileService({ registry })
  const trash = createTrashStore({ file: dataPaths.trash })
  // 指标历史：面板自己那 20 个点的环只有 3 分钟，重启就没了，那是心跳不是历史。
  const metrics = createMetricsStore({
    file: dataPaths.metrics,
    intervalSeconds: configStore.get().metrics.intervalSeconds,
    keepDays: configStore.get().metrics.keepDays,
    maxBytes: configStore.get().metrics.maxBytes,
  })
  const actions = createActions({
    registry,
    configStore,
    pendings,
    audit,
    compose,
    planner,
    jobs,
    files,
    trash,
  })

  // 自动备份调度器：只碰 LXC（Podman 的正解是 compose 文件 + 卷，不假装打包 rootfs）。
  // 导出走任务队列，所以这里只是「到点了就排一个任务」，不会把请求链路堵住。
  // LXC 节点 id 不写死：先问快照哪个 LXC 节点可用（有 ssh 节点时 local-lxc 可能不是它）。
  let lxcNodeCache = ''
  async function lxcNodeId() {
    if (lxcNodeCache) return lxcNodeCache
    try {
      const snapshot = await registry.snapshot()
      const node = (snapshot.nodes || []).find(item => item.kind === 'lxc' && item.available)
      lxcNodeCache = node ? node.id : 'local-lxc'
    } catch {
      lxcNodeCache = 'local-lxc'
    }
    return lxcNodeCache
  }

  const backupScheduler = createBackupScheduler({
    getPolicy: () => configStore.get().backupPolicy,
    canExport: async () => {
      const probe = await capabilities.probe({ id: await lxcNodeId(), kind: 'lxc', transport: 'helper' })
      return probe.checks?.some(check => check.id === 'lxc-export' && check.state === 'ok') === true
    },
    listFiles: async () => {
      const dir = configStore.get().backupPolicy.dir || undefined
      const listed = await registry.listLxcExports(await lxcNodeId(), { dir })
      return Array.isArray(listed?.files) ? listed.files : []
    },
    exportNow: async name => actions.lxcExport({ node: await lxcNodeId(), name, dir: configStore.get().backupPolicy.dir || undefined, principal: 'scheduler' }),
    removeFile: async name => actions.deleteLxcExport({ node: await lxcNodeId(), name, dir: configStore.get().backupPolicy.dir || undefined, principal: 'scheduler', internal: true }),
    listContainers: async () => {
      const snapshot = await registry.snapshot()
      return (snapshot.containers || []).filter(item => item.kind === 'lxc').map(item => item.name)
    },
    getJob: id => jobs.get(id),
    waitJob: async id => {
      while (true) {
        const job = jobs.get(id)
        if (!job) throw new Error('备份任务不存在：' + id)
        if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    },
    log: event => logLine('备份 [' + event.level + '] ' + event.text),
  })

  const snapshotStateFile = dataPaths.snapshots
  const loadSnapshotState = () => existsSync(snapshotStateFile) ? safeJson(readFileSync(snapshotStateFile, 'utf8'), {}) : {}
  const saveSnapshotState = state => {
    const temporary = snapshotStateFile + '.tmp'
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, snapshotStateFile)
  }
  const snapshotScheduler = createSnapshotScheduler({
    getPolicy: () => configStore.get().snapshotPolicy,
    listContainers: async () => {
      const snapshot = await registry.snapshot()
      return (snapshot.containers || []).filter(item => item.kind === 'lxc').map(item => item.name)
    },
    listSnapshots: async name => registry.listSnapshots(await lxcNodeId(), name),
    createSnapshot: async name => actions.lxcSnapshot({ node: await lxcNodeId(), name, op: 'create', options: { comment: 'cm-auto' }, principal: 'scheduler', internal: true }),
    deleteSnapshot: async (name, snapshot) => registry.lxcSnapshot(await lxcNodeId(), name, 'delete', { snapshot }),
    getJob: id => jobs.get(id),
    waitJob: async id => {
      while (true) {
        const job = jobs.get(id)
        if (!job) throw new Error('快照任务不存在：' + id)
        if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    },
    loadState: loadSnapshotState,
    saveState: saveSnapshotState,
    log: event => logLine('定时快照 [' + event.level + '] ' + event.text),
  })
  actions.setSnapshotRunner(() => snapshotScheduler.tick())

  // 告警出口：默认 fetch POST；这台机上没有 fetch 时（很老的运行时）就不发，别假装发了。
  const alertPost = async request => {
    if (typeof fetch !== 'function') throw new Error('这个运行时没有 fetch，发不出去。')
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null || request.body === undefined ? undefined : request.body,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
    })
    if (!response || response.ok === false) throw new Error('HTTP ' + (response ? response.status : '?'))
    return { status: response.status }
  }
  const alerter = createAlerter({
    getConfig: () => configStore.get().alerts,
    post: alertPost,
    log: message => logLine(message),
  })

  logLine('已加载：数据目录 ' + dataPaths.dir + '，安装脚本 ' + INSTALL_SCRIPT)

  root.inject(['tools'], (ctx) => {
    try {
      registerTools(ctx, {
        registry,
        actions,
        configStore,
        compose,
        jobs,
        capabilities,
        files,
        backup: backupScheduler,
        snapshots: snapshotScheduler,
        alerts: alerter,
        audit,
      })
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
    // 采样器跟着面板一起活：面板不在就没有人看图，采了也是白发。
    if (configStore.get().metrics.enabled) {
      const sampler = createSampler({
        metrics,
        registry,
        intervalSeconds: configStore.get().metrics.intervalSeconds,
        log: logLine,
      })
      try {
        ctx.effect(() => {
          sampler.start()
          return () => sampler.stop()
        }, 'dsh-container-manager: 指标采样器')
        logLine('指标采样：每 ' + sampler.intervalSeconds + ' 秒一条，留 '
          + metrics.keepDays + ' 天')
      } catch (error) {
        logLine('指标采样没起来：' + (error && error.message ? error.message : String(error)))
      }
    } else {
      logLine('指标采样在配置里关掉了（metrics.enabled = false）。')
    }
    // 自动备份：每 10 分钟看一眼是否到点。导出本身进任务队列，这里只看表。
    try {
      ctx.effect(() => {
        const timer = setInterval(() => {
          Promise.resolve(backupScheduler.tick()).catch(error => {
            logLine('备份调度出错：' + (error && error.message ? error.message : String(error)))
          })
        }, 10 * 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'dsh-container-manager: 自动备份调度')
      logLine('自动备份：每 10 分钟检查一次策略（当前 ' + (configStore.get().backupPolicy.enabled ? '开启' : '关闭') + '）')
    } catch (error) {
      logLine('自动备份没起来：' + (error && error.message ? error.message : String(error)))
    }
    // 定时快照：每 10 分钟检查一次；ext4 上会整份复制，所以默认关闭。
    try {
      ctx.effect(() => {
        const timer = setInterval(() => {
          Promise.resolve(snapshotScheduler.tick()).catch(error => {
            logLine('定时快照调度出错：' + (error && error.message ? error.message : String(error)))
          })
        }, 10 * 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'dsh-container-manager: 定时快照调度')
      logLine('定时快照：每 10 分钟检查一次策略（当前 ' + (configStore.get().snapshotPolicy.enabled ? '开启' : '关闭') + '）')
    } catch (error) {
      logLine('定时快照没起来：' + (error && error.message ? error.message : String(error)))
    }
    // 告警：每 max(60s, 采样间隔×2) 看一轮。容器状态走快照（本身有缓存），盘占用现采。
    try {
      const period = Math.max(60_000, (configStore.get().metrics.intervalSeconds || 30) * 2000)
      ctx.effect(() => {
        let busy = false
        const timer = setInterval(() => {
          if (busy) return
          const rules = configStore.get().alerts.rules || []
          if (!rules.some(rule => rule && rule.enabled !== false)) return
          busy = true
          Promise.resolve((async () => {
            const host = {}
            for (const node of registry.nodes()) {
              try {
                const value = await registry.stats(node.id)
                const disk = value && value.host && value.host.ok
                  ? (value.host.disks || []).find(item => item.mount === '/') || null
                  : null
                host[node.id] = { diskPercent: disk ? disk.percent : null }
              } catch {
                // 节点不可用不报，下一轮再说
              }
            }
            const snapshot = await registry.snapshot()
            const result = await alerter.evaluate({
              host,
              containers: snapshot.containers || [],
              pending: pendings.list(),
            })
            if (result.sent && result.sent.length > 0) logLine('告警发出 ' + result.sent.length + ' 条')
          })()).catch(error => logLine('告警轮询出错：' + (error && error.message ? error.message : String(error)))).finally(() => { busy = false })
        }, period)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'dsh-container-manager: 告警轮询')
    } catch (error) {
      logLine('告警轮询没起来：' + (error && error.message ? error.message : String(error)))
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
      jobs,
      capabilities,
      metrics,
      files,
      trash,
      backup: backupScheduler,
      snapshots: snapshotScheduler,
      alerts: alerter,
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
