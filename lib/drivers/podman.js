/**
 * Podman 驱动
 *
 * 两种传输共用一套命令构造：
 *   local：直接 execFile('podman', args)
 *   ssh  ：execFile('ssh', [...opts, host, 'podman', ...args])
 * 永远走参数数组，不经过 shell。
 *
 * 本机是 rootless Podman 4.3.1：能建 bridge/macvlan 网络、能 connect/disconnect，
 * 但静态 IP、<1024 端口这类 rootful 才稳的操作会如实报错——驱动不假装。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { buildDiagnoseScript, parseDiagnoseOutput, readDiagnose } from '../../helper/diagnose.mjs'
import { buildQuadletList, isQuadletFile, parseSystemctlShow } from '../quadlet.js'
import { checkImageUpdates } from '../updates.js'
import { packFile, unpackSingleFile } from '../tar.js'
import {
  CmError,
  ERR,
  execFileAsync,
  execFileBuffer,
  execFileWithInput,
  parseJson,
  requireOk,
} from '../util.js'

const ACTIONS = {
  start: { args: ['start'], timeoutMs: 60_000 },
  stop: { args: ['stop', '-t', '10'], timeoutMs: 60_000 },
  restart: { args: ['restart', '-t', '10'], timeoutMs: 90_000 },
  pause: { args: ['pause'], timeoutMs: 30_000 },
  unpause: { args: ['unpause'], timeoutMs: 30_000 },
  delete: { args: ['rm', '-f'], timeoutMs: 60_000 },
}

export const PODMAN_ACTIONS = Object.keys(ACTIONS)

function first(value) {
  return Array.isArray(value) ? value[0] : value
}

/** 「a b c」/「a,b」/数组 都能吃进来，统一成字符串数组。 */
function toList(value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  return String(value).split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

/** 端口表：每条必须是 { hostPort, containerPort }，端口范围 1..65535。 */
function normalizePortList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const containerPort = Number(item.containerPort)
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new Error(`容器端口不合法：${item.containerPort}`)
    }
    const hostPortRaw = item.hostPort
    const hostPort = hostPortRaw === undefined || hostPortRaw === null || hostPortRaw === '' ? null : Number(hostPortRaw)
    if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)) {
      throw new Error(`宿主端口不合法：${hostPortRaw}`)
    }
    out.push({
      hostIp: String(item.hostIp ?? '').trim(),
      hostPort,
      containerPort,
      protocol: String(item.protocol ?? 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp',
    })
  }
  return out
}

/** 挂载表：source 和 destination 都必须给，destination 必须是绝对路径。 */
function normalizeVolumeList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const source = String(item.source ?? '').trim()
    const destination = String(item.destination ?? '').trim()
    if (!source) throw new Error('挂载缺少宿主路径。')
    if (!destination.startsWith('/')) throw new Error(`挂载目标必须是绝对路径：${destination || '(空)'}`)
    out.push({ source, destination, ro: Boolean(item.ro) })
  }
  return out
}

