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

import {
  CmError,
  ERR,
  execFileAsync,
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

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

/** inspect 归一化：注意**不返回 env 的值**（里面常有密码）。 */
export function normalizeInspect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const state = raw.State ?? {}
  const config = raw.Config ?? {}
  const networkSettings = raw.NetworkSettings ?? {}
  const networks = []
  const rawNetworks = networkSettings.Networks ?? {}
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
    labels: config.Labels ?? {},
    mounts,
    ports,
    networks,
    networkMode: String(raw.HostConfig?.NetworkMode ?? ''),
    restartPolicy: raw.HostConfig?.RestartPolicy ?? null,
    // 资源限制：podman update 能改的就是这几个（4.3.1 不支持 --restart）。
    limits: {
      memory: asNumber(raw.HostConfig?.Memory),
      cpus: raw.HostConfig?.NanoCpus ? raw.HostConfig.NanoCpus / 1e9 : null,
      cpuShares: asNumber(raw.HostConfig?.CpuShares),
      cpusetCpus: String(raw.HostConfig?.CpusetCpus ?? ''),
    },
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

  function run(args, { timeoutMs = 30_000, maxBuffer } = {}) {
    if (node.transport === 'ssh') {
      const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
      if (node.port) sshArgs.push('-p', String(node.port))
      if (node.identityFile) sshArgs.push('-i', node.identityFile)
      sshArgs.push(node.user ? `${node.user}@${node.host}` : String(node.host))
      sshArgs.push('podman', ...args)
      return exec('ssh', sshArgs, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) })
    }
    return exec('podman', args, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) })
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
    return rows.map(normalizePsRow).filter(Boolean)
  }

  async function inspect(ref) {
    const result = await run(['inspect', String(ref)], { timeoutMs: 25_000 })
    const text = requireOk(result, { command: 'podman inspect', code: ERR.NOT_FOUND })
    const rows = parseJson(text, 'podman inspect ') ?? []
    const first = Array.isArray(rows) ? rows[0] : rows
    if (!first) throw new CmError(ERR.NOT_FOUND, `找不到容器：${ref}`)
    return normalizeInspect(first)
  }

  async function logs(ref, tail = 100) {
    // podman logs 把容器的 stderr 也写到自己的 stderr，两个都要收。
    const result = await run(['logs', '--tail', String(tail), String(ref)], { timeoutMs: 30_000, maxBuffer: 8 * 1024 * 1024 })
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
    if (spec.cpus !== undefined && spec.cpus !== null) args.push('--cpus', String(spec.cpus))
    if (uts) args.push('--uts', String(uts))
    if (spec.hostname && uts !== 'host') args.push('--hostname', String(spec.hostname))
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
    if (args.length === 1) throw new CmError(ERR.BAD_ARGS, '没有要改的限制项（memory / cpus / cpuShares / cpusetCpus）。')
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
    // podman 4.3.1 的 rootless 模式会「接受 --memory 但什么都不写」：命令返回 0，
    // 容器的 memory.max 仍是 max。这种假成功必须报出来，不能让用户以为限制上了。
    const wanted = applied.memory !== undefined ? memoryBytes(applied.memory) : null
    if (wanted !== null && detail && detail.limits) {
      const actual = detail.limits.memory
      if (actual !== wanted) {
        throw new CmError(
          ERR.PODMAN_ERROR,
          `podman update 返回成功，但容器的内存上限没变（期望 ${wanted} 字节，实际 ${actual ?? 0}）。这台机上 rootless podman 4.3.1 不写 cgroup 限制。`,
          '要真正限制资源得用 rootful podman，或升级到 podman 4.4+（rootless cgroup v2 才完整）。',
        )
      }
    }
    return { ref: String(ref), applied, output: text.trim(), detail }
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
  async function commit(ref, image) {
    const target = String(image ?? '').trim()
    if (!target) throw new CmError(ERR.BAD_ARGS, '要给个镜像名。')
    const result = await run(['commit', String(ref), target], { timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024 })
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
    updateCgroup,
    listImages,
    pullImage,
    deleteImage,
    listVolumes,
    deleteVolume,
    listNetworks,
    inspectNetwork,
    net,
  }
}
