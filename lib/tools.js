/**
 * 10 个容器/网络工具
 *
 * 设计原则：
 *  - 只读工具随便调；写工具里「删除 / 改网络」永远返回 pending，等人在面板确认。
 *  - AI 拿不到确认通道（pending_operations 只能查，不能 confirm）。
 *  - 领域失败（节点不可用、helper 没装）作为规范值返回，不当作异常；
 *    参数错误也收成 `{ok:false,error}`，让模型能读懂并改。
 */

import { diagnose as diagnoseHost, firewallSummary, hostNetwork } from './net.js'
import {
  CmError,
  ERR,
  asCmError,
  assertCidr,
  assertContainerName,
  assertEnum,
  assertImage,
  assertIp,
  assertIpv4,
  assertNetworkName,
  clampInt,
} from './util.js'

const OK_SCHEMA = { type: 'object', additionalProperties: true }

const NODE_DESCRIPTION = '节点 id：先用 container_nodes 查，本机通常是 local-podman / local-lxc。'

function text(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

function lines(list) {
  return list.filter(Boolean).join('\n')
}

function stateGlyph(state) {
  if (state === 'running' || state === 'up') return '●'
  if (state === 'paused' || state === 'frozen') return '⏸'
  if (state === 'exited' || state === 'stopped' || state === 'down') return '○'
  return '·'
}

function containerLine(container) {
  const ips = (container.networks ?? []).map(network => network.ip).filter(Boolean)
  return `  ${stateGlyph(container.state)} ${container.name}  [${container.nodeId ?? container.node ?? ''}]  ${container.image ?? ''}${ips.length ? `  ${ips.join(', ')}` : ''}`
}

function renderContainers(value) {
  if (!value.ok) return `读不到容器：${value.error?.message ?? '未知错误'}`
  if (value.containers.length === 0) return '没有容器。'
  return lines([`共 ${value.containers.length} 个容器：`, ...value.containers.map(containerLine)])
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./nodes.js').createNodeRegistry>} deps.registry
 * @param {ReturnType<import('./actions.js').createActions>} deps.actions
 * @param {ReturnType<import('./config.js').createConfigStore>} deps.configStore
 */
export function registerTools(ctx, {
  registry,
  actions,
  configStore,
  compose = null,
  jobs = null,
  capabilities = null,
  files = null,
}) {
  const register = definition => ctx.tools.register(definition)

  /** 统一把领域错误收成规范值；意外错误照旧抛。 */
  async function guard(fn) {
    try {
      return await fn()
    } catch (error) {
      const cm = asCmError(error)
      if (cm instanceof CmError) {
        return { ok: false, error: { code: cm.code, message: cm.message, ...(cm.hint ? { hint: cm.hint } : {}) } }
      }
      throw error
    }
  }

  register({
    name: 'container_nodes',
    description: [
      '列出容器台能管的节点（本机 Podman / 本机 LXC / SSH 节点），以及每个节点是否可用、版本、rootless、helper 状态。',
      '管容器之前先调它：节点不可用时不要假装能操作，把 reason 和 hint 原样告诉用户。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'true = 跳过 5 秒缓存重新探测。' },
      },
      required: [],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(value.ok ? lines([
      `节点（${value.nodes.length}）：`,
      ...value.nodes.map(node => `  ${node.available ? '●' : '○'} ${node.label} [${node.id}] ${node.kind}/${node.transport}${node.available ? `  ${node.detail?.version ?? ''}${node.detail?.rootless ? ' rootless' : ''}` : `  不可用：${node.reason ?? ''}`}`),
    ]) : `探测失败：${value.error?.message ?? ''}`) },
    execute: async (args) => guard(async () => {
      const probed = await registry.probeAll({ force: Boolean(args.force) })
      return {
        ok: true,
        nodes: probed.map(entry => ({
          id: entry.node.id,
          label: entry.node.label,
          kind: entry.node.kind,
          transport: entry.node.transport,
          available: entry.available,
          reason: entry.reason,
          hint: entry.hint,
          hintText: entry.hintText ?? null,
          detail: entry.detail ?? null,
        })),
      }
    }),
  })

  register({
    name: 'container_list',
    description: [
      '列出容器（Podman 与 LXC 一起）和网络摘要。可按 node / 运行时 / 状态过滤。',
      '只读。要知道某个容器细节用 container_inspect；要看日志用 container_logs。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        kind: { type: 'string', enum: ['podman', 'lxc'], description: '只看某一类运行时。' },
        state: { type: 'string', description: '只看某个状态（running / exited / stopped …）。' },
        withNetworks: { type: 'boolean', description: 'true = 同时给网络列表。' },
      },
      required: [],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(renderContainers(value)) },
    execute: async (args) => guard(async () => {
      const snapshot = await registry.snapshot()
      let containers = snapshot.containers
      if (args.node) containers = containers.filter(container => container.nodeId === args.node)
      if (args.kind) {
        const nodeIds = new Set(snapshot.nodes.filter(node => node.kind === args.kind).map(node => node.id))
        containers = containers.filter(container => nodeIds.has(container.nodeId))
      }
      if (args.state) containers = containers.filter(container => container.state === String(args.state).toLowerCase())
      const compact = containers.map(container => ({
        node: container.nodeId,
        id: container.id,
        shortId: container.shortId,
        name: container.name,
        runtime: container.runtime,
        state: container.state,
        status: container.status,
        image: container.image,
        ports: container.ports,
        networks: container.networks,
      }))
      return {
        ok: true,
        containers: compact,
        ...(args.withNetworks ? { networks: snapshot.networks.map(network => ({
          node: network.nodeId,
          name: network.name,
          driver: network.driver,
          subnet: network.subnet,
          gateway: network.gateway,
          containers: network.containers.length,
        })) } : {}),
        errors: snapshot.errors,
      }
    }),
  })

  register({
    name: 'container_inspect',
    description: [
      '看一个容器的详情：状态、镜像、端口、挂载、网络（IP/MAC/网关）、LXC 的网卡配置。',
      '只读。返回里不含环境变量的值，只有键名。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '容器名或 id。' },
      },
      required: ['node', 'ref'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(value.ok
      ? lines([
        `${value.container.name}  [${value.container.nodeId}]  ${value.container.state}`,
        `镜像：${value.container.image || '—'}`,
        `端口：${(value.container.ports ?? []).map(port => `${port.hostIp || '0.0.0.0'}:${port.hostPort ?? '—'}→${port.containerPort}/${port.protocol}`).join(', ') || '—'}`,
        `网络：${(value.container.networks ?? []).map(network => `${network.name}=${network.ip || '—'}`).join(', ') || '—'}`,
        `挂载：${(value.container.mounts ?? []).map(mount => `${mount.source}→${mount.destination}${mount.rw ? '' : '(ro)'}`).join(', ') || '—'}`,
        value.container.nics ? `LXC 网卡：${value.container.nics.map(nic => `${nic.type}:${nic.link ?? nic.macvlan?.link ?? '—'}`).join(', ')}` : '',
      ])
      : `读不到：${value.error?.message ?? ''}`) },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node 与 ref。')
      const container = await registry.inspect(node, ref)
      return { ok: true, container: { ...container, nodeId: node } }
    }),
  })

  register({
    name: 'container_logs',
    description: '读容器最近 N 行日志（默认 100，上限 2000）。只读，不会触发任何动作。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '容器名或 id。' },
        tail: { type: 'number', description: '要多少行，1..2000，默认 100。' },
      },
      required: ['node', 'ref'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(value.ok ? `${value.ref} 最近 ${value.tail} 行：\n${value.text || '（没有输出）'}` : `读不到日志：${value.error?.message ?? ''}`) },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node 与 ref。')
      const tail = clampInt(args.tail, 1, configStore.get().logTailMax, configStore.get().logTailDefault)
      const result = await registry.logs(node, ref, tail)
      return { ok: true, node, ref, tail, ...result }
    }),
  })

  register({
    name: 'container_action',
    description: [
      '对容器执行动作：start / stop / restart / pause / unpause 直接执行；',
      'delete 是危险操作，会返回 {status:"pending", token, message} —— 这不是失败，',
      '是把操作挂起来了：必须让用户去左侧「容器」面板点确认。不要重复发起同一条删除，也不要试图自己确认。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '容器名或 id。' },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'pause', 'unpause', 'delete', 'freeze', 'unfreeze', 'destroy'],
          description:
            'start / stop / restart 通用；pause→unpause 是 Podman 的暂停，freeze→unfreeze 是 LXC 的冻结（两套动词会自动互译）；delete / destroy 都是删除，同样自动互译，且一律走待确认。',
        },
      },
      required: ['node', 'ref', 'action'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text(`操作失败：${value.error?.message ?? ''}`)
      if (value.result?.status === 'pending') {
        return text(`已挂起，等待用户确认：${value.result.message}\n（token ${value.result.token}，${Math.round((Date.parse(value.result.expiresAt) - Date.now()) / 1000)} 秒内有效）`)
      }
      return text(`${value.result.ref} : ${value.result.action} 完成。${value.result.result?.output ? `\n${value.result.result.output}` : ''}`)
    } },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      const action = assertEnum(String(args.action ?? ''), ['start', 'stop', 'restart', 'pause', 'unpause', 'delete'], 'action')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node 与 ref。')
      const result = await actions.containerAction({ node, ref, action, principal: 'ai' })
      return { ok: true, result }
    }),
  })

  register({
    name: 'container_create',
    description: [
      '创建并启动一个容器：Podman（等价 podman run -d）或 LXC（等价 lxc-create -t download + lxc-start）。',
      'kind=podman 时需要 image；kind=lxc 时需要 name，distro/release/arch 可选。',
      '创建不危险（不删数据），直接执行；但它会占端口和磁盘，先确认镜像名与端口没被占。',
      'LXC 创建要联网拉 rootfs，可能几分钟。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点 id，通常是 local-podman 或 local-lxc。' },
        kind: { type: 'string', enum: ['podman', 'lxc'], description: '运行时的类型；不填就按节点类型推断。' },
        image: { type: 'string', description: '[podman] 镜像引用，例如 docker.io/library/alpine:3.20。' },
        name: { type: 'string', description: '容器名（Podman 可选，LXC 必填）。' },
        network: { type: 'string', description: '[podman] 网络名；[lxc] 网桥名（例如 lxcbr0），或网络对象。' },
        ports: {
          type: 'array',
          description: '端口映射，例如 [{"hostPort":8080,"containerPort":80}]。',
          items: { type: 'object', additionalProperties: true, properties: {} },
        },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '环境变量键值对。注意会写进容器 inspect，别放密钥。' },
        volumes: {
          type: 'array',
          description: '挂载，例如 [{"source":"/tmp/x","destination":"/data"}]。',
          items: { type: 'object', additionalProperties: true, properties: {} },
        },
        command: { type: 'array', items: { type: 'string' }, description: '覆盖镜像的启动命令。' },
        uts: { type: 'string', enum: ['host', 'private'], description: 'UTS namespace。留空先试独立 UTS；起不来时会自动退到 host，并在 warnings 里说明。' },
        restart: { type: 'string', enum: ['no', 'on-failure', 'always', 'unless-stopped'], description: '[podman] 重启策略，创建时生效。' },
        memory: { type: 'string', description: '内存上限，例如 256m / 1g；留空不限。' },
        cpus: { type: 'number', description: 'CPU 上限，例如 1.5；留空不限。' },
        distro: { type: 'string', description: '[lxc] 发行版，例如 debian / alpine / ubuntu。' },
        release: { type: 'string', description: '[lxc] 版本，例如 bookworm / 3.22。' },
        arch: { type: 'string', enum: ['arm64', 'amd64', 'armhf', 'i386'], description: '[lxc] 架构，本机默认 arm64。' },
        memoryMax: { type: 'string', description: '[lxc] 内存上限（写进 config），例如 256m。' },
        start: { type: 'boolean', description: '[lxc] 创建后是否启动，默认 true。' },
        autostart: { type: 'boolean', description: '[lxc] 是否开机自启，默认 false。' },
      },
      required: ['node'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`创建失败：${value.error?.message ?? ''}`)
        const name = value.created?.detail?.name ?? value.created?.id ?? ''
        const warning = (value.created?.warnings ?? []).join(' ')
        return text(`已创建 ${name}（${value.created?.detail?.state ?? 'ok'}）。${warning ? ' ' + warning : ''}`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      // 归一化在 actions 层（按节点类型分派），这里不重复写一套校验，避免两个入口跑偏。
      const result = await actions.createContainer({ node, spec: args, principal: 'ai' })
      return { ok: true, created: result.created }
    }),
  })

  register({
    name: 'container_limits',
    description: [
      '改 Podman 容器的资源限制（内存 / CPU）—— 走 podman update，立即生效、不需要重建、不需要确认。',
      'memory 或 cpus 传 0 表示取消那一项限制。',
      '这个 podman 版本（4.3.1）的 update 不支持 --restart：想换重启策略只能重建容器。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '容器名或 id。' },
        memory: { type: 'string', description: '内存上限，例如 256m / 1g；0 表示不限。' },
        cpus: { type: 'number', description: 'CPU 上限，例如 1.5；0 表示不限。' },
        cpuShares: { type: 'integer', description: 'CPU 权重 10..1000（可选）。' },
        cpusetCpus: { type: 'string', description: '绑核，例如 "0-3"（可选）。' },
      },
      required: ['node', 'ref'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`改限制失败：${value.error?.message ?? ''}`)
        const applied = value.applied ?? {}
        const parts = []
        if (applied.memory !== undefined) parts.push(`内存 ${applied.memory}`)
        if (applied.cpus !== undefined) parts.push(`CPU ${applied.cpus}`)
        if (applied.cpuShares !== undefined) parts.push(`cpu-shares ${applied.cpuShares}`)
        if (applied.cpusetCpus) parts.push(`cpuset ${applied.cpusetCpus}`)
        return text(`已改 ${value.ref ?? ''} 的限制：${parts.join('，') || '无'}。`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node 与 ref。')
      const limits = {}
      if (args.memory !== undefined) limits.memory = String(args.memory)
      if (args.cpus !== undefined) limits.cpus = Number(args.cpus)
      if (args.cpuShares !== undefined) {
        const shares = clampInt(args.cpuShares, 10, 1000, 0)
        if (!shares) throw new CmError(ERR.BAD_ARGS, 'cpuShares 必须在 10..1000。')
        limits.cpuShares = shares
      }
      if (args.cpusetCpus !== undefined) limits.cpusetCpus = String(args.cpusetCpus)
      if (Object.keys(limits).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的限制项（memory / cpus / cpuShares / cpusetCpus）。')
      const result = await actions.updatePodmanCgroup({ node, ref, limits, principal: 'ai' })
      return { ok: true, ...result }
    }),
  })

  register({
    name: 'container_stats',
    description: [
      '看容器实时占用（CPU / 内存 / 进程数）以及宿主负载、内存、磁盘。',
      'podman stats 单次要 1~2 秒，别连着刷；要趋势就隔几秒取一次。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
      },
      required: ['node'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`读不到占用：${value.error?.message ?? ''}`)
        const stats = value.stats ?? {}
        const rows = stats.ok
          ? (stats.containers || []).map(row => `${row.name}  CPU ${row.cpuPercent}%  内存 ${row.memPercent}%  PIDs ${row.pids}`).join('\n') || '（没有在跑的容器）'
          : `容器占用读不到：${stats.reason ?? ''}`
        const host = stats.host
        const hostText = host && host.ok
          ? `\n宿主负载 ${host.load.one.toFixed(2)} / ${host.load.five.toFixed(2)} / ${host.load.fifteen.toFixed(2)}；内存 ${host.memory.percent}%` +
            `（${Math.round(host.memory.used / 1024 / 1024)}MB / ${Math.round(host.memory.total / 1024 / 1024)}MB）` +
            (host.disks || []).map(disk => `；${disk.mount} 用了 ${disk.percent}%`).join('')
          : host && host.reason ? `\n宿主负载：${host.reason}` : ''
        return text(rows + hostText)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      return { ok: true, node, stats: await registry.stats(node) }
    }),
  })

  register({
    name: 'container_rename',
    description: '给 Podman 容器改名（podman rename）。不删数据，直接执行；LXC 容器不支持（要克隆再删，太危险）。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '现在的容器名或 id。' },
        name: { type: 'string', description: '新名字；不能和现有容器重复。' },
      },
      required: ['node', 'ref', 'name'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => value.ok
        ? text(`${value.result?.from ?? ''} → ${value.result?.to ?? ''}`)
        : text(`改名失败：${value.error?.message ?? ''}`),
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      const name = String(args.name ?? '')
      if (!node || !ref || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / name。')
      return { ok: true, result: await actions.renameContainer({ node, ref, name, principal: 'ai' }) }
    }),
  })

  register({
    name: 'container_commit',
    description: [
      '把容器提交成镜像（podman commit）。整层复制、占磁盘，所以走待确认：',
      '返回 {status:"pending", token, message} 不是失败 —— 让用户去「容器」面板点确认。',
      '镜像名建议带命名空间与时间戳，例如 local/名字:20261121-1530。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        ref: { type: 'string', description: '容器名或 id。' },
        image: { type: 'string', description: '目标镜像名，例如 local/名字:20261121-1530。' },
      },
      required: ['node', 'ref', 'image'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`提交失败：${value.error?.message ?? ''}`)
        if (value.result?.status === 'pending') {
          return text(`已挂起，等待用户确认：${value.result.message}`)
        }
        return text(`已提交成镜像 ${value.result?.image ?? ''}（${value.result?.id ?? ''}）。`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const ref = String(args.ref ?? '')
      const image = String(args.image ?? '')
      if (!node || !ref || !image) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / image。')
      return { ok: true, result: await actions.commitContainer({ node, ref, image, principal: 'ai' }) }
    }),
  })

  register({
    name: 'container_config',
    description: [
      '改 LXC 容器的启动项：开机自启、内存上限（写进 /var/lib/lxc/<名字>/config）。',
      '这是危险操作，返回 {status:"pending", token} —— 必须让用户在左侧「容器」面板的「待确认」里点确认。',
      '不要重复发起同一条，也不要试图自己确认。memoryMax 传空字符串表示改成不限。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        name: { type: 'string', description: 'LXC 容器名。' },
        autostart: { type: 'boolean', description: '开机自启开/关（可选）。' },
        memoryMax: { type: 'string', description: '内存上限，例如 256m / 1g；空字符串表示不限（可选）。' },
      },
      required: ['node', 'name'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`改启动项失败：${value.error?.message ?? ''}`)
        if (value.status === 'pending') return text(`已挂起：${value.summary ?? ''} 去左侧「容器」面板的「待确认」点确认。`)
        return text(`已改 ${value.name ?? ''} 的启动项。`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const name = String(args.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node 与 name。')
      const patch = {}
      if (args.autostart !== undefined) patch.autostart = args.autostart === true
      if (args.memoryMax !== undefined) patch.memoryMax = String(args.memoryMax ?? '')
      if (Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项（autostart / memoryMax）。')
      const result = await actions.setLxcConfig({ node, name, patch, principal: 'ai' })
      return { ok: true, ...result }
    }),
  })
  register({
    name: 'container_resources',
    description: [
      '改 LXC 容器的配置：CPU（绑核 / 配额 / 权重）、内存（上限 / 软限 / swap / OOM）、',
      'PID 上限、IO 权重，以及主机名、开机自启、启动顺序与延迟、init 命令、capabilities。',
      '直接执行、不走 pending：可逆、不碰数据。',
      '资源类的会在容器运行时同时写 cgroup，立即生效；',
      'capabilities / init 命令 / 启动顺序这类只有下次启动才读，返回值里 restartRequired 会列出来。',
      '字符串字段传空字符串表示「不限 / 回默认」。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        name: { type: 'string', description: 'LXC 容器名。' },
        cores: { type: 'string', description: '绑核，例如 "0-1" 或 "0,2"；空字符串 = 不绑核（可选）。' },
        cpuQuota: { type: 'string', description: 'CPU 配额，单位是核、可带小数（例如 1.5 = 一个半核）；空字符串 = 不限（可选）。' },
        cpuWeight: { type: 'string', description: 'CPU 相对权重 1..10000，默认 100（可选）。' },
        memory: { type: 'string', description: '内存上限，例如 512m / 2g；空字符串 = 不限（可选）。' },
        memoryHigh: { type: 'string', description: '内存软限：超过后先回收、不直接 OOM，例如 400m；空字符串 = 不限（可选）。' },
        swap: { type: 'string', description: 'swap 上限，例如 512m / 1g；空字符串 = 不限（可选）。' },
        oomGroup: { type: 'boolean', description: 'true = 内存爆掉时整组一起终止，而不是只杀一个进程（可选）。' },
        pids: { type: 'string', description: 'PID 上限，正整数；空字符串 = 不限（可选）。' },
        ioWeight: { type: 'string', description: 'IO 相对权重 1..10000，默认 100（可选）。' },
        hostname: { type: 'string', description: '容器主机名；运行中会顺手 attach 进去改掉（可选）。' },
        autostart: { type: 'boolean', description: '开机自启开关（可选）。' },
        startOrder: { type: 'string', description: '启动顺序，0 或正整数，越大越后启动（可选）。' },
        startDelay: { type: 'string', description: '启动延迟秒数（可选）。' },
        initCmd: { type: 'string', description: '替代 init，例如 /bin/sh；空字符串 = 回默认（可选）。' },
        capDrop: { type: 'string', description: '要丢弃的 capabilities，空格分隔，例如 "sys_module mac_admin"；空字符串 = 不丢弃（可选）。' },
      },
      required: ['node', 'name'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`改资源失败：${value.error?.message ?? ''}`)
        const live = value.live ? '已立即生效' : '容器没在运行，下次启动生效'
        const res = value.resources
        const detail = res
          ? `cpuset=${res.cpusetCpus || res.cpusetEffective || '-'}，cpu.max=${res.cpuMax ?? '-'}，memory.max=${res.memoryMax ?? '-'}，swap.max=${res.swapMax ?? '-'}，pids.max=${res.pidsMax ?? '-'}`
          : ''
        const need = Array.isArray(value.restartRequired) && value.restartRequired.length > 0
          ? `；${value.restartRequired.join(' / ')} 要重启容器才生效`
          : ''
        return text(`已改 ${value.name ?? ''} 的配置（${live}）。${detail}${need}`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const name = String(args.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node 与 name。')
      const patch = {}
      const textFields = [
        'cores', 'cpuQuota', 'cpuWeight', 'memory', 'memoryHigh', 'swap',
        'pids', 'ioWeight', 'hostname', 'startOrder', 'startDelay', 'initCmd', 'capDrop',
      ]
      for (const field of textFields) {
        if (args[field] !== undefined) patch[field] = String(args[field] ?? '')
      }
      if (args.autostart !== undefined) patch.autostart = Boolean(args.autostart)
      if (args.oomGroup !== undefined) patch.oomGroup = Boolean(args.oomGroup)
      if (Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
      const result = await actions.setLxcResources({ node, name, patch, principal: 'ai' })
      return { ok: true, ...result }
    }),
  })
  register({
    name: 'container_image_list',
    description: [
      '列镜像。Podman 节点是本地镜像库；LXC 节点是系统镜像缓存（rootfs.tar.xz，落在 /opt/dsh-container/lxc/image）。',
      '只读。两种节点返回形状不同：Podman 是数组，LXC 是 { images, count, total, root }。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
      },
      required: ['node'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`列镜像失败：${value.error?.message ?? ''}`)
        if (value.kind === 'podman') {
          const list = Array.isArray(value.images) ? value.images : []
          return text(list.length
            ? list.map(item => `${item.repository}:${item.tag}  ${item.size ?? ''}  ${item.id ?? ''}`).join('\n')
            : '没有镜像。')
        }
        const cached = Array.isArray(value.cached) ? value.cached : []
        const head = `LXC 系统镜像缓存：${value.count ?? 0} 个，共 ${value.totalText ?? '—'}（${value.root ?? ''}）`
        return text([head, ...cached.map(item => `  ${item.name}  ${item.size ?? ''}${item.expired ? '  已过期' : ''}`)].join('\n'))
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      const data = await registry.listImages(node)
      if (Array.isArray(data)) return { ok: true, kind: 'podman', images: data }
      const images = Array.isArray(data?.images) ? data.images : []
      const total = Number(data?.total ?? 0)
      return {
        ok: true,
        kind: 'lxc',
        root: data?.root ?? '',
        count: images.length,
        total,
        totalText: total >= 1024 ** 3 ? (total / 1024 ** 3).toFixed(1) + 'G' : Math.round(total / 1024 ** 2) + 'M',
        cached: images.map(item => ({ name: item.name, size: item.size, bytes: item.bytes, expired: item.expired })),
      }
    }),
  })

  register({
    name: 'container_image_delete',
    description: [
      '删镜像。Podman 节点删 OCI 镜像；LXC 节点删系统镜像缓存。',
      '都走待确认：返回 { status:"pending", token } 之后必须让用户去面板「待确认」点一下，AI 没有确认通道。',
      '删了 LXC 缓存，下次建这个发行版的容器要重新下载。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        name: { type: 'string', description: '镜像名。Podman 是 nginx:latest 这种；LXC 是 debian/trixie/arm64 这种。' },
      },
      required: ['node', 'name'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`删镜像失败：${value.error?.message ?? ''}`)
        if (value.status === 'pending') {
          return text(`已挂起：${value.message ?? ''}（token ${value.token}）—— 让用户去左侧「容器」面板的「待确认」里点一下。`)
        }
        const freed = value.size ?? value.freed ?? ''
        return text(`已删除 ${value.name ?? ''}${freed ? `，释放 ${freed}` : ''}。`)
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const name = String(args.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node 与 name。')
      // 两种节点的「镜像」不是一回事，按 kind 分流
      const result = registry.kindOf(node) === 'lxc'
        ? await actions.lxcImageDelete({ node, name, principal: 'ai' })
        : await actions.imageDelete({ node, reference: name, principal: 'ai' })
      return { ok: true, ...result }
    }),
  })

  register({
    name: 'network_manage',
    description: [
      'Podman / LXC 网络的读与写。',
      'op=list / inspect：只读，直接返回。',
      'op=create / remove / connect / disconnect：危险操作，返回 {status:"pending", token} —— ',
      '必须让用户在左侧「容器」面板确认。不要重复发起，也不要试图自己确认。',
      'rootless Podman 的静态 IP（connect 时带 ip）经常不支持，失败时把 stderr 如实转述。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: `${NODE_DESCRIPTION} 必填。` },
        op: { type: 'string', enum: ['list', 'inspect', 'create', 'remove', 'connect', 'disconnect'] },
        name: { type: 'string', description: '网络名（create/remove/inspect/connect/disconnect 时必填）。' },
        driver: { type: 'string', enum: ['bridge', 'macvlan', 'ipvlan'], description: 'create 时的驱动，默认 bridge。' },
        subnet: { type: 'string', description: 'create 时的子网，例如 10.99.0.0/24。' },
        gateway: { type: 'string', description: 'create 时的网关 IPv4。' },
        container: { type: 'string', description: 'connect/disconnect 时的容器名。' },
        ip: { type: 'string', description: 'connect 时给容器的静态 IP（rootless 往往不支持）。' },
        internal: { type: 'boolean', description: 'create 时是否 internal（无出站）。' },
      },
      required: ['node', 'op'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text(`网络操作失败：${value.error?.message ?? ''}`)
      if (value.result?.status === 'pending') return text(`已挂起，等待用户确认：${value.result.message}\n（token ${value.result.token}）`)
      const data = value.result?.result ?? value.result
      if (Array.isArray(data)) {
        return text(lines([`${data.length} 个网络：`, ...data.map(network => `  ${network.name}  ${network.driver}  ${network.subnet || '—'}  (${network.containers?.length ?? 0} 个容器)`)]))
      }
      return text(JSON.stringify(data ?? value.result, null, 2))
    } },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? '')
      const op = assertEnum(String(args.op ?? ''), ['list', 'inspect', 'create', 'remove', 'connect', 'disconnect'], 'op')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      const payload = { node, op }
      if (args.name) payload.name = assertNetworkName(String(args.name))
      if (op === 'create') {
        if (!payload.name) throw new CmError(ERR.BAD_ARGS, 'create 需要 name。')
        if (args.driver) payload.driver = assertEnum(String(args.driver), ['bridge', 'macvlan', 'ipvlan'], 'driver')
        if (args.subnet) payload.subnet = assertCidr(String(args.subnet))
        if (args.gateway) payload.gateway = assertIpv4(String(args.gateway))
        if (args.internal) payload.internal = true
      }
      if (op === 'connect' || op === 'disconnect') {
        if (!payload.name) throw new CmError(ERR.BAD_ARGS, `${op} 需要 name。`)
        if (!args.container) throw new CmError(ERR.BAD_ARGS, `${op} 需要 container。`)
        payload.container = assertContainerName(String(args.container))
        if (op === 'connect' && args.ip) payload.ip = assertIp(String(args.ip))
      }
      const result = await actions.networkOperation({ node, op: payload, principal: 'ai' })
      return { ok: true, result }
    }),
  })

  /* ───────────────────── 宿主网络（NetworkManager / nftables） ───────────────────── */

  register({
    name: 'network_host',
    description: [
      '看这台机的宿主网络：网卡 / 路由 / DNS / NetworkManager 连接 / nftables 骨架 / ping 诊断。',
      '全是只读，直接执行。要改配置用 network_host_apply（会挂起等用户确认）。',
      '这台机的网络由 NetworkManager 管，容器网络由 podman netavark 管，防火墙是纯 nftables。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['interfaces', 'routes', 'dns', 'connections', 'connection', 'neighbors', 'firewall', 'diagnose'],
          description: 'interfaces=网卡与流量；routes=路由表；dns=系统 DNS；connections=NM 连接列表；connection=单条连接完整配置（要 name）；neighbors=邻居表；firewall=nft 表链骨架；diagnose=ping。',
        },
        name: { type: 'string', description: 'op=connection 时的连接名。' },
        target: { type: 'string', description: 'diagnose 时的目标，IP 或域名。' },
        count: { type: 'number', description: 'diagnose 发包数，1..10，默认 4。' },
      },
      required: ['op'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`读宿主网络失败：${value.error?.message ?? ''}`)
        const data = value.result
        if (Array.isArray(data)) {
          return text(lines([`${data.length} 项：`, ...data.map(line => '  ' + line)]))
        }
        return text(JSON.stringify(data, null, 2))
      },
    },
    execute: async (args) => guard(async () => {
      const op = assertEnum(String(args.op ?? ''), ['interfaces', 'routes', 'dns', 'connections', 'connection', 'neighbors', 'firewall', 'diagnose'], 'op')
      if (op === 'firewall') return { ok: true, result: await firewallSummary() }
      if (op === 'neighbors') return { ok: true, result: await actions.listNetworkNeighbors({ principal: 'ai' }) }
      if (op === 'connection') {
        return { ok: true, result: await actions.inspectNetworkConnection({ name: String(args.name ?? ''), principal: 'ai' }) }
      }
      if (op === 'diagnose') {
        return { ok: true, result: await diagnoseHost(args.target, { count: args.count }) }
      }
      const host = await hostNetwork()
      if (op === 'interfaces') {
        return {
          ok: true,
          result: host.interfaces.map(item => ({
            name: item.name,
            type: item.type,
            state: item.state,
            mtu: item.mtu,
            mac: item.mac,
            addresses: item.addresses.filter(a => a.family === 'inet').map(a => `${a.address}/${a.prefix}`),
            rxBytes: item.stats.rxBytes,
            txBytes: item.stats.txBytes,
          })),
        }
      }
      if (op === 'routes') return { ok: true, result: host.routes }
      if (op === 'dns') return { ok: true, result: { resolvConf: host.dns } }
      return { ok: true, result: host.connections }
    }),
  })

  register({
    name: 'network_host_apply',
    description: [
      '改宿主网络（NetworkManager 连接）：DNS / 静态 IP / 网关 / 启停连接。',
      '全部返回 {status:"pending", token} —— 改完那条连接会重启，网络会短暂中断，',
      '所以必须让用户去左侧「容器」面板的「待确认」里点一下。不要重复发起，不要试图自己确认。',
      'lxcbr0 / docker0 这类 externally 托管的连接改不动，会明确报错。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['dns', 'ipv4', 'ipv6', 'state', 'create', 'delete'],
          description: 'dns=改 DNS；ipv4/ipv6=改地址网关；state=启停；create=新建连接（要 type）；delete=删除连接。',
        },
        name: { type: 'string', description: 'NetworkManager 连接名，例如 "Ethernet connection 1"。create 时是新建的名字。' },
        type: {
          type: 'string',
          enum: ['ethernet', 'bridge', 'bond', 'vlan', 'wireguard', 'macvlan', 'dummy'],
          description: 'op=create 时的连接类型。team 需要 teamd，本机没有。',
        },
        interfaceName: { type: 'string', description: 'create 时绑定的接口名（bridge/bond 就是新虚拟网卡的名字）。' },
        parent: { type: 'string', description: 'create 时 VLAN / macvlan 挂在哪块网卡上。' },
        vlanId: { type: 'number', description: 'create VLAN 时的 id，1..4094。' },
        dns: { type: 'array', items: { type: 'string' }, description: 'DNS 列表，空数组表示清空。' },
        method: { type: 'string', enum: ['auto', 'manual', 'disabled', 'ignore'], description: 'ipv4 / ipv6 的获取方式。' },
        addresses: { type: 'array', items: { type: 'string' }, description: 'method=manual 时的 CIDR 列表，例如 ["10.0.0.5/24"]。' },
        gateway: { type: 'string', description: '网关。' },
        mtu: { type: 'number', description: 'MTU。' },
        routes: { type: 'array', items: { type: 'string' }, description: '静态路由，每项形如 "10.0.0.0/8 10.1.1.1 50"（目的 网关 metric）。' },
        up: { type: 'boolean', description: 'op=state 时 true=启用、false=停用。' },
      },
      required: ['op', 'name'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`改宿主网络失败：${value.error?.message ?? ''}`)
        const result = value.result
        if (result?.status === 'pending') {
          return text(`已挂起，等待用户确认：${result.message}\n（token ${result.token}）`)
        }
        return text(JSON.stringify(result, null, 2))
      },
    },
    execute: async (args) => guard(async () => {
      const op = assertEnum(String(args.op ?? ''), ['dns', 'ipv4', 'ipv6', 'state', 'create', 'delete'], 'op')
      const name = String(args.name ?? '').trim()
      if (!name) throw new CmError(ERR.BAD_ARGS, '需要连接名 name。')
      if (op === 'state') {
        return { ok: true, result: await actions.setNetworkLink({ name, up: args.up !== false, principal: 'ai' }) }
      }
      if (op === 'delete') {
        return { ok: true, result: await actions.deleteNetworkConnection({ name, principal: 'ai' }) }
      }
      if (op === 'create') {
        const type = assertEnum(String(args.type ?? ''), ['ethernet', 'bridge', 'bond', 'vlan', 'wireguard', 'macvlan', 'dummy'], 'type')
        const spec = { type, name }
        if (args.interfaceName) spec.interfaceName = assertContainerName(String(args.interfaceName))
        if (args.parent) spec.parent = assertContainerName(String(args.parent))
        if (args.vlanId !== undefined) spec.vlanId = clampInt(args.vlanId, 1, 4094, 'vlanId')
        if (args.mtu !== undefined) spec.mtu = clampInt(args.mtu, 68, 65536, 'mtu')
        const patch = ipPatch(args, op)
        if (Object.keys(patch).length) spec.patch = patch
        return { ok: true, result: await actions.createNetworkConnection({ spec, principal: 'ai' }) }
      }
      const patch = ipPatch(args, op)
      return { ok: true, result: await actions.applyNetworkConnection({ name, patch, principal: 'ai' }) }
    }),
  })

  /* ───────────────────── compose 项目 ───────────────────── */

  function needCompose() {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    return compose
  }

  /** 把 ipv4 / ipv6 / dns 这几类参数收成 patch；op 决定写进哪一栈。 */
  function ipPatch(args, op) {
    const patch = {}
    const bucket = op === 'ipv6' ? 'ipv6' : null
    const target = {}
    if (op === 'dns') {
      if (!Array.isArray(args.dns)) throw new CmError(ERR.BAD_ARGS, 'op=dns 需要 dns 数组。')
      target.dns = args.dns.map(item => assertIp(String(item)))
    } else {
      if (args.method) target.method = assertEnum(String(args.method), ['auto', 'manual', 'disabled', 'ignore'], 'method')
      if (Array.isArray(args.addresses)) {
        target.addresses = args.addresses.map(item =>
          bucket ? assertIp(String(item)) : assertCidr(String(item)))
      }
      if ('gateway' in args) target.gateway = args.gateway ? assertIp(String(args.gateway)) : ''
      if (Array.isArray(args.dns)) target.dns = args.dns.map(item => assertIp(String(item)))
      if (Array.isArray(args.routes)) target.routes = args.routes.map(item => String(item))
    }
    if (bucket) {
      if (Object.keys(target).length) patch.ipv6 = target
    } else {
      Object.assign(patch, target)
    }
    if (args.mtu !== undefined && op !== 'create') patch.mtu = clampInt(args.mtu, 0, 65536, 'mtu')
    return patch
  }
  function normalizeToolPorts(raw) {
    if (!Array.isArray(raw)) throw new CmError(ERR.BAD_ARGS, 'ports 得是数组，每项形如 {hostPort, containerPort, protocol?}。')
    return raw.map((item) => {
      const containerPort = Number(item && item.containerPort)
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        throw new CmError(ERR.BAD_ARGS, 'containerPort 必须是 1..65535 的整数。')
      }
      const hostPort = item && item.hostPort !== undefined && item.hostPort !== null && item.hostPort !== ''
        ? Number(item.hostPort)
        : containerPort
      if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
        throw new CmError(ERR.BAD_ARGS, 'hostPort 必须是 1..65535 的整数。')
      }
      const protocol = String((item && item.protocol) || 'tcp').toLowerCase()
      if (protocol !== 'tcp' && protocol !== 'udp') throw new CmError(ERR.BAD_ARGS, 'protocol 只支持 tcp / udp。')
      const out = { containerPort, hostPort, protocol }
      if (item && item.hostIp) out.hostIp = String(item.hostIp)
      return out
    })
  }

  register({
    name: 'compose_projects',
    description: [
      '列出 podman-compose 项目：根目录下每个一级子目录算一个项目，目录里要有一份 compose 文件。',
      '给每个项目的服务、容器状态、端口，以及没被任何项目接管的游离容器。只读。',
      '改端口用 compose_set_ports；启停用 compose_action。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('读不到项目：' + (value.error && value.error.message ? value.error.message : ''))
      const data = value.result || {}
      const out = ['根目录：' + ((data.layout && data.layout.podmanRoot) || '—')]
      const projects = Array.isArray(data.projects) ? data.projects : []
      out.push('项目（' + projects.length + '）：')
      for (const project of projects) {
        if (project.broken) {
          out.push('  ! ' + project.name + '  compose 文件有问题：' + project.problem)
          continue
        }
        const counts = project.counts || {}
        out.push('  ' + project.name + '  ' + (counts.running || 0) + '/' + (counts.total || 0) + ' 运行  ' + (project.file || ''))
        for (const service of project.services || []) {
          const ports = (service.publishedPorts || []).map(p => p.hostPort + '->' + p.containerPort).join(' ')
          out.push('     - ' + service.name + '  ' + service.state + (ports ? '  ' + ports : ''))
        }
      }
      const orphans = Array.isArray(data.orphans) ? data.orphans : []
      if (orphans.length > 0) out.push('游离容器（不属于任何项目）：' + orphans.length)
      return text(lines(out))
    } },
    execute: async () => guard(async () => ({ ok: true, result: await needCompose().list() })),
  })

  register({
    name: 'compose_inspect',
    description: '看一个 compose 项目的详情：服务表、容器、端口、冲突，以及 compose 文件原文。只读。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名（根目录下的一级子目录名）。' },
        withYaml: { type: 'boolean', description: 'true = 一起返回 compose 文件原文。' },
      },
      required: ['project'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('读不到项目：' + (value.error && value.error.message ? value.error.message : ''))
      const data = value.result || {}
      const project = data.project || data
      const out = ['项目：' + (project.name || '—') + '  ' + (project.file || '')]
      for (const service of project.services || []) {
        const ports = (service.publishedPorts || []).map(p => p.hostPort + '->' + p.containerPort).join(' ')
        out.push('  - ' + service.name + '  ' + service.image + '  ' + service.state + (ports ? '  ' + ports : ''))
      }
      if (Array.isArray(project.conflicts) && project.conflicts.length > 0) {
        out.push('端口冲突：' + project.conflicts.length + ' 处（先处理再 up）')
      }
      const yamlText = data.yaml
      return text(lines(out) + (yamlText ? '\n\n' + yamlText : ''))
    } },
    execute: async (args) => guard(async () => {
      const project = String(args.project || '').trim()
      if (!project) throw new CmError(ERR.BAD_ARGS, '需要 project。')
      const service = needCompose()
      const detail = await service.detail(project)
      const result = { project: detail }
      if (args.withYaml !== false) result.yaml = service.yamlText(project)
      return { ok: true, result }
    }),
  })

  register({
    name: 'compose_action',
    description: [
      'compose 项目的生命周期操作。',
      'op=up / restart：直接执行（up 前会自动预检宿主端口冲突）。',
      'op=down / adopt：会停或删容器，返回 {status:"pending", token} —— ',
      '必须让用户在左侧「容器」面板确认，不要重复发起，也不要试图自己确认。',
      'op=logs：读某个项目的容器日志。op=install-runtime：装 podman-compose 的 venv（要联网，慢）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名。op=install-runtime 时可省略。' },
        op: { type: 'string', enum: ['up', 'restart', 'down', 'adopt', 'logs', 'install-runtime'] },
        service: { type: 'string', description: 'op=logs 时只看某个服务的日志。' },
        tail: { type: 'number', description: 'op=logs 的行数，1..2000，默认 200。' },
      },
      required: ['op'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('操作失败：' + (value.error && value.error.message ? value.error.message : ''))
      const result = value.result || {}
      if (result.status === 'pending') return text('已挂起，等待用户确认：' + (result.summary || '') + '\n（token ' + result.token + '）')
      if (result.text !== undefined) return text(String(result.text) || '（没有日志输出）')
      const data = result.result || result
      if (data && data.message) return text(String(data.message))
      return text(JSON.stringify(data, null, 2))
    } },
    execute: async (args) => guard(async () => {
      const service = needCompose()
      const op = assertEnum(String(args.op || ''), ['up', 'restart', 'down', 'adopt', 'logs', 'install-runtime'], 'op')
      const project = String(args.project || '').trim()
      if (op === 'install-runtime') {
        const installed = await service.install({ principal: 'ai' })
        return { ok: true, result: installed }
      }
      if (!project) throw new CmError(ERR.BAD_ARGS, '需要 project。')
      if (op === 'logs') {
        const textValue = await service.logs(project, { service: args.service ? String(args.service) : '', tail: Number(args.tail) || 200 })
        return { ok: true, result: textValue }
      }
      if (op === 'down') return { ok: true, result: await actions.composeDown({ name: project, principal: 'ai' }) }
      if (op === 'adopt') return { ok: true, result: await actions.composeAdopt({ name: project, principal: 'ai' }) }
      if (op === 'restart') return { ok: true, result: await service.restart(project, { principal: 'ai' }) }
      return { ok: true, result: await service.up(project, { principal: 'ai' }) }
    }),
  })

  register({
    name: 'compose_set_ports',
    description: [
      '改 compose 项目里某个服务的端口映射。写回 compose 文件（保留注释、自动留 .bak 备份），',
      '不会自动重建容器 —— 要生效再调 compose_action op=up。',
      '这就是 cockpit-podman 做不到的那件事：上面板直接改端口。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名。' },
        service: { type: 'string', description: '服务名（compose 文件里 services 下的键）。' },
        ports: {
          type: 'array',
          description: '新的端口列表，整份替换该服务的 ports。每项 {containerPort, hostPort?, protocol?}。',
          items: {
            type: 'object',
            properties: {
              hostPort: { type: 'number' },
              containerPort: { type: 'number' },
              protocol: { type: 'string', enum: ['tcp', 'udp'] },
              hostIp: { type: 'string' },
            },
            required: ['containerPort'],
          },
        },
      },
      required: ['project', 'service', 'ports'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('改端口失败：' + (value.error && value.error.message ? value.error.message : ''))
      const data = value.result || {}
      return text('已写回 ' + data.name + '/' + data.service + '：' +
        (data.ports || []).map(p => (p.hostPort || p.containerPort) + '->' + p.containerPort + '/' + (p.protocol || 'tcp')).join(' ') +
        (data.backup ? '\n备份：' + data.backup : '') +
        '\n要让改动生效，接着调 compose_action op=up。')
    } },
    execute: async (args) => guard(async () => {
      const project = String(args.project || '').trim()
      const serviceName = String(args.service || '').trim()
      if (!project) throw new CmError(ERR.BAD_ARGS, '需要 project。')
      if (!serviceName) throw new CmError(ERR.BAD_ARGS, '需要 service。')
      const ports = normalizeToolPorts(args.ports)
      const result = needCompose().setServicePorts(project, serviceName, ports, { principal: 'ai' })
      return { ok: true, result }
    }),
  })

  /* ───────────────────── LXC：快照 / 克隆 / 挂载点 ───────────────────── */

  register({
    name: 'lxc_snapshot',
    description: [
      'LXC 快照：op=list 只读；op=create / restore / delete 都会动 rootfs，返回 {status:"pending", token}，',
      '必须让用户在左侧「容器」面板确认。ext4 上快照是整份复制，占空间也慢。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        name: { type: 'string', description: '容器名。' },
        op: { type: 'string', enum: ['list', 'create', 'restore', 'delete'] },
        snapshot: { type: 'string', description: 'op=restore / delete 时的快照名（snap0 这种）。' },
        comment: { type: 'string', description: 'op=create 时的备注。' },
      },
      required: ['node', 'name', 'op'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('快照操作失败：' + (value.error && value.error.message ? value.error.message : ''))
      const result = value.result || {}
      if (result.status === 'pending') return text('已挂起，等待用户确认：' + (result.summary || '') + '\n（token ' + result.token + '）')
      const data = result.result || result
      const snapshots = Array.isArray(data.snapshots) ? data.snapshots : (Array.isArray(data) ? data : null)
      if (snapshots) {
        return text(lines(['快照（' + snapshots.length + '）：', ...snapshots.map(item => '  ' + item.name + '  ' + (item.detail || ''))]))
      }
      return text(JSON.stringify(data, null, 2))
    } },
    execute: async (args) => guard(async () => {
      const node = String(args.node || '')
      const name = String(args.name || '')
      const op = assertEnum(String(args.op || ''), ['list', 'create', 'restore', 'delete'], 'op')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      if (!name) throw new CmError(ERR.BAD_ARGS, '需要 name。')
      if (op === 'list') return { ok: true, result: await registry.listSnapshots(node, name) }
      return { ok: true, result: await actions.lxcSnapshot({
        node,
        name,
        op,
        options: { snapshot: args.snapshot, comment: args.comment },
        principal: 'ai',
      }) }
    }),
  })

  register({
    name: 'lxc_clone',
    description: '克隆一个 LXC 容器（整份复制 rootfs，源容器必须已停止）。直接执行，不动源容器。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        name: { type: 'string', description: '源容器名。' },
        newName: { type: 'string', description: '新容器名。' },
      },
      required: ['node', 'name', 'newName'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(value.ok
      ? '已克隆成 ' + (value.result && value.result.name ? value.result.name : '') + '（' + (value.result && value.result.state ? value.result.state : '') + '）'
      : '克隆失败：' + (value.error && value.error.message ? value.error.message : '')) },
    execute: async (args) => guard(async () => {
      const node = String(args.node || '')
      const name = String(args.name || '')
      const newName = String(args.newName || '').trim()
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      if (!name) throw new CmError(ERR.BAD_ARGS, '需要 name。')
      if (!newName) throw new CmError(ERR.BAD_ARGS, '需要 newName。')
      return { ok: true, result: await actions.lxcClone({ node, name, newName, principal: 'ai' }) }
    }),
  })

  register({
    name: 'lxc_mounts',
    description: [
      'LXC 挂载点（lxc.mount.entry）。op=list 只读；op=set 会写宿主上的容器 config，返回 pending，要用户确认。',
      'mounts 每项 {host, target, options?}，两头都必须是绝对路径。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        name: { type: 'string', description: '容器名。' },
        op: { type: 'string', enum: ['list', 'set'] },
        mounts: {
          type: 'array',
          description: 'op=set 时的完整挂载列表（整份替换）。',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              target: { type: 'string' },
              options: { type: 'string' },
            },
            required: ['host', 'target'],
          },
        },
      },
      required: ['node', 'name', 'op'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => {
      if (!value.ok) return text('挂载点操作失败：' + (value.error && value.error.message ? value.error.message : ''))
      const result = value.result || {}
      if (result.status === 'pending') return text('已挂起，等待用户确认：' + (result.summary || '') + '\n（token ' + result.token + '）')
      const data = result.result || result
      const mounts = Array.isArray(data.mounts) ? data.mounts : []
      return text(lines(['挂载点（' + mounts.length + '）：', ...mounts.map(item => '  ' + item.host + ' -> ' + item.target + '  ' + (item.options || ''))]))
    } },
    execute: async (args) => guard(async () => {
      const node = String(args.node || '')
      const name = String(args.name || '')
      const op = assertEnum(String(args.op || ''), ['list', 'set'], 'op')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      if (!name) throw new CmError(ERR.BAD_ARGS, '需要 name。')
      if (op === 'list') return { ok: true, result: await registry.readMounts(node, name) }
      return { ok: true, result: await actions.lxcSetMounts({
        node,
        name,
        mounts: Array.isArray(args.mounts) ? args.mounts : [],
        principal: 'ai',
      }) }
    }),
  })

  register({
    name: 'pending_operations',
    description: [
      '查待确认队列：op=list 列出所有挂起的危险操作，op=status 查某一条。',
      '只读。确认与取消只能由用户在左侧「容器」面板点，AI 没有任何确认通道。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'status'] },
        token: { type: 'string', description: 'op=status 时的 token。' },
      },
      required: ['op'],
    },
    output: { schema: OK_SCHEMA, render: (_args, value) => text(value.ok
      ? (Array.isArray(value.pending)
        ? lines([`${value.pending.length} 条待确认：`, ...value.pending.map(item => `  ${item.status}  ${item.summary}  (${item.token.slice(0, 14)}…)`)])
        : `${value.pending?.status ?? '未知'}：${value.pending?.summary ?? ''}`)
      : `查不到：${value.error?.message ?? ''}`) },
    execute: async (args) => guard(async () => {
      if (args.op === 'status') {
        const token = String(args.token ?? '')
        if (!token) throw new CmError(ERR.BAD_ARGS, 'op=status 需要 token。')
        const record = actions.pendingGet(token)
        if (!record) throw new CmError(ERR.NOT_FOUND, `没有这条待确认：${token}`)
        return { ok: true, pending: record }
      }
      if (args.op !== 'list') throw new CmError(ERR.BAD_ARGS, 'op 只能是 list / status。')
      return { ok: true, pending: actions.pendingList({ includeFinished: false }) }
    }),
  })

  register({
    name: 'container_jobs',
    description: [
      '查长任务队列：克隆、快照、导出、提交镜像这些会跑几分钟的操作都入队，立刻返回任务号。',
      'op=list 看全部（含排队与已结束），op=get 看某一条的尾部输出，op=cancel 取消排队中或正在跑的任务。',
      '提交类操作的返回里如果带 status=job，就说明它进了队列 —— 这时候别去查容器状态，先查任务。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'get', 'cancel'] },
        jobId: { type: 'string', description: 'op=get / op=cancel 时的任务号。' },
        finished: { type: 'boolean', description: 'op=list 时是否带上已结束的任务（默认 true）。' },
      },
      required: ['op'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => text(value.ok
        ? (Array.isArray(value.jobs)
          ? lines([
            value.summary
              ? `任务：${value.summary.running} 个在跑、${value.summary.queued} 个排队、${value.summary.failed} 个失败。`
              : '没有任务队列。',
            ...value.jobs.map(job => `  [${job.status}] ${job.label}  (${job.id})${job.error ? '  ← ' + job.error : ''}`),
          ])
          : (() => {
            const job = value.job
            if (!job) return '没有这个任务。'
            return lines([
              `[${job.status}] ${job.label}`,
              `  任务号 ${job.id}  开始 ${job.startedAt ?? '—'}  结束 ${job.finishedAt ?? '—'}`,
              job.error ? `  错误：${job.error}` : '',
              job.tail && job.tail.length > 0 ? '尾部输出：' : '（还没有输出）',
              ...(job.tail ?? []).slice(-20),
            ])
          })())
        : `任务队列读不到：${value.error?.message ?? ''}`),
    },
    execute: async (args) => guard(async () => {
      if (!jobs) throw new CmError(ERR.INTERNAL, '这个实例没有任务队列。')
      const op = String(args.op ?? '')
      if (op === 'list') {
        return {
          ok: true,
          jobs: jobs.list({ includeFinished: args.finished !== false }),
          summary: jobs.summary(),
        }
      }
      const jobId = String(args.jobId ?? '')
      if (!jobId) throw new CmError(ERR.BAD_ARGS, 'op=get / op=cancel 需要 jobId。')
      if (op === 'get') {
        const job = jobs.get(jobId)
        if (!job) throw new CmError(ERR.NOT_FOUND, `没有这个任务：${jobId}`)
        return { ok: true, job }
      }
      if (op === 'cancel') return { ok: true, job: jobs.cancel(jobId, 'ai') }
      throw new CmError(ERR.BAD_ARGS, 'op 只能是 list / get / cancel。')
    }),
  })

  register({
    name: 'lxc_backup',
    description: [
      'LXC 容器的导出 / 导入 / 归档管理。op=list 列归档，op=export 导出一个容器（整份 rootfs 打包，几分钟，返回 jobId），',
      'op=import 从归档建容器（同样返回 jobId），op=delete 删归档（走 pending，要人在面板确认）。',
      '归档默认落在 /var/lib/dsh-container-manager/exports。导出不会停容器，但运行中导出的是一份活文件系统。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'export', 'import', 'delete'] },
        node: { type: 'string', description: NODE_DESCRIPTION },
        name: { type: 'string', description: 'op=export 要导出的容器名；op=import 新建的容器名；op=delete 的归档名。' },
        file: { type: 'string', description: 'op=import 时的归档绝对路径。' },
        dir: { type: 'string', description: '归档目录（绝对路径），省略就用默认目录。' },
        instanceOnly: { type: 'boolean', description: 'op=export 时是否只导实例、不带快照（默认 true）。' },
      },
      required: ['op'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => text(value.ok
        ? (Array.isArray(value.files)
          ? lines([`归档目录 ${value.dir}：${value.files.length} 份`, ...value.files.map(entry => `  ${entry.name}  ${Math.round(entry.bytes / 1048576)}MB  ${entry.at}`)])
          : (value.message || JSON.stringify(value.result ?? null)))
        : `失败：${value.error?.message ?? ''}`),
    },
    execute: async (args) => guard(async () => {
      const op = String(args.op ?? '')
      const node = String(args.node ?? 'local-lxc')
      if (op === 'list') {
        const listed = await actions.listLxcExports({ node, dir: args.dir ? String(args.dir) : undefined })
        return { ok: true, dir: listed.dir, files: listed.files }
      }
      if (op === 'export') {
        const result = await actions.lxcExport({
          node,
          name: String(args.name ?? ''),
          dir: args.dir ? String(args.dir) : undefined,
          instanceOnly: args.instanceOnly !== false,
        })
        return { ok: true, result, message: result.message }
      }
      if (op === 'import') {
        const result = await actions.lxcImport({
          node,
          file: String(args.file ?? ''),
          name: String(args.name ?? ''),
        })
        return { ok: true, result, message: result.message }
      }
      if (op === 'delete') {
        const result = await actions.deleteLxcExport({
          node,
          name: String(args.name ?? ''),
          dir: args.dir ? String(args.dir) : undefined,
        })
        return { ok: true, result, message: result.message ?? '已提交删除。' }
      }
      throw new CmError(ERR.BAD_ARGS, 'op 只能是 list / export / import / delete。')
    }),
  })

  register({
    name: 'container_capabilities',
    description: [
      '探测这台机真正有什么能力：rootless 的 subuid/subgid、uidmap 工具、存储驱动、cgroup 版本、',
      '用户 linger、pasta/slirp4netns、skopeo、LXC 能用的存储后端，以及每条「能不能用」的原因与修复命令。',
      '只读，60 秒缓存。功能不可用之前先调它，别凭猜测说「应该可以」。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        refresh: { type: 'boolean', description: 'true = 跳过缓存重新探测。' },
      },
      required: [],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => text(value.ok
        ? lines([
          `能力（${value.capability.node}）：`,
          ...value.capability.checks.map(check => `  ${check.state === 'ok' ? '●' : check.state === 'degraded' ? '◐' : check.state === 'unknown' ? '?' : '○'} ${check.label}：${check.detail}${check.fix ? '  → ' + check.fix : ''}`),
          value.capability.lxcBackends ? `  LXC 存储后端可用：${value.capability.lxcBackends.join(' / ')}` : '',
        ])
        : `探测不到：${value.error?.message ?? ''}`),
    },
    execute: async (args) => guard(async () => {
      if (!capabilities) throw new CmError(ERR.INTERNAL, '能力探针没接上。')
      const nodeId = String(args.node ?? 'local-podman')
      const node = configStore.get().nodes.find(item => item.id === nodeId)
      if (!node) throw new CmError(ERR.NOT_FOUND, `没有这个节点：${nodeId}`)
      if (args.refresh) capabilities.invalidate()
      return { ok: true, capability: await capabilities.probe(node) }
    }),
  })


  register({
    name: 'container_quadlet',
    description: [
      'Quadlet（systemd 管的容器定义）纳管。op=list 列 ~/.config/containers/systemd 与 /etc/containers/systemd 里的',
      '.container/.pod/.kube/.image/.volume/.network 文件，附它们对应的 unit 状态；op=reload 重新生成 unit；',
      'op=start/stop/restart 启停某个 unit。',
      'podman 4.3 及更早没有 quadlet 生成器 —— 那时候 list 会明说「文件能看、unit 问不到」，不假装能用。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'reload', 'start', 'stop', 'restart'] },
        node: { type: 'string', description: NODE_DESCRIPTION },
        unit: { type: 'string', description: 'op=start/stop/restart 时的 unit 名，例如 demo.service。' },
      },
      required: ['op'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`失败：${value.error?.message ?? ''}`)
        if (value.quadlets) {
          const listed = value.quadlets
          const head = listed.supported
            ? `Quadlet 可用（${listed.items.length} 份文件）`
            : 'Quadlet 不可用：' + (listed.reason || '')
          return text(lines([
            head,
            ...listed.items.map(item => `  ${item.unit}  ${item.state ? (item.state.activeState + '/' + item.state.loadState) : '状态?'}  ${item.image || ''}  ${item.path}`),
            ...listed.problems.map(problem => '  ! ' + problem),
          ]))
        }
        return text(value.message || JSON.stringify(value.result ?? null))
      },
    },
    execute: async (args) => guard(async () => {
      const op = String(args.op ?? '')
      const node = String(args.node ?? 'local-podman')
      if (op === 'list') return { ok: true, quadlets: await registry.quadlets(node) }
      const unit = String(args.unit ?? '')
      if (!unit) throw new CmError(ERR.BAD_ARGS, 'op=' + op + ' 需要 unit。')
      if (op === 'reload') {
        const result = await registry.quadletReload(node)
        return { ok: true, result, message: 'unit 已重新生成。' }
      }
      if (!['start', 'stop', 'restart'].includes(op)) {
        throw new CmError(ERR.BAD_ARGS, 'op 只能是 list / reload / start / stop / restart。')
      }
      const result = await registry.quadletAction(node, unit, op)
      return { ok: true, result, message: `已 ${op} ${unit}` }
    }),
  })

  register({
    name: 'container_diagnose',
    description: [
      '在容器里跑一轮只读网络诊断：网卡与地址、路由表、resolv.conf、hosts、域名解析、ICMP、TCP 连通。',
      '返回每段的原始输出，外加几条「能确定的事」的判读（没 default 路由 / DNS 指向 127.0.0.53 / 解析不出结果 等）。',
      '容器必须运行中（要进容器里跑 ip / getent / nc）。容器里缺哪个命令会明说，不留空白。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: NODE_DESCRIPTION },
        ref: { type: 'string', description: '容器名或 id。' },
        host: { type: 'string', description: '解析 / 连通性测试的目标，默认 1.1.1.1。' },
        port: { type: 'number', description: 'TCP 测试端口，默认 443。' },
      },
      required: ['ref'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`失败：${value.error?.message ?? ''}`)
        const diag = value.diagnosis ?? {}
        const notes = (diag.notes ?? []).map(note => `  [${note.level === 'ok' ? '好' : note.level === 'warn' ? '疑' : '？'}] ${note.text}`)
        const body = (diag.sections ?? []).flatMap(section => [
          `${section.label}：`,
          ...section.text.split('\n').slice(0, 12).map(line => '  ' + line),
        ])
        return text(lines([`目标 ${diag.target?.host}:${diag.target?.port}`, ...notes, '', ...body]))
      },
    },
    execute: async (args) => guard(async () => {
      const node = String(args.node ?? 'local-podman')
      const ref = String(args.ref ?? '')
      if (!ref) throw new CmError(ERR.BAD_ARGS, '需要 ref（容器名）。')
      const diagnosis = await registry.diagnose(node, ref, { host: args.host, port: args.port })
      return { ok: true, diagnosis }
    }),
  })

  register({
    name: 'container_files',
    description: [
      '看和改容器里的文件。op=list 列目录，op=read 读一个文件（文本给内容；二进制给 base64 并标明），',
      'op=write 写文件、op=mkdir 建目录、op=remove 删除 —— 这三个走 pending，要人在面板确认。',
      'LXC 停着也能读（rootfs 在宿主上）；Podman 列目录要容器运行中，单个文件的读写对停止的容器也有效。',
      '单次读写上限 8MB（AI 写入上限 256KB）。路径必须是容器内绝对路径，不接受 ..。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'remove'] },
        node: { type: 'string', description: NODE_DESCRIPTION },
        ref: { type: 'string', description: '容器名或 id。' },
        path: { type: 'string', description: '容器内绝对路径，例如 /etc/nginx/nginx.conf。' },
        text: { type: 'string', description: 'op=write 时的文本内容（utf8）。' },
        base64: { type: 'string', description: 'op=write 时的二进制内容（base64），与 text 二选一。' },
        maxBytes: { type: 'number', description: 'op=read 时最多读多少字节，默认 8MB。' },
      },
      required: ['op', 'ref'],
    },
    output: {
      schema: OK_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(`失败：${value.error?.message ?? ''}`)
        if (value.entries) {
          const list = value.entries.slice(0, 200).map(entry => `  ${entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : '-'} ${String(entry.size).padStart(9)}  ${entry.name}`)
          return text(lines([`${value.path}（${value.entries.length} 项）`, ...list, value.truncated ? '  ……只列了前 2000 项' : '']))
        }
        if (value.binary) return text(`${value.path}：${value.size} 字节二进制（base64 见返回值的 base64 字段）。`)
        if (typeof value.text === 'string') return text(lines([`${value.path}：${value.size} 字节`, value.text]))
        return text(value.message || JSON.stringify(value.result ?? null))
      },
    },
    execute: async (args) => guard(async () => {
      if (!files) throw new CmError(ERR.INTERNAL, '文件服务没接上。')
      const op = String(args.op ?? '')
      const node = String(args.node ?? 'local-podman')
      const ref = String(args.ref ?? '')
      if (!ref) throw new CmError(ERR.BAD_ARGS, '需要 ref（容器名）。')
      if (op === 'list') {
        const listed = await files.list({ node, ref, path: String(args.path ?? '/') })
        return { ok: true, ...listed }
      }
      if (op === 'read') {
        const read = await files.read({
          node,
          ref,
          path: String(args.path ?? ''),
          maxBytes: args.maxBytes,
        })
        return { ok: true, ...read }
      }
      if (op === 'write') {
        if (args.text == null && args.base64 == null) {
          throw new CmError(ERR.BAD_ARGS, 'op=write 需要 text 或 base64。')
        }
        const result = await actions.filesWrite({
          node,
          ref,
          path: String(args.path ?? ''),
          text: args.text ?? null,
          base64: args.base64 ?? null,
        })
        return { ok: true, result, message: result.message ?? '已提交写入。' }
      }
      if (op === 'mkdir') {
        const result = await actions.filesMkdir({ node, ref, path: String(args.path ?? '') })
        return { ok: true, result, message: result.message ?? '已提交建目录。' }
      }
      if (op === 'remove') {
        const result = await actions.filesRemove({ node, ref, path: String(args.path ?? '') })
        return { ok: true, result, message: result.message ?? '已提交删除。' }
      }
      throw new CmError(ERR.BAD_ARGS, 'op 只能是 list / read / write / mkdir / remove。')
    }),
  })
}