/** 环境变量：对象或 {KEY, value} 数组都接受，键名必须是常见的环境变量形态。 */
function normalizeEnvMap(value) {
  const out = {}
  if (!value) return out
  const entries = Array.isArray(value)
    ? value.map(item => [String(item?.key ?? item?.name ?? '').trim(), item?.value])
    : Object.entries(value)
  for (const [key, raw] of entries) {
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名不合法：${key}`)
    out[key] = raw === undefined || raw === null ? '' : String(raw)
  }
  return out
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 健康检查状态。
 *
 * podman ps 不带独立字段，但 Status 文本里就有「Up 2 minutes (unhealthy)」。
 * 与其为了一个徽章给每个容器再跑一次 inspect，不如从这行字里读 —— 读不到就是 null，
 * 不要凭空给一个「健康」的结论。
 */
export function parseHealth(text) {
  // docker 风格会写成「(health: starting)」，podman 两种都可能出，一起认。
  const match = /\((?:health: )?(healthy|unhealthy|starting)\)/i.exec(String(text ?? ''))
  return match ? match[1].toLowerCase() : null
}

/** 把 ps 里难看懂的字段摊平成人能读的形状。 */
export function normalizePsRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.Id ?? raw.ID ?? raw.id ?? '')
  if (!id) return null
  const names = raw.Names ?? raw.Names ?? raw.Name
  const name = Array.isArray(names) ? String(names[0] ?? id.slice(0, 12)) : String(names ?? id.slice(0, 12))
  const ports = Array.isArray(raw.Ports)
    ? raw.Ports.map(port => ({
      hostIp: port.host_ip ?? port.HostIp ?? '',
      hostPort: asNumber(port.host_port ?? port.HostPort),
      containerPort: asNumber(port.container_port ?? port.ContainerPort),
      protocol: port.protocol ?? port.Protocol ?? 'tcp',
      range: asNumber(port.range ?? 1) ?? 1,
    })).filter(port => port.containerPort)
    : []
  let networks = []
  if (Array.isArray(raw.Networks)) {
    networks = raw.Networks.map(item => typeof item === 'string' ? item : String(item?.name ?? item?.Name ?? '')).filter(Boolean)
  } else if (raw.NetworkSettings && raw.NetworkSettings.Networks) {
    networks = Object.keys(raw.NetworkSettings.Networks)
  }
  return {
    id,
    shortId: id.slice(0, 12),
    name,
    image: String(raw.Image ?? ''),
    imageId: String(raw.ImageID ?? ''),
    state: String(raw.State ?? raw.Status ?? '').toLowerCase(),
    status: String(raw.Status ?? raw.State ?? ''),
    // podman ps 给的是 State 字符串（running / exited / created / paused），
    // 不是 inspect 那种 State 对象。compose 状态算的是这个布尔值，所以必须显式给。
    running: String(raw.State ?? '').toLowerCase() === 'running',
    paused: String(raw.State ?? '').toLowerCase() === 'paused',
    created: raw.CreatedAt != null ? normalizeTime(raw.CreatedAt) : String(raw.Created ?? ''),
    createdText: String(raw.Created ?? ''),
    pid: asNumber(raw.Pid),
    exitCode: asNumber(raw.ExitCode),
    // compose 靠标签认「这个容器属于哪个项目 / 哪个服务」，ps 里就得带上。
    labels: raw.Labels && typeof raw.Labels === 'object' ? raw.Labels : {},
    startedAt: raw.StartedAt != null ? normalizeTime(raw.StartedAt) : null,
    pod: String(raw.PodName ?? raw.Pod ?? '') || null,
    isInfra: Boolean(raw.IsInfra),
    // 有健康检查的容器才有值；没有健康检查时是 null，面板据此决定画不画徽章。
    health: parseHealth(raw.Status ?? raw.State),
    ports,
    networks,
    runtime: 'podman',
  }
}

function normalizeTime(value) {
  if (typeof value === 'number') {
    // podman 给秒级 unix 时间戳
    return new Date(value * 1000).toISOString()
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return new Date(Number(value) * 1000).toISOString()
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value)
}

/** inspect 里的网络段：列表与详情共用，避免两套解析漂移。 */
function networksFromInspect(raw) {
  const rawNetworks = raw?.NetworkSettings?.Networks ?? {}
  const networks = []
  for (const [name, network] of Object.entries(rawNetworks)) {
    if (!network || typeof network !== 'object') continue
    networks.push({
      name,
      ip: String(network.IPAddress ?? ''),
      ip6: String(network.GlobalIPv6Address ?? ''),
      mac: String(network.MacAddress ?? ''),
      gateway: String(network.Gateway ?? ''),
      subnet: String(network.Subnet ?? ''),
    })
  }
  if (networks.length === 0) {
    const mode = String(raw?.HostConfig?.NetworkMode ?? '').trim()
    if (mode && mode !== 'default') networks.push({ name: mode, ip: '', ip6: '', mac: '', gateway: '', subnet: '' })
  }
  return networks
}

/** inspect 归一化：注意**不返回 env 的值**（里面常有密码）。 */
export function normalizeInspect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const state = raw.State ?? {}
  const config = raw.Config ?? {}
  const networkSettings = raw.NetworkSettings ?? {}
  const networks = networksFromInspect(raw)
  const ports = []
  const portMap = networkSettings.Ports ?? {}
  for (const [container, bindings] of Object.entries(portMap)) {
    const [portText, protocol = 'tcp'] = container.split('/')
    const containerPort = asNumber(portText)
    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const binding of bindings) {
        ports.push({
          hostIp: String(binding.HostIp ?? ''),
          hostPort: asNumber(binding.HostPort),
          containerPort,
          protocol,
        })
      }
    } else {
      ports.push({ hostIp: '', hostPort: null, containerPort, protocol })
    }
  }
  const mounts = Array.isArray(raw.Mounts)
    ? raw.Mounts.map(mount => ({
      type: String(mount.Type ?? ''),
      source: String(mount.Source ?? mount.Name ?? ''),
      destination: String(mount.Destination ?? ''),
      rw: mount.RW !== false,
    }))
    : []
  const envKeys = Array.isArray(config.Env)
    ? config.Env.map(line => String(line).split('=')[0]).filter(Boolean).sort()
    : []
  // 重建容器时补丁是整张 env 表替换，所以前端必须拿到完整键值才敢编辑。
  // 值可能含密码，前端默认遮起来，点一下才显示。
  const env = {}
  for (const line of Array.isArray(config.Env) ? config.Env : []) {
    const text = String(line)
    const at = text.indexOf('=')
    if (at > 0) env[text.slice(0, at)] = text.slice(at + 1)
  }
  return {
    id: String(raw.Id ?? ''),
    shortId: String(raw.Id ?? '').slice(0, 12),
    name: String(raw.Name ?? '').replace(/^\//, ''),
    state: String(state.Status ?? '').toLowerCase(),
    running: Boolean(state.Running),
    paused: Boolean(state.Paused),
    pid: asNumber(state.Pid),
    exitCode: asNumber(state.ExitCode),
    startedAt: state.StartedAt ?? null,
    finishedAt: state.FinishedAt ?? null,
    created: raw.Created ?? null,
    image: String(raw.ImageName ?? raw.Image ?? ''),
    imageId: String(raw.Image ?? ''),
    command: Array.isArray(config.Cmd) ? config.Cmd : config.Cmd ? [String(config.Cmd)] : [],
    entrypoint: config.Entrypoint ?? null,
    envKeys,
    env,
    labels: config.Labels ?? {},
    mounts,
    ports,
    networks,
    networkMode: String(raw.HostConfig?.NetworkMode ?? ''),
    restartPolicy: raw.HostConfig?.RestartPolicy ?? null,
    // 资源限制：podman update 能改的就是这几个（4.3.1 不支持 --restart，也没有 --pids-limit）。
    // 注意 HostConfig 不会随 update 更新，改完之后这里读到的还是建容器时的值 ——
    // 要看真实上限得读容器内 cgroup，这一条写进 README 了，别拿它当「没生效」的证据。
    limits: {
      memory: asNumber(raw.HostConfig?.Memory),
      memoryReservation: asNumber(raw.HostConfig?.MemoryReservation),
      memorySwap: raw.HostConfig?.MemorySwap ?? null,
      cpus: raw.HostConfig?.NanoCpus ? raw.HostConfig.NanoCpus / 1e9 : null,
      cpuShares: asNumber(raw.HostConfig?.CpuShares),
      cpusetCpus: String(raw.HostConfig?.CpusetCpus ?? ''),
      pidsLimit: raw.HostConfig?.PidsLimit ?? null,
      blkioWeight: asNumber(raw.HostConfig?.BlkioWeight),
    },
    // 这些 podman update 改不了，只能重建容器 —— 前端据此决定「改完要不要提示重建」。
    immutable: {
      user: String(config.User ?? ''),
      workdir: String(config.WorkingDir ?? ''),
      hostname: String(config.Hostname ?? ''),
      privileged: Boolean(raw.HostConfig?.Privileged),
      autoRemove: Boolean(raw.HostConfig?.AutoRemove),
      capAdd: Array.isArray(raw.HostConfig?.CapAdd) ? raw.HostConfig.CapAdd : [],
      capDrop: Array.isArray(raw.HostConfig?.CapDrop) ? raw.HostConfig.CapDrop : [],
      securityOpt: Array.isArray(raw.HostConfig?.SecurityOpt) ? raw.HostConfig.SecurityOpt : [],
    },
    // 健康检查详情：连续失败次数比「unhealthy」四个字有用得多。
    health: state.Health
      ? {
        status: String(state.Health.Status ?? '').toLowerCase(),
        failingStreak: asNumber(state.Health.FailingStreak) ?? 0,
        // podman 的 Log 可能很长，只留最后 20 条，面板也只显示这些。
        log: Array.isArray(state.Health.Log)
          ? state.Health.Log.slice(-20).map(entry => ({
            at: entry.Start ?? entry.End ?? null,
            exitCode: asNumber(entry.ExitCode),
            output: String(entry.Output ?? '').slice(0, 2000),
          }))
          : [],
      }
      : null,
    runtime: 'podman',
  }
}

export function normalizeNetwork(raw) {
  if (!raw || typeof raw !== 'object') return null
  const subnets = Array.isArray(raw.subnets) ? raw.subnets : []
  const subnet = subnets.map(item => String(item.subnet ?? '')).filter(Boolean).join(',')
  const gateway = subnets.map(item => String(item.gateway ?? '')).filter(Boolean).join(',')
  const containers = []
  for (const [id, info] of Object.entries(raw.containers ?? {})) {
    if (!info || typeof info !== 'object') continue
    const interfaces = Object.values(info.interfaces ?? {})
    const addresses = []
    for (const iface of interfaces) {
      const list = iface && typeof iface === 'object' ? iface.ip_addresses ?? [] : []
      for (const address of Array.isArray(list) ? list : []) {
        if (address && typeof address === 'string') addresses.push(address)
      }
    }
    containers.push({
      id: String(id),
      name: String(info.name ?? ''),
      ips: addresses,
    })
  }
  return {
    name: String(raw.name ?? raw.Name ?? ''),
    id: String(raw.id ?? raw.Id ?? ''),
    driver: String(raw.driver ?? raw.Driver ?? ''),
    interface: String(raw.network_interface ?? raw.NetworkInterface ?? ''),
    subnet,
    gateway,
    internal: Boolean(raw.internal ?? raw.Internal),
    dnsEnabled: Boolean(raw.dns_enabled ?? raw.DNSEnabled),
    ipv6: Boolean(raw.ipv6_enabled ?? raw.IPv6Enabled),
    labels: raw.labels ?? raw.Labels ?? {},
    containers,
    runtime: 'podman',
  }
}

/** 把 "134.5MB" / "1.2GB" 这种读数换成字节。 */
export function sizeToBytes(text) {
  const match = /^([\d.]+)\s*([a-zA-Z]+)?$/.exec(String(text ?? '').trim())
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  const unit = String(match[2] || 'B').toLowerCase()
  const scale = {
    b: 1, kb: 1024, kib: 1024,
    mb: 1024 ** 2, mib: 1024 ** 2,
    gb: 1024 ** 3, gib: 1024 ** 3,
    tb: 1024 ** 4, tib: 1024 ** 4,
  }
  return Math.round(value * (scale[unit] ?? 1))
}

/** 把 `podman stats --format json` 的一行摊平。 */
export function normalizeStatsRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? raw.Name ?? '')
  if (!name) return null
  const usage = String(raw.mem_usage ?? raw.MemUsage ?? '').split('/')
  const cpu = Number(String(raw.cpu_percent ?? raw.CPUPerc ?? '0').replace('%', ''))
  const memPercent = Number(String(raw.mem_percent ?? raw.MemPerc ?? '0').replace('%', ''))
  return {
    id: String(raw.id ?? raw.ID ?? ''),
    name,
    cpuPercent: Number.isFinite(cpu) ? cpu : 0,
    cpuTime: String(raw.cpu_time ?? ''),
    avgCpu: Number(String(raw.avg_cpu ?? '0').replace('%', '')) || 0,
    memUsed: sizeToBytes(usage[0]),
    memLimit: sizeToBytes(usage[1]),
    memPercent: Number.isFinite(memPercent) ? memPercent : 0,
    netIo: String(raw.net_io ?? ''),
    blockIo: String(raw.block_io ?? ''),
    pids: Number(raw.pids) || 0,
  }
}

/**
 * @param {object} node 配置里的节点
 * @param {{exec?: typeof execFileAsync}} [options] 测试可注入假的 execFileAsync
 */
export function createPodmanDriver(node, options = {}) {
  const exec = options.exec ?? execFileAsync

  function run(args, { timeoutMs = 30_000, maxBuffer, signal } = {}) {
    if (node.transport === 'ssh') {
      const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
      if (node.port) sshArgs.push('-p', String(node.port))
      if (node.identityFile) sshArgs.push('-i', node.identityFile)
      sshArgs.push('--', node.user ? `${node.user}@${node.host}` : String(node.host))
      sshArgs.push('podman', ...args)
      return exec('ssh', sshArgs, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}), ...(signal ? { signal } : {}) })
    }
    return exec('podman', args, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}), ...(signal ? { signal } : {}) })
  }

  let infoCache = null
  let infoCacheAt = 0

  async function info({ force = false } = {}) {
    const now = Date.now()
    if (!force && infoCache && now - infoCacheAt < 30_000) return infoCache
    const result = await run(['info', '--format', 'json'], { timeoutMs: 20_000 })
    if (result.missing) {
      infoCache = {
        ok: false,
        reason: node.transport === 'ssh'
          ? `SSH 到 ${node.host} 不可用（找不到 ssh 命令）。`
          : '找不到 podman 命令（PATH 里没有）。',
        code: ERR.MISSING_BINARY,
      }
      infoCacheAt = now
      return infoCache
    }
    if (result.timedOut) {
      infoCache = { ok: false, reason: 'podman info 超时了。', code: ERR.TIMEOUT }
      infoCacheAt = now
      return infoCache
    }
    if (result.code !== 0) {
      infoCache = {
        ok: false,
        reason: (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join('\n') || `podman info 退出码 ${result.code}`,
        code: ERR.NODE_UNAVAILABLE,
      }
      infoCacheAt = now
      return infoCache
    }
    let parsed
    try {
      parsed = parseJson(result.stdout, 'podman info ')
    } catch (error) {
      infoCache = { ok: false, reason: error.message, code: ERR.INTERNAL }
      infoCacheAt = now
      return infoCache
    }
    const host = parsed?.host ?? parsed?.Host ?? {}
    const version = parsed?.version ?? parsed?.Version ?? {}
    infoCache = {
      ok: true,
      version: String(version.Version ?? version.version ?? ''),
      platform: String(host.arch ?? parsed?.host?.arch ?? ''),
      os: String(host.os ?? parsed?.host?.os ?? ''),
      rootless: Boolean(host.security?.rootless ?? host.Security?.Rootless),
      networkBackend: String(host.networkBackend ?? host.NetworkBackend ?? ''),
      cgroupVersion: String(host.cgroupVersion ?? host.CgroupVersion ?? ''),
      kernel: String(parsed?.host?.kernel ?? host.kernel ?? ''),
      eventLogger: String(host.eventLogger ?? ''),
    }
    infoCacheAt = now
    return infoCache
  }

  async function listContainers() {
    const result = await run(['ps', '-a', '--format', 'json'], { timeoutMs: 25_000 })
    const text = requireOk(result, {
      command: 'podman ps',
      code: ERR.PODMAN_ERROR,
      hint: node.transport === 'ssh' ? `确认能 ssh 到 ${node.host}，且对方有 podman。` : undefined,
    })
    const rows = parseJson(text, 'podman ps ') ?? []
    if (!Array.isArray(rows)) throw new CmError(ERR.PODMAN_ERROR, 'podman ps 没有给出数组。')
    const containers = rows.map(normalizePsRow).filter(Boolean)
    if (containers.length === 0) return containers
    // Podman 4.3.1 的 ps JSON 经常把 Networks 留空；网络地址只在 inspect 里。
    // 一次 inspect 全部 id，只取网络段，env 等敏感字段不进入返回值。
    try {
      const ids = containers.slice(0, 100).map(container => container.id)
      const inspected = await run(['inspect', ...ids], { timeoutMs: 25_000 })
      if (inspected.code === 0) {
        const details = parseJson(inspected.stdout, 'podman inspect ') ?? []
        const byId = new Map((Array.isArray(details) ? details : [details]).filter(Boolean).map(item => [String(item.Id ?? ''), item]))
        for (const container of containers) {
          const networks = networksFromInspect(byId.get(container.id))
          if (networks.length > 0) container.networks = networks
        }
      }
    } catch {
      // inspect 失败就保留 ps 的降级数据，列表本身照样可用。
    }
    return containers
  }

  async function inspectRaw(ref) {
    const result = await run(['inspect', String(ref)], { timeoutMs: 25_000 })
    const text = requireOk(result, { command: 'podman inspect', code: ERR.NOT_FOUND })
    const rows = parseJson(text, 'podman inspect ') ?? []
    const first = Array.isArray(rows) ? rows[0] : rows
    if (!first) throw new CmError(ERR.NOT_FOUND, `找不到容器：${ref}`)
    return first
  }

  async function inspect(ref) {
    return normalizeInspect(await inspectRaw(ref))
  }

  async function logs(ref, tail = 100, options = {}) {
    // podman logs 把容器的 stderr 也写到自己的 stderr，两个都要收。
    const args = ['logs', '--tail', String(tail)]
    if (options.since) args.push('--since', String(options.since))
    args.push(String(ref))
    const result = await run(args, { timeoutMs: 30_000, maxBuffer: 8 * 1024 * 1024 })
    const text = requireOk(result, { command: 'podman logs', code: ERR.PODMAN_ERROR })
    const merged = [result.stdout, result.stderr].filter(Boolean).join('')
    const clipped = merged.length > 1_000_000 ? merged.slice(-1_000_000) : merged
    return { text: clipped, truncated: merged.length > clipped.length }
  }

  async function act(ref, action) {
    const spec = ACTIONS[String(action)]
    if (!spec) throw new CmError(ERR.BAD_ARGS, `不支持的 Podman 动作：${action}。可用：${PODMAN_ACTIONS.join(' / ')}`)
    const result = await run([...spec.args, String(ref)], { timeoutMs: spec.timeoutMs })
    const text = requireOk(result, {
      command: `podman ${spec.args[0]}`,
      code: ERR.PODMAN_ERROR,
      hint: action === 'delete' ? '容器可能在运行中或名字不对。' : undefined,
    })
    return { action, output: text.trim(), ref: String(ref) }
  }

  function buildCreateArgs(spec, uts) {
    const args = ['run', '-d', '--label', 'dsh-cm=1']
    if (spec.name) args.push('--name', String(spec.name))
    if (spec.network) args.push('--network', String(spec.network))
    if (spec.restart) args.push('--restart', String(spec.restart))
    if (spec.memory) args.push('--memory', String(spec.memory))
    if (spec.memoryReservation) args.push('--memory-reservation', String(spec.memoryReservation))
    if (spec.memorySwap !== undefined && spec.memorySwap !== null && spec.memorySwap !== '') {
      args.push('--memory-swap', String(spec.memorySwap))
    }
    if (spec.cpus !== undefined && spec.cpus !== null) args.push('--cpus', String(spec.cpus))
    if (spec.cpuShares) args.push('--cpu-shares', String(spec.cpuShares))
    if (spec.cpusetCpus) args.push('--cpuset-cpus', String(spec.cpusetCpus))
    if (spec.blkioWeight) args.push('--blkio-weight', String(spec.blkioWeight))
    // pids 只能建时设 —— 4.3.1 的 update 没有 --pids-limit。
    if (spec.pidsLimit !== undefined && spec.pidsLimit !== null && spec.pidsLimit !== '') {
      args.push('--pids-limit', String(spec.pidsLimit))
    }
    if (spec.privileged) args.push('--privileged')
    if (spec.user) args.push('--user', String(spec.user))
    if (spec.workdir) args.push('--workdir', String(spec.workdir))
    for (const one of spec.capAdd ?? []) args.push('--cap-add', String(one))
    for (const one of spec.capDrop ?? []) args.push('--cap-drop', String(one))
    for (const one of spec.securityOpt ?? []) args.push('--security-opt', String(one))
    if (spec.autoRemove) args.push('--rm')
    if (uts) args.push('--uts', String(uts))
    if (spec.hostname && uts !== 'host') args.push('--hostname', String(spec.hostname))
    if (spec.entrypoint) {
      const parts = Array.isArray(spec.entrypoint) ? spec.entrypoint : [spec.entrypoint]
      if (parts.length > 0) args.push('--entrypoint', JSON.stringify(parts.map(String)))
    }
    for (const port of spec.ports ?? []) {
      const host = port.hostIp && port.hostIp !== '0.0.0.0' ? `${port.hostIp}:` : ''
      args.push('-p', `${host}${port.hostPort}:${port.containerPort}/${port.protocol ?? 'tcp'}`)
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    for (const volume of spec.volumes ?? []) {
      args.push('-v', `${volume.source}:${volume.destination}${volume.ro ? ':ro' : ''}`)
    }
    args.push(String(spec.image))
    for (const item of spec.command ?? []) args.push(String(item))
    return args
  }

  /**
   * 从 podman inspect 还原成 create(spec) 能吃的配置。
   *
   * podman 的心智模型和 LXC 不一样：容器参数在 `run` 那一刻定死，
   * 端口、挂载、环境变量、重启策略这些改了必须重建容器 —— 没有「改配置文件」这回事。
   */
  function specFromInspect(raw) {
    const config = raw.Config ?? {}
    const host = raw.HostConfig ?? {}
    const networkSettings = raw.NetworkSettings ?? {}
    const env = {}
    for (const line of config.Env ?? []) {
      const text = String(line)
      const at = text.indexOf('=')
      if (at > 0) env[text.slice(0, at)] = text.slice(at + 1)
    }
    const ports = []
    for (const [key, bindings] of Object.entries(networkSettings.Ports ?? {})) {
      const [portText, protocol = 'tcp'] = key.split('/')
      const containerPort = Number(portText)
      if (!Number.isFinite(containerPort)) continue
      if (!Array.isArray(bindings) || bindings.length === 0) continue
      for (const binding of bindings) {
        ports.push({
          hostIp: String(binding.HostIp ?? ''),
          hostPort: Number(binding.HostPort),
          containerPort,
          protocol,
        })
      }
    }
    const volumes = []
    for (const one of raw.Mounts ?? []) {
      const source = String(one.Source ?? one.Name ?? '')
      const destination = String(one.Destination ?? '')
      if (!source || !destination) continue
      volumes.push({ source, destination, ro: one.RW === false })
    }
    const restartName = String(host.RestartPolicy?.Name ?? '')
    return {
      name: String(raw.Name ?? '').replace(/^\//, ''),
      image: String(config.Image ?? raw.ImageName ?? ''),
      command: Array.isArray(config.Cmd) ? config.Cmd.map(String) : (config.Cmd ? [String(config.Cmd)] : []),
      entrypoint: config.Entrypoint ?? null,
      env,
      ports,
      volumes,
      network: host.NetworkMode && host.NetworkMode !== 'default' ? String(host.NetworkMode) : '',
      restart: restartName && restartName !== 'no' ? restartName : '',
      hostname: String(config.Hostname ?? ''),
      user: String(config.User ?? ''),
      workdir: String(config.WorkingDir ?? ''),
      memory: host.Memory ? String(host.Memory) : '',
      memoryReservation: host.MemoryReservation ? String(host.MemoryReservation) : '',
      memorySwap: host.MemorySwap && host.MemorySwap !== 0 ? String(host.MemorySwap) : '',
      cpus: host.NanoCpus ? host.NanoCpus / 1e9 : null,
      cpuShares: host.CpuShares || null,
      cpusetCpus: String(host.CpusetCpus ?? ''),
      blkioWeight: host.BlkioWeight || null,
      pidsLimit: host.PidsLimit ?? null,
      privileged: Boolean(host.Privileged),
      capAdd: Array.isArray(host.CapAdd) ? host.CapAdd.map(String) : [],
      capDrop: Array.isArray(host.CapDrop) ? host.CapDrop.map(String) : [],
      securityOpt: Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [],
      autoRemove: Boolean(host.AutoRemove),
      uts: host.UtsMode && host.UtsMode !== 'private' ? String(host.UtsMode) : null,
    }
  }

  /**
   * 按 podman 的方式改容器配置：读旧配置 → 叠补丁 → 用新名字建一个 → 起来之后换名字 → 删旧的。
   *
   * 顺序是「先建新的、再动旧的」，任何一步失败都尽量把旧容器恢复原名，
   * 不搞「先删后建」——那会在失败时把用户的容器连同数据一起弄没。
   */
  async function recreate(ref, patch = {}) {
    const old = await inspectRaw(ref)
    const spec = specFromInspect(old)
    const originalName = spec.name || String(ref)
    const wasRunning = Boolean(old.State?.Running)
    const applied = {}

    // --- 把补丁叠到 spec 上，只认明确给了的字段，没给的保持原样 ---
    if (patch.ports !== undefined) { spec.ports = normalizePortList(patch.ports); applied.ports = spec.ports }
    if (patch.volumes !== undefined) { spec.volumes = normalizeVolumeList(patch.volumes); applied.volumes = spec.volumes }
    if (patch.env !== undefined) { spec.env = normalizeEnvMap(patch.env); applied.env = spec.env }
    if (patch.restart !== undefined) { spec.restart = String(patch.restart ?? ''); applied.restart = spec.restart }
    if (patch.command !== undefined) {
      spec.command = Array.isArray(patch.command) ? patch.command.map(String) : String(patch.command ?? '').split(/\s+/).filter(Boolean)
      applied.command = spec.command
    }
    if (patch.entrypoint !== undefined) { spec.entrypoint = patch.entrypoint || null; applied.entrypoint = spec.entrypoint }
    if (patch.network !== undefined) { spec.network = String(patch.network ?? ''); applied.network = spec.network }
    if (patch.hostname !== undefined) { spec.hostname = String(patch.hostname ?? ''); applied.hostname = spec.hostname }
    if (patch.user !== undefined) { spec.user = String(patch.user ?? ''); applied.user = spec.user }
    if (patch.workdir !== undefined) { spec.workdir = String(patch.workdir ?? ''); applied.workdir = spec.workdir }
    if (patch.memory !== undefined) { spec.memory = String(patch.memory ?? ''); applied.memory = spec.memory }
    if (patch.memoryReservation !== undefined) { spec.memoryReservation = String(patch.memoryReservation ?? ''); applied.memoryReservation = spec.memoryReservation }
    if (patch.memorySwap !== undefined) { spec.memorySwap = String(patch.memorySwap ?? ''); applied.memorySwap = spec.memorySwap }
    if (patch.cpus !== undefined) { spec.cpus = patch.cpus === '' || patch.cpus === null ? null : Number(patch.cpus); applied.cpus = spec.cpus }
    if (patch.cpuShares !== undefined) { spec.cpuShares = patch.cpuShares === '' || patch.cpuShares === null ? null : Number(patch.cpuShares); applied.cpuShares = spec.cpuShares }
    if (patch.cpusetCpus !== undefined) { spec.cpusetCpus = String(patch.cpusetCpus ?? ''); applied.cpusetCpus = spec.cpusetCpus }
    if (patch.blkioWeight !== undefined) { spec.blkioWeight = patch.blkioWeight === '' || patch.blkioWeight === null ? null : Number(patch.blkioWeight); applied.blkioWeight = spec.blkioWeight }
    if (patch.pidsLimit !== undefined) { spec.pidsLimit = patch.pidsLimit === '' || patch.pidsLimit === null ? null : Number(patch.pidsLimit); applied.pidsLimit = spec.pidsLimit }
    if (patch.privileged !== undefined) { spec.privileged = Boolean(patch.privileged); applied.privileged = spec.privileged }
    if (patch.autoRemove !== undefined) { spec.autoRemove = Boolean(patch.autoRemove); applied.autoRemove = spec.autoRemove }
    if (patch.capAdd !== undefined) { spec.capAdd = toList(patch.capAdd); applied.capAdd = spec.capAdd }
    if (patch.capDrop !== undefined) { spec.capDrop = toList(patch.capDrop); applied.capDrop = spec.capDrop }
    if (patch.securityOpt !== undefined) { spec.securityOpt = toList(patch.securityOpt); applied.securityOpt = spec.securityOpt }
    if (Object.keys(applied).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')

    // --- 起一个新的，名字临时加后缀 ---
    const stamp = Date.now().toString(36).slice(-5)
    const tmpName = `${originalName}-cm${stamp}`
    const retiredName = `${originalName}-cmold${stamp}`
    const nextSpec = { ...spec, name: tmpName }
    const created = await create(nextSpec)
    const warnings = [...(created.warnings ?? [])]

    // --- 新容器已经起来了，开始换名字。任何一步失败都尽量把旧容器改回原名 ---
    try {
      // 已经停着就别再 stop（会报容器不在运行），吞掉这一步的错。
      await act(originalName, 'stop').catch(() => {})
      await run(['rename', String(originalName), retiredName], { timeoutMs: 30_000 })
    } catch (error) {
      // 旧容器还没换走，直接把新的删掉，现场回到操作之前。
      await run(['rm', '-f', tmpName], { timeoutMs: 60_000 }).catch(() => {})
      throw error
    }

    try {
      await run(['rename', tmpName, originalName], { timeoutMs: 30_000 })
      if (!wasRunning) await act(originalName, 'stop').catch(() => {})
    } catch (error) {
      // 新容器改不过名 —— 把旧容器改回来，再把新的删掉，别留一个半成品占着名字。
      await run(['rename', retiredName, originalName], { timeoutMs: 30_000 }).catch(() => {})
      await run(['rm', '-f', tmpName], { timeoutMs: 60_000 }).catch(() => {})
      throw error
    }

    // --- 旧容器留着只有害处：它的名字和数据卷都已经让位了，删掉 ---
    const removed = await run(['rm', '-f', retiredName], { timeoutMs: 60_000 })
    if (removed.code !== 0) {
      warnings.push(`旧容器 ${retiredName} 没删掉，可以手动 podman rm -f ${retiredName}：${String(removed.stderr ?? '').trim()}`)
    }

    const detail = await inspect(originalName).catch(() => null)
    return {
      ref: originalName,
      name: originalName,
      replaced: retiredName,
      applied,
      warnings,
      detail,
    }
  }

  async function create(spec) {
    const warnings = []
    let uts = spec.uts || null
    let result = await run(buildCreateArgs(spec, uts), { timeoutMs: 180_000 })

    // 有些主机的宿主 systemd 用 seccomp 挡了 sethostname（ProtectHostname=yes，或 ProtectSystem 连带装上的
    // filter），crun 建独立 UTS namespace 时会被拒。这不是命令写错：退到宿主 UTS 就能跑。
    // 退完把根因留下来，不装作没发生 —— 用户关掉宿主那一项之后，这个降级不会再触发。
    if (result.code !== 0 && /sethostname|UTS namespace/i.test(String(result.stderr ?? '')) && uts !== 'host') {
      // crun 失败时容器已经进了 storage（状态 created），不清掉重试会撞名。
      // 只在 sethostname 这一路失败时清理，而且先确认名字确实在，避免误删用户的同名容器。
      if (spec.name) {
        const exists = await run(['container', 'exists', String(spec.name)], { timeoutMs: 10_000 })
        if (exists.code === 0) await run(['rm', '-f', String(spec.name)], { timeoutMs: 30_000 })
      }
      result = await run(buildCreateArgs(spec, 'host'), { timeoutMs: 180_000 })
      if (result.code === 0) {
        uts = 'host'
        warnings.push('宿主挡了 sethostname（通常是 systemd 的 ProtectHostname=yes，或 ProtectSystem 连带装的 seccomp filter），已自动改用 --uts=host（容器 hostname 跟随宿主）。关掉宿主 systemd 里那一项就不需要这个降级。')
      }
    }

    const text = requireOk(result, {
      command: 'podman run',
      code: ERR.PODMAN_ERROR,
      hint: /sethostname|UTS namespace/i.test(String(result.stderr ?? ''))
        ? '宿主挡了 sethostname：改用 uts:"host"，或者关掉宿主 systemd 的 ProtectHostname。'
        : 'rootless 下 <1024 的宿主端口通常绑不上，换一个高位端口试试。',
    })
    const id = text.trim().split('\n').pop() ?? ''
    let detail = null
    try {
      detail = await inspect(id || String(spec.name ?? ''))
    } catch {
      detail = null
    }
    const wanted = spec.memory ? memoryBytes(spec.memory) : null
    if (wanted !== null && detail && detail.limits && detail.limits.memory !== wanted) {
      warnings.push(
        `内存上限 ${spec.memory} 只写进了容器配置，cgroup 没真的设限（memory.max 仍是 max）—— ` +
        '这台机是 rootless podman 4.3.1，rootless cgroup v2 支持不完整。要真限制得用 rootful，或升级到 4.4+。',
      )
    }
    return { id, detail, warnings, uts }
  }

  /** 把 256m / 1g / 268435456 换成字节数；认不出返回 null。 */
  function memoryBytes(text) {
    const match = /^(\d+)\s*([bkmg]?)$/i.exec(String(text ?? '').trim())
    if (!match) return null
    const units = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
    return Number(match[1]) * units[match[2].toLowerCase()]
  }

  /** 本地已有镜像（创建表单的候选，失败了不影响创建）。 */
  async function registryLogin(registry, username, password) {
    if (node.transport === 'ssh') throw new CmError(ERR.BAD_ARGS, '远端 SSH 节点的 registry 登录暂未开放。')
    const host = String(registry || '').trim()
    const user = String(username || '').trim()
    const secret = String(password ?? '')
    if (!host || /[\s/]/.test(host) || !user || !secret) throw new CmError(ERR.BAD_ARGS, '需要 registry、用户名和密码。')
    const result = await execFileWithInput('podman', ['login', '--username', user, '--password-stdin', host], secret + '\n', { timeoutMs: 30_000 })
    if (result.code !== 0) throw new CmError(ERR.PODMAN_ERROR, (result.stderr || result.stdout || '').trim() || 'registry 登录失败。')
    return { registry: host, username: user }
  }

  async function listImages() {
    const result = await run(['images', '--format', 'json'], { timeoutMs: 25_000 })
    if (result.code !== 0) return []
    const rows = parseJson(result.stdout, 'podman images ') ?? []
    const out = []
    for (const row of rows) {
      const repository = row?.Repository ?? row?.Names?.[0] ?? ''
      if (!repository || repository === '<none>') continue
      const tag = row?.Tag && row.Tag !== '<none>' ? row.Tag : 'latest'
      const reference = repository.includes(':') && !repository.includes('@')
        ? repository
        : `${repository}:${tag}`
      out.push({
        reference,
        repository,
        tag,
        size: row?.Size ?? null,
        created: row?.CreatedAt ?? row?.Created ?? null,
      })
    }
    return out.sort((a, b) => a.reference.localeCompare(b.reference))
  }

  /**
   * 改运行中容器的 cgroup 限制（podman 4.3.1 的 update 只支持这些）。
   * 传 0 / '' 表示取消该项限制。重启策略走不了这条路 —— 调用方要改就重建。
   */
  async function readCgroupLimits(ref) {
    const script = [
      'printf "memory="; cat /sys/fs/cgroup/memory.max 2>/dev/null || true',
      'printf "cpu="; cat /sys/fs/cgroup/cpu.max 2>/dev/null || true',
      'printf "pids="; cat /sys/fs/cgroup/pids.max 2>/dev/null || true',
    ].join(';')
    try {
      const result = await run(['exec', String(ref), 'sh', '-c', script], { timeoutMs: 15_000 })
      if (result.code !== 0) return { memoryMax: null, cpuMax: null, pidsMax: null }
      const values = Object.fromEntries(String(result.stdout).split('\n').map(line => {
        const at = line.indexOf('=')
        return at > 0 ? [line.slice(0, at), line.slice(at + 1).trim()] : [line, '']
      }))
      const memoryMax = /^\d+$/.test(values.memory || '') ? Number(values.memory) : null
      const [quota, period] = String(values.cpu || '').split(/\s+/)
      const cpuMax = /^\d+$/.test(quota || '') && /^\d+$/.test(period || '') && Number(period) > 0 ? Number(quota) / Number(period) : null
      const pidsMax = /^\d+$/.test(values.pids || '') ? Number(values.pids) : null
      return { memoryMax, cpuMax, pidsMax }
    } catch {
      return { memoryMax: null, cpuMax: null, pidsMax: null }
    }
  }

  async function updateCgroup(ref, limits = {}) {
    if (limits.restart !== undefined) {
      throw new CmError(
        ERR.BAD_ARGS,
        '这个 podman 版本（4.3.1）的 update 不支持 --restart（实测报 unknown flag），改重启策略只能重建容器。',
        '用「以此配置新建」建一个新容器，确认新容器正常后再删旧的。',
      )
    }
    const args = ['update']
    const applied = {}
    if (limits.memory !== undefined && limits.memory !== null && limits.memory !== '') {
      args.push('--memory', String(limits.memory))
      applied.memory = String(limits.memory)
    }
    if (limits.memoryReservation !== undefined && limits.memoryReservation !== null && limits.memoryReservation !== '') {
      args.push('--memory-reservation', String(limits.memoryReservation))
      applied.memoryReservation = String(limits.memoryReservation)
    }
    if (limits.memorySwap !== undefined && limits.memorySwap !== null && limits.memorySwap !== '') {
      args.push('--memory-swap', String(limits.memorySwap))
      applied.memorySwap = String(limits.memorySwap)
    }
    if (limits.blkioWeight !== undefined && limits.blkioWeight !== null && limits.blkioWeight !== '') {
      args.push('--blkio-weight', String(limits.blkioWeight))
      applied.blkioWeight = Number(limits.blkioWeight)
    }
    if (limits.cpus !== undefined && limits.cpus !== null && limits.cpus !== '') {
      args.push('--cpus', String(limits.cpus))
      applied.cpus = limits.cpus
    }
    if (limits.cpuShares !== undefined && limits.cpuShares !== null && limits.cpuShares !== '') {
      args.push('--cpu-shares', String(limits.cpuShares))
      applied.cpuShares = Number(limits.cpuShares)
    }
    if (limits.cpusetCpus !== undefined && limits.cpusetCpus !== null && limits.cpusetCpus !== '') {
      args.push('--cpuset-cpus', String(limits.cpusetCpus))
      applied.cpusetCpus = String(limits.cpusetCpus)
    }
    if (limits.pidsLimit !== undefined) {
      throw new CmError(
        ERR.BAD_ARGS,
        '这个 podman 版本（4.3.1）的 update 没有 --pids-limit（实测 unknown flag），PID 上限只能建容器时给。',
        '要改 pids 只能重建容器。',
      )
    }
    if (args.length === 1) {
      throw new CmError(ERR.BAD_ARGS, '没有要改的限制项（memory / memoryReservation / memorySwap / cpus / cpuShares / cpusetCpus / blkioWeight）。')
    }
    args.push(String(ref))
    const result = await run(args, { timeoutMs: 60_000 })
    const text = requireOk(result, {
      command: 'podman update',
      code: ERR.PODMAN_ERROR,
      hint: 'rootless 下 cgroup 委派可能被拒；错误原文会直接显示，不会假装成功。',
    })
    let detail = null
    try {
      detail = await inspect(ref)
    } catch {
      detail = null
    }
    // podman 4.3.1 的 rootless 模式会「接受 --memory 但什么都不写」：命令返回 0。
    // 只信容器内真实 cgroup，不信 HostConfig。
    const cgroup = await readCgroupLimits(ref)
    const verified = {}
    const unknown = []
    if (applied.memory !== undefined) {
      const wanted = memoryBytes(applied.memory)
      if (cgroup.memoryMax === null) unknown.push('memory')
      else {
        verified.memory = cgroup.memoryMax
        if (cgroup.memoryMax !== wanted) {
          throw new CmError(
            ERR.PODMAN_ERROR,
            `podman update 返回成功，但 memory.max 没变（期望 ${wanted}，实际 ${cgroup.memoryMax}）。`,
            '要真正限制资源得用 rootful podman，或升级到 podman 4.4+（rootless cgroup v2 才完整）。',
          )
        }
      }
    }
    if (applied.cpus !== undefined) {
      if (cgroup.cpuMax === null) unknown.push('cpus')
      else {
        const actual = cgroup.cpuMax
        verified.cpus = actual
        const wanted = Number(applied.cpus)
        if (Number.isFinite(actual) && Number.isFinite(wanted) && Math.abs(actual - wanted) > 0.01) {
          throw new CmError(ERR.PODMAN_ERROR, `podman update 返回成功，但 cpu.max 对应 ${actual} 核，期望 ${wanted} 核。`)
        }
      }
    }
    return { ref: String(ref), applied, verified, unknown, output: text.trim(), detail }
  }

  async function listPods() {
    const result = await run(['pod', 'ps', '--format', 'json'], { timeoutMs: 25_000 })
    const text = requireOk(result, { command: 'podman pod ps', code: ERR.PODMAN_ERROR })
    const rows = parseJson(text, 'podman pod ps ') ?? []
    return (Array.isArray(rows) ? rows : []).map(row => ({
      id: String(row.Id ?? row.id ?? ''),
      name: String(row.Name ?? row.name ?? ''),
      state: String(row.Status ?? row.status ?? '').toLowerCase(),
      status: String(row.Status ?? row.status ?? ''),
      created: row.Created ?? row.created ?? null,
      infraId: String(row.InfraId ?? row.infraId ?? ''),
      containers: Number(row.NumberOfContainers ?? row.containers ?? 0) || 0,
    }))
  }

  async function podAction(name, action) {
    const pod = String(name ?? '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(pod)) throw new CmError(ERR.BAD_ARGS, 'Pod 名不合法。')
    const verb = String(action ?? '')
    if (!['start', 'stop', 'restart', 'remove'].includes(verb)) throw new CmError(ERR.BAD_ARGS, 'Pod 操作只支持 start / stop / restart / remove。')
    const args = verb === 'remove' ? ['pod', 'rm', '-f', pod] : ['pod', verb, pod]
    const result = await run(args, { timeoutMs: 90_000 })
    requireOk(result, { command: 'podman pod ' + verb, code: ERR.PODMAN_ERROR })
    return { name: pod, action: verb }
  }

  async function createPod({ name, share = '', infra = true } = {}) {
    const pod = String(name ?? '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(pod)) throw new CmError(ERR.BAD_ARGS, 'Pod 名不合法。')
    const args = ['pod', 'create', '--name', pod]
    if (share) {
      for (const part of String(share).split(',').filter(Boolean)) {
        if (!['cgroup', 'ipc', 'net', 'pid', 'uts'].includes(part)) throw new CmError(ERR.BAD_ARGS, 'Pod share 只支持 cgroup/ipc/net/pid/uts。')
        args.push('--share', part)
      }
    }
    if (infra === false) args.push('--infra=false')
    const result = await run(args, { timeoutMs: 60_000 })
    const id = requireOk(result, { command: 'podman pod create', code: ERR.PODMAN_ERROR }).trim()
    return { id, name: pod }
  }

  async function listNetworks() {
    const result = await run(['network', 'ls', '--format', 'json'], { timeoutMs: 25_000 })
    const text = requireOk(result, { command: 'podman network ls', code: ERR.PODMAN_ERROR })
    const rows = parseJson(text, 'podman network ls ') ?? []
    if (!Array.isArray(rows)) throw new CmError(ERR.PODMAN_ERROR, 'podman network ls 没有给出数组。')
    const names = rows.map(row => String(row.Name ?? row.name ?? '')).filter(Boolean)
    const detailed = await Promise.all(names.map(async name => {
      try {
        return await inspectNetwork(name)
      } catch {
        return null
      }
    }))
    return detailed.filter(Boolean)
  }

  async function inspectNetwork(name) {
    const result = await run(['network', 'inspect', String(name)], { timeoutMs: 25_000 })
    const text = requireOk(result, { command: 'podman network inspect', code: ERR.NOT_FOUND })
    const rows = parseJson(text, 'podman network inspect ') ?? []
    const first = Array.isArray(rows) ? rows[0] : rows
    if (!first) throw new CmError(ERR.NOT_FOUND, `找不到网络：${name}`)
    return normalizeNetwork(first)
  }

  async function net(op) {
    const action = String(op?.op ?? '')
    if (action === 'list') return listNetworks()
    if (action === 'inspect') return inspectNetwork(String(op.name ?? ''))
    if (action === 'create') {
      const args = ['network', 'create']
      if (op.driver) args.push('--driver', String(op.driver))
      if (op.subnet) args.push('--subnet', String(op.subnet))
      if (op.gateway) args.push('--gateway', String(op.gateway))
      if (op.internal) args.push('--internal')
      args.push(String(op.name))
      const result = await run(args, { timeoutMs: 60_000 })
      requireOk(result, {
        command: 'podman network create',
        code: ERR.PODMAN_ERROR,
        hint: 'rootless 建 macvlan 网络需要 CAP_NET_ADMIN（通常意味着宿主上要有 root 通道）；bridge 子网别和现有网段打架。macvlan 驱动一般已在内核里，不用先 modprobe。',
      })
      return inspectNetwork(String(op.name))
    }
    if (action === 'remove') {
      const result = await run(['network', 'rm', String(op.name)], { timeoutMs: 60_000 })
      requireOk(result, { command: 'podman network rm', code: ERR.PODMAN_ERROR, hint: '还有容器连着这个网络时先断开。' })
      return { removed: String(op.name) }
    }
    if (action === 'connect' || action === 'disconnect') {
      const args = ['network', action === 'connect' ? 'connect' : 'disconnect', String(op.name), String(op.container)]
      if (action === 'connect' && op.ip) args.push('--ip', String(op.ip))
      const result = await run(args, { timeoutMs: 60_000 })
      requireOk(result, {
        command: `podman network ${action}`,
        code: ERR.PODMAN_ERROR,
        hint: action === 'connect' && op.ip ? 'rootless 下静态 IP 往往不支持，去掉 --ip 再试。' : undefined,
      })
      return { op: action, network: String(op.name), container: String(op.container) }
    }
    throw new CmError(ERR.BAD_ARGS, `不支持的 Podman 网络操作：${action}`)
  }

  /** 拉镜像：慢且要联网，超时给足；输出只留尾部。 */
  async function pullImage(reference) {
    const name = String(reference || '').trim()
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要镜像名。')
    const result = await run(['pull', name], { timeoutMs: 600_000, maxBuffer: 8 * 1024 * 1024 })
    const text = requireOk(result, {
      command: 'podman pull',
      code: ERR.PODMAN_ERROR,
      hint: '镜像名要带 registry（例如 docker.io/library/alpine:latest），网络不通也会失败。',
    })
    const merged = [text, result.stderr].filter(Boolean).join('\n').trim()
    return { reference: name, output: merged.length > 4000 ? merged.slice(-4000) : merged }
  }

  /** 删镜像：有容器（含已停止的）在用时删不掉，原样把 stderr 交回去。 */
  async function deleteImage(reference) {
    const name = String(reference || '').trim()
    if (!name) throw new CmError(ERR.BAD_ARGS, '需要镜像名。')
    const result = await run(['rmi', name], { timeoutMs: 120_000 })
    const text = requireOk(result, {
      command: 'podman rmi',
      code: ERR.PODMAN_ERROR,
      hint: '还有容器（包括已停止的）在用这个镜像，先删容器再删镜像。',
    })
    return { reference: name, output: String(text || '').trim() }
  }

  /** 卷列表。匿名卷也列出来，但标出来 —— 它们通常是被容器顺手创建的。 */
  async function listVolumes() {
    const result = await run(['volume', 'ls', '--format', 'json'], { timeoutMs: 25_000 })
    if (result.code !== 0) return []
    const rows = parseJson(result.stdout, 'podman volume ls ') ?? []
    return rows.map((row) => {
      const labels = row?.Labels ?? row?.labels ?? {}
      return {
        name: String(row?.Name ?? row?.name ?? ''),
        driver: String(row?.Driver ?? row?.driver ?? ''),
        mountpoint: String(row?.Mountpoint ?? row?.mountpoint ?? ''),
        created: row?.CreatedAt ?? row?.Created ?? null,
        anonymous: Boolean(labels && labels['io.podman.volume.anonymous']),
      }
    }).filter(item => item.name)
  }

  async function backupVolume(name, dir, image = 'docker.io/library/alpine:3.22', options = {}) {
    const volume = String(name || '').trim()
    const targetDir = String(dir || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(volume)) throw new CmError(ERR.BAD_ARGS, '卷名不合法。')
    if (!targetDir.startsWith('/') || targetDir.includes('..')) throw new CmError(ERR.BAD_ARGS, '备份目录必须是绝对路径，且不含 ..。')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const file = join(targetDir, volume + '-' + stamp + '.tar.gz')
    const args = ['run', '--rm', '-v', volume + ':/data:ro', '-v', targetDir + ':/backup', String(image), 'tar', '-czf', '/backup/' + basename(file), '-C', '/data', '.']
    const result = await run(args, { timeoutMs: 1_800_000, maxBuffer: 4 * 1024 * 1024, signal: options.signal })
    requireOk(result, { command: 'podman volume backup', code: ERR.PODMAN_ERROR })
    return { name: volume, file, image: String(image) }
  }

  async function restoreVolume(file, name, image = 'docker.io/library/alpine:3.22', options = {}) {
    const volume = String(name || '').trim()
    const archive = String(file || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(volume)) throw new CmError(ERR.BAD_ARGS, '卷名不合法。')
    if (!archive.startsWith('/') || archive.includes('..') || !/\.tar(\.gz|\.xz|\.bz2|\.zst)?$/.test(archive)) throw new CmError(ERR.BAD_ARGS, '归档路径不合法。')
    const args = ['run', '--rm', '-v', volume + ':/data', '-v', dirname(archive) + ':/backup:ro', String(image), 'tar', '-xf', '/backup/' + basename(archive), '-C', '/data']
    const result = await run(args, { timeoutMs: 1_800_000, maxBuffer: 4 * 1024 * 1024, signal: options.signal })
    requireOk(result, { command: 'podman volume restore', code: ERR.PODMAN_ERROR })
    return { name: volume, file: archive, image: String(image) }
  }

  async function deleteVolume(name) {
    const target = String(name || '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '需要卷名。')
    const result = await run(['volume', 'rm', target], { timeoutMs: 60_000 })
    const text = requireOk(result, {
      command: 'podman volume rm',
      code: ERR.PODMAN_ERROR,
      hint: '卷还被容器用时删不掉：先删那个容器。',
    })
    return { name: target, output: String(text || '').trim() }
  }

  /**
   * 谁在挂这个卷。预演要靠它回答「删了会不会有人崩」，所以只做一次轻量 ps，
   * 读不到就返回空数组 —— 上层会把「空」和「不知道」分开处理。
   */
  async function volumeUsage(name) {
    const target = String(name || '').trim()
    if (!target) return []
    const result = await run(['ps', '-a', '--filter', 'volume=' + target, '--format', '{{.Names}}'], { timeoutMs: 20_000 })
    if (result.code !== 0) return []
    return String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  }

  /** 谁在（哪怕已经停了）用这个镜像。 */
  async function imageUsage(reference) {
    const target = String(reference || '').trim()
    if (!target) return []
    const result = await run(['ps', '-a', '--filter', 'ancestor=' + target, '--format', '{{.Names}}'], { timeoutMs: 20_000 })
    if (result.code !== 0) return []
    return String(result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  }

  /* ───────────────────────── 容器内文件 ───────────────────────── */

  /**
   * 列目录要进容器里跑，所以必须运行中。
   * 路径从 $1 进，不拼字符串 —— 文件名里有引号也不会被 shell 吃掉。
   */
  const LIST_SCRIPT = [
    'd="$1"',
    'cd "$d" 2>/dev/null || { echo "__CM_ERR__"; exit 3; }',
    'for f in .* *',
    'do',
    '  case "$f" in .|..) continue;; esac',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  t=f',
    '  [ -d "$f" ] && t=d',
    '  [ -L "$f" ] && t=l',
    '  s=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    '  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
    '  printf "%s\\t%s\\t%s\\t%s\\n" "$t" "$s" "$m" "$f"',
    'done',
  ].join('\n')

  function assertLocalFiles(kind) {
    if (node.transport === 'ssh') {
      throw new CmError(ERR.BAD_ARGS,
        '文件浏览暂时只支持本机 Podman（远端节点要走 ssh 传二进制，这条路还没接）。',
        '远端节点请用「终端」，或者把文件先拉到本机再处理。')
    }
    return kind
  }

  async function filesList(ref, path) {
    assertLocalFiles('list')
    // 注意：podman exec 不认 `--` 分隔符（会把 -- 当成要执行的命令名），
    // 所以这里直接跟命令。命令本身都以 sh / mkdir / rm 开头，不会被当成选项。
    const result = await run(
      ['exec', String(ref), 'sh', '-c', LIST_SCRIPT, 'sh', String(path)],
      { timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 },
    )
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.timedOut) throw new CmError(ERR.TIMEOUT, '列目录超时了：这个目录可能有几十万项。')
    if (result.code !== 0 || /__CM_ERR__/.test(result.stdout)) {
      throw new CmError(ERR.PODMAN_ERROR,
        (result.stderr || '').trim() || ('打不开这个目录：' + path),
        '列目录要在容器里跑命令，所以容器必须运行中；目录不存在或权限不够也会这样。')
    }
    const entries = []
    for (const line of String(result.stdout || '').split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 4) continue
      const [type, size, mtime, ...rest] = parts
      const name = rest.join('\t')
      if (!name) continue
      entries.push({
        name,
        type: type === 'd' ? 'dir' : type === 'l' ? 'symlink' : 'file',
        size: Number(size) || 0,
        mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null,
      })
    }
    entries.sort((left, right) => {
      if (left.type === 'dir' && right.type !== 'dir') return -1
      if (right.type === 'dir' && left.type !== 'dir') return 1
      return left.name.localeCompare(right.name)
    })
    return { path: String(path), entries }
  }

  /** 读一个文件：podman cp 把文件打成 tar 吐到 stdout，宿主侧再拆。二进制安全。 */
  async function filesRead(ref, path, { maxBytes = 8 * 1024 * 1024 } = {}) {
    assertLocalFiles('read')
    const result = await execFileBuffer('podman', ['cp', String(ref) + ':' + path, '-'], {
      timeoutMs: 60_000,
      maxBuffer: Math.max(maxBytes + 4 * 1024 * 1024, 8 * 1024 * 1024),
    })
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        String(result.stderr || '').trim() || ('读不到这个文件：' + path),
        '路径不存在、是个目录、或者超过 8MB 都会这样。大文件请用终端。')
    }
    let file
    try {
      file = unpackSingleFile(result.stdout)
    } catch (error) {
      throw new CmError(ERR.BAD_ARGS, error?.message ?? '这个路径读不出单个文件。',
        '读一个文件只能给文件路径；目录请用「列目录」，大文件请用「终端」。')
    }
    // 条目名必须和请求的文件名对得上：podman cp 的路径解析偶尔会给出别的条目，
    // 与其把别人的内容当成你的文件，不如直说对不上。
    const wanted = String(path).split('/').pop()
    if (file.name !== wanted && file.name !== String(path).replace(/^\//, '')) {
      throw new CmError(ERR.INTERNAL, '读回来的内容和路径对不上（要 ' + wanted + '，拿到 ' + file.name + '）。')
    }
    return { path: String(path), data: file.data, truncated: false }
  }

  /**
   * 写一个文件：把内容打成单条目 tar 喂给 podman cp -。
   *
   * podman cp 从标准输入读归档时，目标必须是**目录** —— 它按条目名往这个目录里放。
   * 所以这里传父目录，条目名用 basename；直接传文件名会被拒
   * （"destination must be a directory when copying from stdin"）。
   */
  async function filesWrite(ref, path, data, { name } = {}) {
    assertLocalFiles('write')
    const full = String(path)
    const cut = full.lastIndexOf('/')
    const dir = cut <= 0 ? '/' : full.slice(0, cut)
    const entry = name || full.slice(cut + 1)
    let payload
    try {
      payload = packFile(entry, data)
    } catch (error) {
      throw new CmError(ERR.BAD_ARGS, error?.message ?? '打包失败。')
    }
    const result = await execFileWithInput('podman', ['cp', '-', String(ref) + ':' + dir], payload, {
      timeoutMs: 60_000,
    })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        String(result.stderr || '').trim() || ('写不进去：' + path),
        '父目录不存在、容器里是只读挂载、或者容器已经停了都可能。')
    }
    return { written: true, bytes: data.length }
  }

  async function filesMkdir(ref, path) {
    assertLocalFiles('mkdir')
    const result = await run(['exec', String(ref), 'mkdir', '-p', String(path)], { timeoutMs: 20_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR, String(result.stderr || '').trim() || '建目录失败。',
        '容器得在运行中；父目录只读也建不了。')
    }
    return { created: true }
  }

  async function filesRemove(ref, path) {
    assertLocalFiles('remove')
    // rm 后面那个 -- 是 rm 自己的选项终止符（路径可能以 - 开头），不是 podman 的。
    const result = await run(['exec', String(ref), 'rm', '-rf', '--', String(path)], { timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR, String(result.stderr || '').trim() || '删除失败。',
        '容器得在运行中；只读挂载里的东西删不掉。')
    }
    return { removed: true }
  }

  /* ───────────────────── 镜像更新检测 ───────────────────── */

  let skopeoCache = null

  async function hasSkopeo() {
    if (skopeoCache !== null) return skopeoCache
    const result = await exec('skopeo', ['--version'], { timeoutMs: 8000 }).catch(() => null)
    skopeoCache = Boolean(result && result.code === 0)
    return skopeoCache
  }

  /**
   * 本地镜像和仓库比 digest。比不了就说比不了（自建镜像没 digest、没装 skopeo 问不到远端）。
   * 只查前 N 个（默认 12）：镜像多的时候别把出口网络和仓库打满。
   */
  async function imageUpdates({ limit = 12 } = {}) {
    const images = await listImages()
    const run = async (command, args) => {
      const result = await exec(command, args, { timeoutMs: 20_000 }).catch(error => ({
        code: typeof error?.code === 'number' ? error.code : null,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? error?.message ?? ''),
      }))
      return {
        code: typeof result.code === 'number' ? result.code : 0,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      }
    }
    return checkImageUpdates({
      images: Array.isArray(images) ? images : [],
      run,
      hasSkopeo: await hasSkopeo(),
      limit: Number(limit) > 0 ? Number(limit) : 12,
    })
  }

  /* ───────────────────────── secrets ───────────────────────── */

  /**
   * 列 secret。**永远不含明文** —— podman 本身也不给回读，这里连值都不接收。
   *
   * 不能用 `--format json`：podman 4.3.1 那个选项是静默返回空（exit 0、没有输出），
   * 照它写就会把「有 5 个 secret」显示成「0 个」。用 Go 模板反而可靠。
   */
  async function secrets() {
    const result = await run([
      'secret', 'ls', '--format', '{{.ID}}|{{.Name}}|{{.Driver}}|{{.CreatedAt}}|{{.UpdatedAt}}',
    ], { timeoutMs: 20_000 })
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR, String(result.stderr || '').trim() || '读不到 secret 列表。')
    }
    const items = []
    for (const line of String(result.stdout || '').split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('|')
      if (parts.length < 5) continue
      items.push({
        id: parts[0].trim(),
        name: parts[1].trim(),
        driver: parts[2].trim(),
        createdAt: parts[3].trim(),
        updatedAt: parts[4].trim(),
      })
    }
    return { node, items }
  }

  function assertSecretName(raw) {
    const name = String(raw ?? '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      throw new CmError(ERR.BAD_ARGS, 'secret 名字只允许字母、数字、下划线、点、连字符（最长 64）。')
    }
    return name
  }

  /** 建 secret：明文从 stdin 进去，不进命令行（不进 ps、不进 shell 历史）。 */
  async function secretCreate(name, value) {
    const clean = assertSecretName(name)
    const data = String(value ?? '')
    if (!data) throw new CmError(ERR.BAD_ARGS, 'secret 值不能为空。')
    if (data.length > 64 * 1024) throw new CmError(ERR.BAD_ARGS, 'secret 值超过 64KB。')
    if (node.transport === 'ssh') {
      throw new CmError(ERR.BAD_ARGS, '远端节点建 secret 要先解决 stdin 传输，这条路没接。')
    }
    const result = await execFileWithInput('podman', ['secret', 'create', clean, '-'], data, { timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        String(result.stderr || '').trim() || ('建 secret 失败：' + clean),
        '同名 secret 已存在（要先删）、或者名字不合法。')
    }
    return { name: clean, created: true }
  }

  async function secretRemove(name) {
    const clean = assertSecretName(name)
    const result = await run(['secret', 'rm', clean], { timeoutMs: 20_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR, String(result.stderr || '').trim() || ('删 secret 失败：' + clean))
    }
    return { name: clean, removed: true }
  }

  /* ───────────────────────── Quadlet ───────────────────────── */

  const QUADLET_MAX_BYTES = 256 * 1024
  // rootless 的 quadlet 通常写在 ~/.config/containers/systemd；系统级的在 /etc 那两处。
  function quadletDirs() {
    const home = process.env.HOME || ''
    const xdg = process.env.XDG_CONFIG_HOME || (home ? home + '/.config' : '')
    return [
      '/etc/containers/systemd',
      '/usr/share/containers/systemd',
      ...(xdg ? [xdg + '/containers/systemd'] : []),
    ]
  }

  /** 这台机的 podman 到底带不带 quadlet 生成器（4.4 才有；4.3 没有）。 */
  function quadletSupport() {
    const candidates = [
      '/usr/lib/systemd/system-generators/podman-system-generator',
      '/usr/libexec/podman/quadlet',
      '/usr/lib/podman/quadlet',
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { supported: true, generator: candidate }
    }
    return { supported: false, generator: null }
  }

  function runSystemctl(args, { timeoutMs = 20_000 } = {}) {
    if (node.transport === 'ssh') {
      throw new CmError(ERR.BAD_ARGS, 'Quadlet 只做本机：远端的 user unit 要走 ssh + systemctl，这条路没接。')
    }
    return exec('systemctl', args, { timeoutMs })
  }

  /** 列 quadlet 文件与它们对应的 unit 状态。 */
  async function quadlets() {
    if (node.transport === 'ssh') {
      return {
        supported: false,
        reason: 'Quadlet 只做本机：远端要看 unit 得走 ssh + systemctl --user，这条路没接。',
        dirs: quadletDirs(),
        items: [],
        problems: [],
      }
    }
    const support = quadletSupport()
    const dirs = quadletDirs()
    const sources = []
    for (const dir of dirs) {
      let names = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      const files = []
      for (const name of names) {
        if (!isQuadletFile(name)) continue
        try {
          const info = statSync(dir + '/' + name)
          if (!info.isFile() || info.size > QUADLET_MAX_BYTES) continue
          files.push({ name, text: readFileSync(dir + '/' + name, 'utf8') })
        } catch {
          // 读不到就当没有这一份，不猜
        }
      }
      if (files.length) sources.push({ dir, files })
    }
    const built = buildQuadletList(sources)
    let states = new Map()
    let stateError = null
    if (support.supported && built.items.length > 0) {
      const units = built.items.map(item => item.unit)
      const result = await runSystemctl(['--user', 'show', '--property=Id,LoadState,ActiveState,SubState', ...units])
      if (result.code === 0) {
        states = parseSystemctlShow(result.stdout)
      } else {
        stateError = String(result.stderr || '').trim() || 'systemctl --user show 没成功。'
      }
    }
    return {
      supported: support.supported,
      generator: support.generator,
      reason: support.supported ? null
        : '这台机的 podman 还不带 quadlet 生成器（4.4 起才有；装的是 ' +
          String((await info()).version || '未知版本') + '）。文件可以看，unit 状态问不到。',
      dirs,
      items: built.items.map(item => ({
        ...item,
        state: states.get(item.unit) || null,
      })),
      problems: built.problems,
      stateError,
    }
  }

  /** 重新生成 unit（改完 quadlet 文件之后的必经一步）。 */
  async function quadletReload() {
    const support = quadletSupport()
    if (!support.supported) {
      throw new CmError(ERR.BAD_ARGS, '这台机的 podman 没有 quadlet 生成器，daemon-reload 也生不出 unit。',
        '把 podman 升到 4.4+ 再用 Quadlet。')
    }
    const result = await runSystemctl(['--user', 'daemon-reload'], { timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR, String(result.stderr || '').trim() || 'daemon-reload 失败。')
    }
    return { reloaded: true }
  }

  /** 启停一个由 quadlet 生成的 unit。只允许 .service / .volume / .network 这几种名字。 */
  async function quadletAction(unit, action) {
    const name = String(unit ?? '')
    if (!/^[A-Za-z0-9@._\\-]+\.(service|volume|network)$/.test(name)) {
      throw new CmError(ERR.BAD_ARGS, 'unit 名不合法：' + name)
    }
    const verb = action === 'start' ? 'start' : action === 'stop' ? 'stop' : action === 'restart' ? 'restart' : null
    if (!verb) throw new CmError(ERR.BAD_ARGS, 'action 只能是 start / stop / restart。')
    const result = await runSystemctl(['--user', verb, name], { timeoutMs: 90_000 })
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        String(result.stderr || '').trim() || (verb + ' ' + name + ' 失败。'),
        'unit 没生成（先 daemon-reload）、或者它被 disable 了都会这样。')
    }
    return { unit: name, action: verb }
  }

  /** 容器内网络排障：只读命令，一次 exec 拿全部段落。 */
  async function diagnose(ref, { host, port } = {}) {
    const script = buildDiagnoseScript({ host, port })
    const result = await run(['exec', String(ref), 'sh', '-c', script], {
      timeoutMs: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    if (result.code !== 0 && !/@@cm:/.test(String(result.stdout || ''))) {
      throw new CmError(ERR.PODMAN_ERROR,
        String(result.stderr || '').trim() || '诊断命令没跑起来。',
        '容器得在运行中才能进容器里跑诊断。')
    }
    const sections = parseDiagnoseOutput(result.stdout)
    return { ...readDiagnose(sections, { host, port }), sections }
  }

  let statsCache = null
  let statsCacheAt = 0

  /**
   * 容器实时占用。`--no-stream` 单次要 1~2 秒，所以自带 3 秒缓存，
   * 别让几个前端请求同时把 podman 打满。
   */
  async function stats({ force = false } = {}) {
    const now = Date.now()
    if (!force && statsCache && now - statsCacheAt < 3_000) return statsCache
    const result = await run(['stats', '--no-stream', '--format', 'json'], { timeoutMs: 25_000 })
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.timedOut) throw new CmError(ERR.TIMEOUT, 'podman stats 超时了。')
    if (result.code !== 0) {
      throw new CmError(ERR.NODE_UNAVAILABLE,
        (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join('\n') || ('podman stats 退出码 ' + result.code))
    }
    const parsed = parseJson(result.stdout, [])
    statsCache = Array.isArray(parsed) ? parsed.map(normalizeStatsRow).filter(Boolean) : []
    statsCacheAt = Date.now()
    return statsCache
  }

  /** 改名：运行中的容器也能改，新名字不能和现有容器重名。 */
  async function rename(ref, newName) {
    const target = String(newName ?? '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '新名字不能为空。')
    const result = await run(['rename', String(ref), target], { timeoutMs: 20_000 })
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.timedOut) throw new CmError(ERR.TIMEOUT, 'podman rename 超时了。')
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        (result.stderr || result.stdout || '').trim() || ('podman rename 退出码 ' + result.code),
        '新名字不能和现有容器重复；LXC 容器不在这里改名。')
    }
    return { from: String(ref), to: target }
  }

  /** 提交成镜像：整层复制，慢而且占磁盘，上层必须挂 pending。 */
  async function commit(ref, image, options = {}) {
    const target = String(image ?? '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '要给个镜像名。')
    const result = await run(['commit', String(ref), target], { timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024, signal: options.signal })
    if (result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 podman 命令（PATH 里没有）。')
    if (result.timedOut) throw new CmError(ERR.TIMEOUT, 'podman commit 超时了（大容器可能要几分钟）。')
    if (result.code !== 0) {
      throw new CmError(ERR.PODMAN_ERROR,
        (result.stderr || result.stdout || '').trim() || ('podman commit 退出码 ' + result.code))
    }
    return { container: String(ref), image: target, id: String(result.stdout || '').trim().slice(0, 12) }
  }

  return {    node,
    kind: 'podman',
    info,
    async available() {
      const result = await info()
      if (result.ok) return { ok: true }
      return { ok: false, code: result.code ?? ERR.NODE_UNAVAILABLE, reason: result.reason ?? '不可用' }
    },
    listContainers,
    stats,
    rename,
    commit,
    inspect,
    logs,
    act,
    create,
    recreate,
    updateCgroup,
    inspectRaw,
    registryLogin,
    listImages,
    pullImage,
    deleteImage,
    listVolumes,
    backupVolume,
    restoreVolume,
    deleteVolume,
    volumeUsage,
    imageUsage,
    filesList,
    filesRead,
    filesWrite,
    filesMkdir,
    filesRemove,
    diagnose,
    imageUpdates,
    secrets,
    secretCreate,
    secretRemove,
    quadlets,
    quadletReload,
    quadletAction,
    listPods,
    createPod,
    podAction,
    listNetworks,
    inspectNetwork,
    net,
  }
}
