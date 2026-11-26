/**
 * compose 服务 → 本插件的规范模型（v0.3.0）
 *
 * 面板和 AI 都读这份模型，而不是直接翻 YAML —— 这样「UI 上看到的端口」
 * 和「预检时检查的端口」永远是同一个东西。
 */

const PROTOCOLS = new Set(['tcp', 'udp', 'sctp'])

function toArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** 端口里可能出现 a-b 这种范围；拆出来，render 时再展开。 */
function splitRange(text) {
  const dash = text.indexOf('-')
  if (dash <= 0) return { start: text, end: text }
  return { start: text.slice(0, dash), end: text.slice(dash + 1) }
}

function toPortNumber(text) {
  const value = Number(text)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : null
}

/**
 * 一条 ports 项 → 结构化。
 * 认：80 / 8080:80 / 127.0.0.1:8080:80 / [::1]:8080:80 / 8080:80/udp / 8000-8005:80-85 / 长语法对象。
 */
export function parsePortEntry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const containerPort = toPortNumber(entry.target)
    if (containerPort === null) return { raw: JSON.stringify(entry), parsed: false, reason: '长语法缺少 target' }
    const hostPort = entry.published !== undefined ? toPortNumber(entry.published) : null
    return {
      raw: JSON.stringify(entry),
      parsed: true,
      hostIp: typeof entry.host_ip === 'string' ? entry.host_ip : '',
      hostPort,
      hostPortEnd: hostPort,
      containerPort,
      containerPortEnd: containerPort,
      protocol: PROTOCOLS.has(String(entry.protocol || '').toLowerCase()) ? String(entry.protocol).toLowerCase() : 'tcp',
      range: false,
    }
  }

  const raw = String(entry === undefined || entry === null ? '' : entry).trim()
  if (!raw) return null

  let body = raw
  let protocol = 'tcp'
  const slash = body.lastIndexOf('/')
  if (slash > 0) {
    const maybe = body.slice(slash + 1).toLowerCase()
    if (PROTOCOLS.has(maybe)) {
      protocol = maybe
      body = body.slice(0, slash)
    }
  }

  let hostIp = ''
  if (body.startsWith('[')) {
    const close = body.indexOf(']')
    if (close > 0) {
      hostIp = body.slice(1, close)
      body = body.slice(close + 1)
      if (body.startsWith(':')) body = body.slice(1)
    }
  }

  const parts = body.split(':')
  if (parts.length > 3) {
    return { raw, parsed: false, reason: 'IPv6 地址要写成 [::1]:8080:80 这种带方括号的形式' }
  }
  if (parts.length === 3) {
    hostIp = parts[0]
    parts.shift()
  }

  let hostPart = null
  let containerPart = parts.length === 2 ? parts[1] : parts[0]
  if (parts.length === 2) hostPart = parts[0]

  const containerRange = splitRange(containerPart)
  const containerPort = toPortNumber(containerRange.start)
  const containerPortEnd = toPortNumber(containerRange.end)
  if (containerPort === null || containerPortEnd === null) {
    return { raw, parsed: false, reason: '容器端口不是 1-65535 之间的整数' }
  }

  if (hostPart === null || hostPart === '') {
    return {
      raw,
      parsed: true,
      hostIp,
      hostPort: null,
      hostPortEnd: null,
      containerPort,
      containerPortEnd,
      protocol,
      range: containerPort !== containerPortEnd,
    }
  }

  const hostRange = splitRange(hostPart)
  const hostPort = toPortNumber(hostRange.start)
  const hostPortEnd = toPortNumber(hostRange.end)
  if (hostPort === null || hostPortEnd === null) {
    return { raw, parsed: false, reason: '宿主端口不是 1-65535 之间的整数' }
  }

  return {
    raw,
    parsed: true,
    hostIp,
    hostPort,
    hostPortEnd,
    containerPort,
    containerPortEnd,
    protocol,
    range: hostPort !== hostPortEnd || containerPort !== containerPortEnd,
  }
}

/** 一条 volumes 项 → 结构化；顺带判断是 bind 还是 named volume。 */
export function parseVolumeEntry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const target = typeof entry.target === 'string' ? entry.target : ''
    if (!target) return null
    const type = entry.type === 'bind' ? 'bind' : entry.type === 'tmpfs' ? 'tmpfs' : 'volume'
    return {
      raw: JSON.stringify(entry),
      type,
      source: typeof entry.source === 'string' ? entry.source : '',
      target,
      readOnly: entry.read_only === true,
      rawSize: null,
    }
  }
  const raw = String(entry === undefined || entry === null ? '' : entry).trim()
  if (!raw) return null
  const pieces = raw.split(':')
  const target = pieces.length > 1 ? pieces[1] : pieces[0]
  const source = pieces.length > 1 ? pieces[0] : ''
  const mode = pieces.length > 2 ? pieces[2] : ''
  const isPath = source.startsWith('/') || source.startsWith('.') || source.startsWith('~')
  return {
    raw,
    type: !source ? 'tmpfs' : isPath ? 'bind' : 'volume',
    source,
    target,
    readOnly: mode.split(',').includes('ro'),
    rawSize: null,
  }
}

