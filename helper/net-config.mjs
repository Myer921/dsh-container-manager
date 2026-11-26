/**
 * LXC 网络配置的解析 / 生成（helper 与测试共用）
 *
 * 为什么单独一个文件：lxc 的配置是一堆 lxc.net.N.key = value 行，改它很容易改坏。
 * 把「读成结构 → 校验 → 写回」抽出来，可以脱离 root 单测。
 */

import { isIPv4, isIPv6 } from 'node:net'

export class HelperError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    if (hint) this.hint = hint
  }
}

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
export const IFNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/
export const NIC_TYPES = new Set(['veth', 'macvlan', 'phys', 'none', 'empty'])
export const MACVLAN_MODES = ['bridge', 'vepa', 'private', 'passthru']
export const CAP_DROP_ALLOW = new Set([
  'CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID',
  'SETPCAP', 'LINUX_IMMUTABLE', 'NET_BIND_SERVICE', 'NET_BROADCAST', 'NET_ADMIN', 'NET_RAW',
  'IPC_LOCK', 'IPC_OWNER', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_PTRACE', 'SYS_PACCT',
  'SYS_ADMIN', 'SYS_BOOT', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'MKNOD',
  'LEASE', 'AUDIT_WRITE', 'AUDIT_CONTROL', 'SETFCAP', 'MAC_OVERRIDE', 'MAC_ADMIN', 'SYSLOG',
  'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_READ', 'PERFMON', 'BPF', 'CHECKPOINT_RESTORE',
])

export function assertName(value, field = '容器名') {
  const text = String(value ?? '').trim()
  if (!NAME_RE.test(text)) throw new HelperError('BAD_ARGS', `${field}不合法：${text || '(空)'}`)
  return text
}

export function assertIfname(value, field = '接口名') {
  const text = String(value ?? '').trim()
  if (!IFNAME_RE.test(text)) throw new HelperError('BAD_ARGS', `${field}不合法：${text || '(空)'}`)
  return text
}

export function assertCidr(value, field = 'CIDR') {
  const text = String(value ?? '').trim()
  const slash = text.indexOf('/')
  if (slash <= 0) throw new HelperError('BAD_ARGS', `${field}必须是 a.b.c.d/nn`)
  const address = text.slice(0, slash)
  const prefix = Number(text.slice(slash + 1))
  if (!isIPv4(address) && !isIPv6(address)) throw new HelperError('BAD_ARGS', `${field}地址不合法：${address}`)
  const max = isIPv4(address) ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new HelperError('BAD_ARGS', `${field}前缀不合法`)
  return text
}

export function assertIp(value, field = 'IP') {
  const text = String(value ?? '').trim()
  if (!isIPv4(text) && !isIPv6(text)) throw new HelperError('BAD_ARGS', `${field}不合法：${text}`)
  return text
}