/** environment 对象/数组 → [{key, value}]，value 为 null 表示「从宿主环境继承」。 */
export function normalizeEnvironment(value) {
  const out = []
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item === undefined || item === null ? '' : item)
      const eq = text.indexOf('=')
      if (eq < 0) out.push({ key: text.trim(), value: null })
      else out.push({ key: text.slice(0, eq).trim(), value: text.slice(eq + 1) })
    }
    return out.filter(item => item.key)
  }
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value)) {
      out.push({ key, value: raw === null || raw === undefined ? null : String(raw) })
    }
  }
  return out.filter(item => item.key)
}

export function normalizeLabels(value) {
  const out = []
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item === undefined || item === null ? '' : item)
      const eq = text.indexOf('=')
      out.push(eq < 0 ? { key: text, value: '' } : { key: text.slice(0, eq), value: text.slice(eq + 1) })
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value)) out.push({ key, value: raw === undefined || raw === null ? '' : String(raw) })
  }
  return out
}

function normalizeBuild(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return { context: value, dockerfile: 'Dockerfile' }
  if (typeof value === 'object') {
    return {
      context: typeof value.context === 'string' ? value.context : '.',
      dockerfile: typeof value.dockerfile === 'string' ? value.dockerfile : 'Dockerfile',
      args: value.args && typeof value.args === 'object' ? value.args : null,
    }
  }
  return null
}

function normalizeDependsOn(value) {
  if (Array.isArray(value)) return value.map(name => ({ name: String(name), condition: 'started' }))
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, spec]) => ({
      name,
      condition: spec && typeof spec === 'object' && typeof spec.condition === 'string' ? spec.condition : 'started',
    }))
  }
  return []
}

function normalizeNetworks(value) {
  if (Array.isArray(value)) return value.map(name => ({ name: String(name), aliases: [] }))
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, spec]) => ({
      name,
      aliases: spec && typeof spec === 'object' && Array.isArray(spec.aliases) ? spec.aliases.map(String) : [],
    }))
  }
  return []
}

function normalizeHealthcheck(value) {
  if (!value || typeof value !== 'object') return null
  const test = value.test
  const list = Array.isArray(test) ? test.map(String) : typeof test === 'string' ? [test] : []
  return {
    disabled: value.disable === true,
    test: list,
    interval: value.interval ? String(value.interval) : '',
    timeout: value.timeout ? String(value.timeout) : '',
    retries: Number.isInteger(value.retries) ? value.retries : null,
    startPeriod: value.start_period ? String(value.start_period) : '',
  }
}

/** 一个服务 → 规范模型。 */
export function normalizeService(name, raw) {
  const service = raw && typeof raw === 'object' ? raw : {}
  const ports = toArray(service.ports).map(parsePortEntry).filter(Boolean)
  const volumes = toArray(service.volumes).map(parseVolumeEntry).filter(Boolean)
  return {
    name,
    image: typeof service.image === 'string' ? service.image.trim() : '',
    build: normalizeBuild(service.build),
    command: service.command === undefined ? null : service.command,
    entrypoint: service.entrypoint === undefined ? null : service.entrypoint,
    environment: normalizeEnvironment(service.environment),
    envFiles: toArray(service.env_file).map(String),
    ports,
    expose: toArray(service.expose).map(String),
    volumes,
    restart: typeof service.restart === 'string' ? service.restart : '',
    networkMode: typeof service.network_mode === 'string' ? service.network_mode : '',
    networks: normalizeNetworks(service.networks),
    dependsOn: normalizeDependsOn(service.depends_on),
    healthcheck: normalizeHealthcheck(service.healthcheck),
    labels: normalizeLabels(service.labels),
    hostname: typeof service.hostname === 'string' ? service.hostname : '',
    user: typeof service.user === 'string' ? service.user : '',
    workingDir: typeof service.working_dir === 'string' ? service.working_dir : '',
    containerName: typeof service.container_name === 'string' ? service.container_name : '',
    privileged: service.privileged === true,
    readOnly: service.read_only === true,
    tty: service.tty === true,
    capAdd: toArray(service.cap_add).map(String),
    capDrop: toArray(service.cap_drop).map(String),
    devices: toArray(service.devices).map(String),
    dns: toArray(service.dns).map(String),
    dnsSearch: toArray(service.dns_search).map(String),
    extraHosts: toArray(service.extra_hosts).map(String),
    sysctls: service.sysctls && typeof service.sysctls === 'object' ? service.sysctls : {},
    tmpfs: toArray(service.tmpfs).map(String),
    ulimits: service.ulimits && typeof service.ulimits === 'object' ? service.ulimits : {},
    stopGracePeriod: service.stop_grace_period ? String(service.stop_grace_period) : '',
    init: service.init === true,
    memLimit: service.mem_limit === undefined || service.mem_limit === null ? '' : String(service.mem_limit),
    cpus: service.cpus === undefined || service.cpus === null ? '' : String(service.cpus),
    shmSize: service.shm_size === undefined || service.shm_size === null ? '' : String(service.shm_size),
    pid: service.pid === undefined || service.pid === null ? '' : String(service.pid),
  }
}

/** 整个 compose 文档 → 项目模型。 */
export function buildProject(parsed, meta) {
  const services = parsed.serviceNames.map(name => normalizeService(name, parsed.services[name]))
  return {
    name: meta.name,
    projectName: meta.projectName,
    dir: meta.dir,
    file: meta.file,
    fileName: meta.fileName,
    mtimeMs: meta.mtimeMs || 0,
    services,
    unsupported: parsed.unsupported,
    warnings: parsed.warnings,
    dynamic: Array.isArray(parsed.dynamic) ? parsed.dynamic : [],
  }
}