/** 把 lxc 配置里的 lxc.net.* 行读成结构化网卡数组（按索引排序）。 */
export function parseConfigNet(text) {
  /** @type {Map<number, any>} */
  const byIndex = new Map()
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^lxc\.net\.(\d+)\.([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const index = Number(match[1])
    const key = match[2]
    const value = match[3].trim()
    if (!byIndex.has(index)) byIndex.set(index, { index, flags: [], ipv4: {}, ipv6: {}, macvlan: {}, veth: {} })
    const nic = byIndex.get(index)
    if (key === 'type') nic.type = value
    else if (key === 'link') nic.link = value
    else if (key === 'name') nic.name = value
    else if (key === 'flags') nic.flags = value.split(/\s+/).filter(Boolean)
    else if (key === 'hwaddr') nic.hwaddr = value
    else if (key === 'mtu') nic.mtu = Number(value)
    else if (key.startsWith('ipv4.')) nic.ipv4[key.slice(5)] = value
    else if (key.startsWith('ipv6.')) nic.ipv6[key.slice(5)] = value
    else if (key.startsWith('macvlan.')) nic.macvlan[key.slice(8)] = value
    else if (key.startsWith('veth.')) nic.veth[key.slice(5)] = value
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/** 结构化网卡 → lxc.net.* 行数组。 */
export function renderNetConfig(nics) {
  const lines = []
  nics.forEach((nic, index) => {
    const prefix = `lxc.net.${index}.`
    lines.push(`${prefix}type = ${nic.type}`)
    if (nic.type === 'veth' || nic.type === 'macvlan' || nic.type === 'phys') {
      if (nic.link) lines.push(`${prefix}link = ${nic.link}`)
    }
    if (nic.type === 'macvlan' && nic.macvlan?.mode) {
      lines.push(`${prefix}macvlan.mode = ${nic.macvlan.mode}`)
    }
    if (nic.name) lines.push(`${prefix}name = ${nic.name}`)
    if (nic.hwaddr) lines.push(`${prefix}hwaddr = ${nic.hwaddr}`)
    if (nic.mtu) lines.push(`${prefix}mtu = ${nic.mtu}`)
    lines.push(`${prefix}flags = ${Array.isArray(nic.flags) && nic.flags.length > 0 ? nic.flags.join(' ') : 'up'}`)
    if (nic.ipv4?.address) lines.push(`${prefix}ipv4.address = ${nic.ipv4.address}`)
    if (nic.ipv4?.gateway) lines.push(`${prefix}ipv4.gateway = ${nic.ipv4.gateway}`)
    if (nic.ipv6?.address) lines.push(`${prefix}ipv6.address = ${nic.ipv6.address}`)
    if (nic.ipv6?.gateway) lines.push(`${prefix}ipv6.gateway = ${nic.ipv6.gateway}`)
  })
  return lines
}

/** 校验并规范化一块网卡（这里不做任何 IO）。 */
export function normalizeNic(raw) {
  if (!raw || typeof raw !== 'object') throw new HelperError('BAD_ARGS', '每块网卡必须是对象。')
  const type = String(raw.type ?? '').toLowerCase()
  if (!NIC_TYPES.has(type)) throw new HelperError('BAD_ARGS', `网卡类型只支持 ${[...NIC_TYPES].join(' / ')}`)
  const nic = { type, flags: ['up'], ipv4: {}, ipv6: {}, macvlan: {} }
  if (raw.link) nic.link = assertIfname(raw.link, 'link')
  if (raw.name) nic.name = assertIfname(raw.name, 'name')
  if (raw.hwaddr) {
    const hwaddr = String(raw.hwaddr).trim()
    if (!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(hwaddr)) throw new HelperError('BAD_ARGS', `MAC 不合法：${hwaddr}`)
    nic.hwaddr = hwaddr.toLowerCase()
  }
  // 不是 config 字段，只是「这个 MAC 是插件随手给的」的标记 ——
  // handler 撞车时会照着它决定是自动换个新的，还是把人手填的值原样报错。
  // renderNetConfig 只读明确的字段名，所以它不会被写进 config。
  if (raw.hwaddrAuto === true) nic.hwaddrAuto = true
  if (raw.mtu != null) {
    const mtu = Number(raw.mtu)
    if (!Number.isInteger(mtu) || mtu < 68 || mtu > 65535) throw new HelperError('BAD_ARGS', `MTU 不合法：${raw.mtu}`)
    nic.mtu = mtu
  }
  if (raw.ipv4?.address) nic.ipv4.address = assertCidr(raw.ipv4.address, 'IPv4 地址')
  if (raw.ipv4?.gateway) nic.ipv4.gateway = assertIp(raw.ipv4.gateway, 'IPv4 网关')
  if (raw.ipv6?.address) nic.ipv6.address = assertCidr(raw.ipv6.address, 'IPv6 地址')
  if (raw.ipv6?.gateway) nic.ipv6.gateway = assertIp(raw.ipv6.gateway, 'IPv6 网关')
  if (type === 'macvlan') {
    const mode = String(raw.macvlan?.mode ?? 'bridge')
    if (!MACVLAN_MODES.includes(mode)) throw new HelperError('BAD_ARGS', `macvlan.mode 不合法：${mode}`)
    nic.macvlan.mode = mode
    if (!nic.link) throw new HelperError('BAD_ARGS', 'macvlan 必须给 link（物理网卡名）。')
  }
  if (type === 'veth' && !nic.link) throw new HelperError('BAD_ARGS', 'veth 必须给 link（网桥名，例如 lxcbr0）。')
  if (type === 'phys' && !nic.link) throw new HelperError('BAD_ARGS', 'phys 必须给 link。')
  return nic
}

/** 把配置文本里的 lxc.net.* 段整体换掉，其余行原样保留。 */
export function replaceNetSection(configText, nics) {
  const kept = []
  let skippedHeader = false
  for (const line of String(configText).split('\n')) {
    if (/^\s*lxc\.net\.\d+\./.test(line)) continue
    if (!skippedHeader && /^\s*#\s*Network configuration/i.test(line)) {
      skippedHeader = true
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  const block = ['', '# Network configuration (managed by dsh-container-manager)', ...renderNetConfig(nics), '']
  return kept.join('\n') + '\n' + block.join('\n')
}
/* ───────────────────────── 创建 / 配置的白名单（helper 与插件共用） ───────────────────────── */

// 这几个是「规则」，不是「推荐清单」：lxc-create 的 --dist/--release 最终会被拼进模板路径，
// 所以只允许字符集，而不是维护一份会过期的发行版列表。
export const DISTROS = /^[a-z][a-z0-9.+-]{1,40}$/
export const RELEASES = /^[a-z0-9][a-z0-9.-]{0,30}$/
export const ARCHES = new Set(['amd64', 'arm64', 'armhf', 'i386'])

/** 面板/工具能改的 LXC 配置项：内部名 → 配置文件里的键。 */
export const LXC_SETTINGS = {
  // 基本
  autostart: 'lxc.start.auto',
  startOrder: 'lxc.start.order',
  startDelay: 'lxc.start.delay',
  hostname: 'lxc.uts.name',
  initCmd: 'lxc.init.cmd',
  // 安全（cap.drop 可以在配置里出现多行，写的时候要全部替换）
  capDrop: 'lxc.cap.drop',
  // 资源
  // cpuset 是「绑核」：写上 0-3，容器里 nproc 就报 4。cpu.max 是配额头寸，
  // 容器仍然看到全部核、只是被限速 —— 面板要的是前者（和 PVE 的 cores 一致）。
  cores: 'lxc.cgroup2.cpuset.cpus',
  cpuMax: 'lxc.cgroup2.cpu.max',
  cpuWeight: 'lxc.cgroup2.cpu.weight',
  memoryMax: 'lxc.cgroup2.memory.max',
  memoryHigh: 'lxc.cgroup2.memory.high',
  swapMax: 'lxc.cgroup2.memory.swap.max',
  oomGroup: 'lxc.cgroup2.memory.oom.group',
  pidsMax: 'lxc.cgroup2.pids.max',
  ioWeight: 'lxc.cgroup2.io.weight',
}

const CGROUP_V1_MEMORY = 'lxc.cgroup.memory.limit_in_bytes'

// 反查表：配置键 -> 面板字段。cap.drop 单独处理（它能出现多行）。
const FIELD_BY_KEY = {}
for (const [field, key] of Object.entries(LXC_SETTINGS)) FIELD_BY_KEY[key] = field
FIELD_BY_KEY[CGROUP_V1_MEMORY] = 'memoryMax'

/** 从配置文本里读出面板管得着的那几项，读不到就给默认值。 */
export function readLxcSettings(configText) {
  const out = {
    autostart: false, startOrder: '', startDelay: '', hostname: '', initCmd: '', capDrop: '',
    memoryMax: '', memoryHigh: '', swapMax: '', oomGroup: false,
    cores: '', cpuMax: '', cpuWeight: '', pidsMax: '', ioWeight: '',
  }
  const caps = []
  for (const line of String(configText ?? '').split('\n')) {
    const match = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1]
    const value = match[2]
    // cap.drop 允许写多行，拼起来才完整
    if (key === LXC_SETTINGS.capDrop) {
      if (value) caps.push(value)
      continue
    }
    const field = FIELD_BY_KEY[key]
    if (!field) continue
    if (field === 'autostart' || field === 'oomGroup') out[field] = value === '1'
    else out[field] = value
  }
  out.capDrop = caps.join(' ')
  return out
}

/**
 * 改配置里的 start.auto / 内存上限，其余行逐字保留（顺序也不动）。
 * memoryMax 传 '' / 0 表示把那一行删掉，回到「不限」。
 * 原来写的是 cgroup v1 的键，就继续改那个键 —— 两个都写会让 lxc 起不来。
 */
export function writeLxcSettings(configText, settings = {}) {
  const lines = String(configText ?? '').split('\n')
  const keyRe = key => new RegExp('^\\s*' + key.replace(/\./g, '\\.') + '\\s*=')

  function insertAtEnd(rendered) {
    let insertAt = lines.length
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1
    lines.splice(insertAt, 0, rendered)
  }

  function assertScalar(key, rawValue) {
    if (/[\r\n\0]/.test(String(rawValue))) throw new HelperError('BAD_ARGS', `${key} 不允许换行或 NUL。`)
  }

  function setOne(key, rawValue) {
    const re = keyRe(key)
    const index = lines.findIndex(line => re.test(line))
    if (rawValue === null) {
      if (index >= 0) lines.splice(index, 1)
      return
    }
    assertScalar(key, rawValue)
    const rendered = `${key} = ${rawValue}`
    if (index >= 0) {
      lines[index] = rendered
      return
    }
    insertAtEnd(rendered)
  }

  // cap.drop 可以出现多行，改的时候得把所有旧行清掉，否则旧的限制还挂着。
  function setAll(key, rawValue) {
    const re = keyRe(key)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (re.test(lines[index])) lines.splice(index, 1)
    }
    if (!rawValue) return
    assertScalar(key, rawValue)
    if (key === LXC_SETTINGS.capDrop) {
      for (const cap of String(rawValue).trim().split(/\s+/)) {
        if (!CAP_DROP_ALLOW.has(cap.toUpperCase())) throw new HelperError('BAD_ARGS', '未知 capability：' + cap)
      }
    }
    insertAtEnd(`${key} = ${rawValue}`)
  }

  const blank = raw => raw === '' || raw === null || raw === undefined || raw === 0 || raw === '0'
  const text = raw => (blank(raw) ? null : String(raw))

  if ('autostart' in settings) setOne(LXC_SETTINGS.autostart, settings.autostart ? '1' : '0')
  if ('startOrder' in settings) setOne(LXC_SETTINGS.startOrder, text(settings.startOrder))
  if ('startDelay' in settings) setOne(LXC_SETTINGS.startDelay, text(settings.startDelay))
  if ('hostname' in settings) setOne(LXC_SETTINGS.hostname, text(settings.hostname))
  if ('initCmd' in settings) setOne(LXC_SETTINGS.initCmd, text(settings.initCmd))
  if ('capDrop' in settings) setAll(LXC_SETTINGS.capDrop, blank(settings.capDrop) ? '' : String(settings.capDrop))

  if ('cores' in settings) setOne(LXC_SETTINGS.cores, text(settings.cores))
  if ('cpuMax' in settings) setOne(LXC_SETTINGS.cpuMax, text(settings.cpuMax))
  if ('cpuWeight' in settings) setOne(LXC_SETTINGS.cpuWeight, text(settings.cpuWeight))
  if ('memoryHigh' in settings) setOne(LXC_SETTINGS.memoryHigh, text(settings.memoryHigh))
  // oom.group 只支持 0/1，关掉就把那一行删掉，回到 cgroup 默认的 0。
  if ('oomGroup' in settings) setOne(LXC_SETTINGS.oomGroup, settings.oomGroup ? '1' : null)
  if ('pidsMax' in settings) setOne(LXC_SETTINGS.pidsMax, text(settings.pidsMax))
  if ('ioWeight' in settings) setOne(LXC_SETTINGS.ioWeight, text(settings.ioWeight))
  if ('swapMax' in settings) setOne(LXC_SETTINGS.swapMax, text(settings.swapMax))
  if ('memoryMax' in settings) {
    const memoryKey = lines.some(line => keyRe(CGROUP_V1_MEMORY).test(line)) ? CGROUP_V1_MEMORY : LXC_SETTINGS.memoryMax
    const value = settings.memoryMax === '' || settings.memoryMax === 0 || settings.memoryMax === '0'
      ? null
      : String(settings.memoryMax)
    setOne(memoryKey, value)
  }
  return lines.join('\n')
}

