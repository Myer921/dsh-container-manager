/**
 * 宿主网络：读用 ip / nmcli / ss / /proc，写走 sudo -n（本机免密）。
 *
 * 为什么不用 systemd-networkd / netplan：这台机一个都没有，全部由
 * NetworkManager 管（主网卡 DHCP、wgjump 是 NM 托管的 WireGuard、
 * lxcbr0/docker0 是外部创建后被 NM 认领）。防火墙是纯 nftables（没有
 * ufw/firewalld，iptables 只剩 iptables-nft 的遗留兼容层）。
 *
 * 解析函数都是纯函数，单测直接喂字符串。
 */

import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { paths } from './config.js'
import { CmError, ERR, execFileAsync } from './util.js'

const SYS_NET = '/sys/class/net'

/** `ip -j -d addr show` 的一行 → 人能读的接口。 */
export function normalizeInterface(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.ifname ?? '')
  if (!name) return null
  const kind = String(raw.linkinfo?.info_kind ?? '') || (raw.link_type === 'loopback' ? 'loopback' : 'ethernet')
  const addresses = []
  for (const info of Array.isArray(raw.addr_info) ? raw.addr_info : []) {
    if (!info || typeof info !== 'object') continue
    if (info.family !== 'inet' && info.family !== 'inet6') continue
    addresses.push({
      family: info.family,
      address: String(info.local ?? ''),
      prefix: Number(info.prefixlen) || 0,
      scope: String(info.scope ?? ''),
      dynamic: Boolean(info.dynamic),
      // 同一个 IP 既有 global 也有 link 时，界面上只关心 global 那个
    })
  }
  return {
    name,
    index: Number(raw.ifindex) || 0,
    type: kind,
    state: String(raw.operstate ?? '').toLowerCase(),
    mtu: Number(raw.mtu) || 0,
    mac: String(raw.address ?? ''),
    flags: Array.isArray(raw.flags) ? raw.flags : [],
    addresses,
  }
}

export function parseAddrJson(text) {
  let rows
  try {
    rows = JSON.parse(String(text ?? '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.map(normalizeInterface).filter(Boolean)
}

export function parseRouteJson(text) {
  let rows
  try {
    rows = JSON.parse(String(text ?? '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.map(raw => ({
    destination: String(raw.dst ?? ''),
    gateway: raw.gateway ? String(raw.gateway) : '',
    device: String(raw.dev ?? ''),
    protocol: String(raw.protocol ?? ''),
    metric: Number(raw.metric) || 0,
    prefsrc: String(raw.prefsrc ?? ''),
    flags: Array.isArray(raw.flags) ? raw.flags : [],
  })).filter(row => row.destination)
}

/** nmcli -t 的冒号分隔；名字里可能带冒号，所以从尾部切。 */
export function parseNmcliConnections(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(':')
    if (parts.length < 4) continue
    const state = parts[parts.length - 1]
    const type = parts[parts.length - 2]
    const device = parts[parts.length - 3]
    const name = parts.slice(0, parts.length - 3).join(':')
    if (!name) continue
    rows.push({ name, device, type, state })
  }
  return rows
}

export function parseResolvConf(text) {
  const servers = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^nameserver\s+(\S+)/i.exec(line.trim())
    if (match) servers.push(match[1])
  }
  return servers
}

/** `ss -tlnH` → 端口占用。 */
export function parseSsListen(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] !== 'LISTEN') continue
    const local = parts[3] ?? ''
    const cut = local.lastIndexOf(':')
    if (cut < 0) continue
    rows.push({
      address: local.slice(0, cut) || '*',
      port: Number(local.slice(cut + 1)) || 0,
    })
  }
  return rows.filter(row => row.port > 0).sort((a, b) => a.port - b.port)
}

/** nft list ruleset → 表 / 链的摘要（原文太长，界面上只给骨架）。 */
export function parseNftTables(text) {
  const tables = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const tableMatch = /^table\s+(\S+)\s+(\S+)\s*\{/.exec(line.trim())
    if (tableMatch) {
      current = { family: tableMatch[1], name: tableMatch[2], chains: 0, managedBy: '' }
      tables.push(current)
      continue
    }
    if (current && /^\s*chain\s+\S+/.test(line)) current.chains += 1
  }
  // nft 自带的告警行会说明某张表是谁在管
  for (const line of String(text ?? '').split('\n')) {
    const warn = /table\s+(\S+)\s+(\S+)\s+is managed by\s+(.+)$/.exec(line.trim())
    if (!warn) continue
    const hit = tables.find(item => item.family === warn[1] && item.name === warn[2])
    if (hit) hit.managedBy = warn[3].trim()
  }
  return tables
}

function readStats(name, readImpl = readFileSync) {
  const pick = (key) => {
    try {
      return Number(readImpl(SYS_NET + '/' + name + '/statistics/' + key, 'utf8').toString().trim()) || 0
    } catch {
      return 0
    }
  }
  return { rxBytes: pick('rx_bytes'), txBytes: pick('tx_bytes') }
}

/**
 * 一次取齐宿主网络现状：接口 / 路由 / DNS / NM 连接 / 监听端口。
 * 全部只读，不碰任何配置。
 */
export async function hostNetwork(options = {}) {
  const exec = options.exec ?? execFileAsync
  const readFileImpl = options.readFile ?? readFile
  const statsReader = options.readStats ?? readStats
  const readSpeed = options.readSpeed ?? readLinkSpeed
  const readDriver = options.readDriver ?? readLinkDriver
  const [addr, route, resolv, nmcli, ss, neigh] = await Promise.all([
    exec('ip', ['-j', '-d', 'addr', 'show'], { timeoutMs: 8000 }),
    exec('ip', ['-j', 'route', 'show'], { timeoutMs: 8000 }),
    readFileImpl('/etc/resolv.conf', 'utf8').catch(() => ''),
    exec('nmcli', ['-t', '-f', 'NAME,DEVICE,TYPE,STATE', 'con', 'show'], { timeoutMs: 8000 }),
    exec('ss', ['-tlnH'], { timeoutMs: 8000 }),
    exec('ip', ['-j', 'neigh', 'show'], { timeoutMs: 6000 }),
  ])
  const interfaces = addr && addr.code === 0 ? parseAddrJson(addr.stdout) : []
  return {
    ok: true,
    at: new Date().toISOString(),
    interfaces: interfaces.map(item => ({
      ...item,
      speed: readSpeed(item.name),
      driver: readDriver(item.name),
      stats: statsReader(item.name),
    })),
    routes: route && route.code === 0 ? parseRouteJson(route.stdout) : [],
    dns: parseResolvConf(resolv),
    connections: nmcli && nmcli.code === 0 ? parseNmcliConnections(nmcli.stdout) : [],
    listeners: ss && ss.code === 0 ? parseSsListen(ss.stdout) : [],
    neighbors: neigh && neigh.code === 0 ? parseNeighbors(neigh.stdout) : [],
  }
}

/**
 * 防火墙骨架。nft 要 root，走 sudo -n；本机没装 sudo 或没免密时如实说。
 */
export async function firewallSummary(options = {}) {
  const exec = options.exec ?? execFileAsync
  const result = await exec('sudo', ['-n', '/usr/sbin/nft', 'list', 'ruleset'], { timeoutMs: 10_000 })
  if (!result || result.missing) {
    return { ok: false, reason: '找不到 sudo 或 nft。', tables: [] }
  }
  if (result.timedOut) return { ok: false, reason: 'nft 读取超时。', tables: [] }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join('\n') || ('nft 退出码 ' + result.code),
      tables: [],
    }
  }
  return { ok: true, tables: parseNftTables(result.stdout), raw: String(result.stdout ?? '').slice(0, 200_000) }
}

/** 连通性诊断：ping 一把，拿到 rtt 或明确的原因。 */
export async function diagnose(target, options = {}) {
  const host = String(target ?? '').trim()
  if (!host || /[^A-Za-z0-9.:_\-]/.test(host)) {
    return { ok: false, reason: '目标只能填主机名或 IP（不接受命令片段）。' }
  }
  const exec = options.exec ?? execFileAsync
  const count = Math.min(10, Math.max(1, Number(options.count) || 4))
  const result = await exec('ping', ['-c', String(count), '-W', '2', host], { timeoutMs: (count * 2500) + 5000 })
  if (!result || result.missing) return { ok: false, reason: '这台机没有 ping。' }
  if (result.timedOut) return { ok: false, reason: 'ping 超时（' + count + ' 个包没等到）。' }
  const output = String(result.stdout ?? '')
  const loss = /([\d.]+)%\s*packet loss/.exec(output)
  const rtt = /rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(output)
  const reachable = result.code === 0 && (!loss || Number(loss[1]) < 100)
  return {
    ok: reachable,
    target: host,
    packets: count,
    lossPercent: loss ? Number(loss[1]) : null,
    rtt: rtt ? { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) } : null,
    output: output.trim().split('\n').slice(-3).join('\n'),
    reason: reachable ? '' : (loss ? '丢了 ' + loss[1] + '% 的包' : 'ping 不通'),
  }
}

/* ───────────────────────── 写：NetworkManager 连接 ───────────────────────── */

const CONN_DIR = '/etc/NetworkManager/system-connections'

export const CONNECTION_FIELDS = [
  'connection.id',
  'connection.uuid',
  'connection.autoconnect',
  'connection.interface-name',
  'ipv4.method',
  'ipv4.addresses',
  'ipv4.gateway',
  'ipv4.dns',
  'ipv4.never-default',
  'ipv6.method',
  'ipv6.addresses',
  'ipv6.gateway',
  '802-3-ethernet.mtu',
]

/** nmcli -g 是按字段顺序逐行吐的，空字段就是空行 —— 所以只能按下标对。 */
export function parseConnectionFields(values, fields = CONNECTION_FIELDS) {
  const lines = String(values ?? '').split('\n')
  const out = {}
  fields.forEach((field, index) => {
    out[field] = String(lines[index] ?? '').trim()
  })
  return out
}

export async function readConnection(name, options = {}) {
  const exec = options.exec ?? execFileAsync
  const id = String(name ?? '').trim()
  if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  const result = await exec('nmcli', ['-g', CONNECTION_FIELDS.join(','), 'con', 'show', id], { timeoutMs: 8000 })
  if (!result || result.missing) throw new CmError(ERR.MISSING_BINARY, '这台机没有 nmcli。')
  if (result.code !== 0) {
    throw new CmError(ERR.NOT_FOUND, (result.stderr || result.stdout || '').trim() || ('找不到连接 ' + id))
  }
  return { name: id, fields: parseConnectionFields(result.stdout) }
}

/** 把一条连接的原生配置文件备份到插件数据目录，返回备份路径（失败返回 null）。 */
export async function backupConnection(name, options = {}) {
  const exec = options.exec ?? execFileAsync
  const writeImpl = options.writeFile ?? writeFile
  const mkdirImpl = options.mkdir ?? mkdir
  const file = CONN_DIR + '/' + String(name) + '.nmconnection'
  const cat = await exec('sudo', ['-n', 'cat', file], { timeoutMs: 8000 })
  if (!cat || cat.code !== 0 || !cat.stdout) return null
  const dir = (options.backupDir ?? paths().dir) + '/backups'
  await mkdirImpl(dir, { recursive: true, mode: 0o700 })
  const target = dir + '/nm-' + String(name).replace(/[^\w.-]+/g, '_') + '-' + Date.now() + '.nmconnection'
  await writeImpl(target, cat.stdout, { mode: 0o600 })
  return target
}

/** nmcli 的 ipv4.routes 是 "目的 网关 metric" 空格分隔、多条逗号分隔。 */
export function formatRoute(route) {
  if (Array.isArray(route)) {
    return route.filter(part => part !== undefined && part !== null && part !== '').map(String).join(' ')
  }
  if (route && typeof route === 'object') {
    const parts = [route.destination]
    if (route.gateway) parts.push(String(route.gateway))
    if (route.metric) parts.push(String(Number(route.metric)))
    return parts.filter(Boolean).join(' ')
  }
  return String(route ?? '')
}

/**
 * 把 patch 翻成 nmcli 参数；空的 patch 直接拒，别让一次「什么都没改」也走挂起。
 *
 * 顶层是 IPv4（历史结构，前面几版都在用），IPv6 与各类设备的专属项放在子对象里。
 */
export function connectionPatchArgs(patch = {}) {
  const args = []
  // IPv4
  if (patch.method) args.push('ipv4.method', String(patch.method))
  if (Array.isArray(patch.addresses)) args.push('ipv4.addresses', patch.addresses.map(String).join(','))
  if ('gateway' in patch) args.push('ipv4.gateway', String(patch.gateway ?? ''))
  if (Array.isArray(patch.dns)) args.push('ipv4.dns', patch.dns.map(String).join(' '))
  if (Array.isArray(patch.dnsSearch)) args.push('ipv4.dns-search', patch.dnsSearch.map(String).join(' '))
  if (Array.isArray(patch.routes)) args.push('ipv4.routes', patch.routes.map(formatRoute).join(','))
  if ('neverDefault' in patch) args.push('ipv4.never-default', patch.neverDefault ? 'yes' : 'no')
  if ('ignoreAutoDns' in patch) args.push('ipv4.ignore-auto-dns', patch.ignoreAutoDns ? 'yes' : 'no')
  // IPv6
  if (patch.ipv6 && typeof patch.ipv6 === 'object') {
    const v6 = patch.ipv6
    if (v6.method) args.push('ipv6.method', String(v6.method))
    if (Array.isArray(v6.addresses)) args.push('ipv6.addresses', v6.addresses.map(String).join(','))
    if ('gateway' in v6) args.push('ipv6.gateway', String(v6.gateway ?? ''))
    if (Array.isArray(v6.dns)) args.push('ipv6.dns', v6.dns.map(String).join(' '))
    if (Array.isArray(v6.routes)) args.push('ipv6.routes', v6.routes.map(formatRoute).join(','))
    if ('neverDefault' in v6) args.push('ipv6.never-default', v6.neverDefault ? 'yes' : 'no')
  }
  // 通用
  if ('mtu' in patch) {
    args.push(patch.mtu === '' || patch.mtu === 0 || patch.mtu === '0' ? '802-3-ethernet.mtu' : '802-3-ethernet.mtu', String(patch.mtu ?? ''))
  }
  if ('clonedMac' in patch) args.push('802-3-ethernet.cloned-mac-address', String(patch.clonedMac ?? ''))
  if ('wakeOnLan' in patch) args.push('802-3-ethernet.wake-on-lan', String(patch.wakeOnLan ?? 'default'))
  if ('autoconnect' in patch) args.push('connection.autoconnect', patch.autoconnect ? 'yes' : 'no')
  if ('autoconnectPriority' in patch) {
    args.push('connection.autoconnect-priority', String(Number(patch.autoconnectPriority) || 0))
  }
  if ('zone' in patch) args.push('connection.zone', String(patch.zone ?? ''))
  // 具体设备
  if (patch.bridge && typeof patch.bridge === 'object') {
    const br = patch.bridge
    if ('stp' in br) args.push('bridge.stp', br.stp ? 'yes' : 'no')
    if ('priority' in br) args.push('bridge.priority', String(Number(br.priority) || 32768))
    if ('forwardDelay' in br) args.push('bridge.forward-delay', String(Number(br.forwardDelay) || 15))
    if ('helloTime' in br) args.push('bridge.hello-time', String(Number(br.helloTime) || 2))
  }
  if (patch.bond && typeof patch.bond === 'object') {
    const bond = patch.bond
    const options = []
    if (bond.mode) options.push('mode=' + String(bond.mode))
    if ('miimon' in bond) options.push('miimon=' + String(Number(bond.miimon) || 100))
    if (bond.lacpRate) options.push('lacp_rate=' + String(bond.lacpRate))
    if (options.length) args.push('bond.options', options.join(','))
  }
  if (patch.vlan && typeof patch.vlan === 'object') {
    const vlan = patch.vlan
    if ('id' in vlan) args.push('vlan.id', String(Number(vlan.id) || 0))
  }
  if (patch.wireguard && typeof patch.wireguard === 'object') {
    const wg = patch.wireguard
    if ('privateKey' in wg) args.push('wireguard.private-key', String(wg.privateKey ?? ''))
    if ('listenPort' in wg) args.push('wireguard.listen-port', String(Number(wg.listenPort) || 0))
  }
  return args
}

export function describeConnectionPatch(patch = {}) {
  const parts = []
  if (patch.method) parts.push('IPv4 方式改 ' + patch.method)
  if (Array.isArray(patch.addresses)) parts.push('地址 ' + (patch.addresses.join(', ') || '（清空）'))
  if ('gateway' in patch) parts.push('网关 ' + (patch.gateway || '（清空）'))
  if (Array.isArray(patch.dns)) parts.push('DNS ' + (patch.dns.join(', ') || '（清空）'))
  if ('neverDefault' in patch) parts.push('默认路由 ' + (patch.neverDefault ? '不用这条' : '可用这条'))
  if ('mtu' in patch) parts.push('MTU ' + (patch.mtu || '自动'))
  if ('autoconnect' in patch) parts.push('自动连接 ' + (patch.autoconnect ? '开' : '关'))
  return parts.join('，') || '无改动'
}

export async function restoreConnection(name, backup, options = {}) {
  const exec = options.exec ?? execFileAsync
  if (!backup) return false
  const file = CONN_DIR + '/' + String(name) + '.nmconnection'
  const restored = await exec('sudo', ['-n', 'install', '-m', '600', backup, file], { timeoutMs: 15_000 })
  if (!restored || restored.code !== 0) return false
  const up = await exec('sudo', ['-n', 'nmcli', 'con', 'up', String(name)], { timeoutMs: 30_000 })
  return Boolean(up && up.code === 0)
}

export async function applyConnectionPatch(patch, options = {}) {
  const exec = options.exec ?? execFileAsync
  const name = String(patch?.name ?? '').trim()
  if (!name) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  const args = connectionPatchArgs(patch.patch ?? {})
  if (args.length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项。')
  const backup = await backupConnection(name, options)
  const modify = await exec('sudo', ['-n', 'nmcli', 'con', 'modify', name, ...args], { timeoutMs: 20_000 })
  if (!modify || modify.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 sudo / nmcli。')
  if (modify.code !== 0) {
    throw new CmError(ERR.NODE_UNAVAILABLE,
      (modify.stderr || modify.stdout || '').trim() || ('nmcli con modify 退出码 ' + modify.code),
      'lxcbr0 / docker0 这类 externally 托管的连接改不动，要改它们的配置得动创建它们的组件。')
  }
  // 改完必须把连接拉起来一次，配置才真正落到网卡上；这一步会短暂断连。
  const up = await exec('sudo', ['-n', 'nmcli', 'con', 'up', name], { timeoutMs: 30_000 })
  if (up && up.code !== 0) {
    const rolledBack = await restoreConnection(name, backup, { exec })
    throw new CmError(
      ERR.NODE_UNAVAILABLE,
      '连接激活失败：' + ((up.stderr || up.stdout || '').trim().slice(0, 400)) + (rolledBack ? '，已恢复旧配置。' : '，旧配置恢复失败，请人工检查。'),
      rolledBack ? '旧配置已恢复，可以重新发起。' : '备份在 ' + backup + '，请手动恢复。',
    )
  }
  return { name, backup, activated: true, activationError: '', rolledBack: false }
}

export async function setConnectionState({ name, up }, options = {}) {
  const exec = options.exec ?? execFileAsync
  const id = String(name ?? '').trim()
  if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  const wantUp = up !== false
  const result = await exec('sudo', ['-n', 'nmcli', 'con', wantUp ? 'up' : 'down', id], { timeoutMs: 30_000 })
  if (!result || result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 sudo / nmcli。')
  if (result.code !== 0) {
    throw new CmError(ERR.NODE_UNAVAILABLE, (result.stderr || result.stdout || '').trim() || ('nmcli 退出码 ' + result.code))
  }
  return { name: id, up: wantUp }
}


/* ───────────────────────── 连接：完整读 / 新建 / 删除 ───────────────────────── */

/** nmcli -t -f all 是每行 key:value，值的冒号（IPv6）要留在值里。 */
export function parseTerseAll(text) {
  const map = {}
  for (const line of String(text ?? '').split('\n')) {
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    map[line.slice(0, cut)] = line.slice(cut + 1)
  }
  return map
}

/** 逗号分隔的多值（地址 / 路由 / DNS）。 */
export function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

/** 一条连接的完整画像：通用 + IPv4/IPv6 + 各设备专属项。 */
export function normalizeConnection(fields) {
  const raw = fields || {}
  const pick = key => String(raw[key] ?? '')
  return {
    name: pick('connection.id'),
    uuid: pick('connection.uuid'),
    type: pick('connection.type'),
    interfaceName: pick('connection.interface-name'),
    autoconnect: pick('connection.autoconnect') !== 'no',
    autoconnectPriority: Number(pick('connection.autoconnect-priority')) || 0,
    zone: pick('connection.zone'),
    master: pick('connection.master'),
    slaveType: pick('connection.slave-type'),
    readOnly: pick('connection.read-only') === 'yes',
    ipv4: {
      method: pick('ipv4.method'),
      addresses: splitList(pick('ipv4.addresses')),
      gateway: pick('ipv4.gateway'),
      dns: splitList(pick('ipv4.dns').replace(/\s+/g, ',')),
      dnsSearch: splitList(pick('ipv4.dns-search')),
      routes: splitList(pick('ipv4.routes')),
      neverDefault: pick('ipv4.never-default') === 'yes',
      routeMetric: Number(pick('ipv4.route-metric')) || 0,
    },
    ipv6: {
      method: pick('ipv6.method'),
      addresses: splitList(pick('ipv6.addresses')),
      gateway: pick('ipv6.gateway'),
      dns: splitList(pick('ipv6.dns').replace(/\s+/g, ',')),
      routes: splitList(pick('ipv6.routes')),
      neverDefault: pick('ipv6.never-default') === 'yes',
    },
    ethernet: {
      mtu: Number(pick('802-3-ethernet.mtu')) || 0,
      clonedMac: pick('802-3-ethernet.cloned-mac-address'),
      wakeOnLan: pick('802-3-ethernet.wake-on-lan'),
    },
    bridge: {
      stp: pick('bridge.stp') === 'yes',
      priority: Number(pick('bridge.priority')) || 0,
      forwardDelay: Number(pick('bridge.forward-delay')) || 0,
      helloTime: Number(pick('bridge.hello-time')) || 0,
    },
    bond: { options: pick('bond.options') },
    vlan: { id: Number(pick('vlan.id')) || 0, parent: pick('vlan.parent') },
    wireguard: {
      privateKey: pick('wireguard.private-key'),
      listenPort: Number(pick('wireguard.listen-port')) || 0,
      peers: Object.keys(raw)
        .filter(key => /^wireguard\.peers\[\d+\]\.public-key$/.test(key))
        .map(key => ({
          publicKey: raw[key],
          endpoint: String(raw[key.replace('public-key', 'endpoint')] ?? ''),
          allowedIps: splitList(raw[key.replace('public-key', 'allowed-ips')] ?? ''),
        })),
    },
  }
}

/** 读一条连接的全部字段（一次 nmcli 调用）。 */
export async function readConnectionFull(name, options = {}) {
  const exec = options.exec ?? execFileAsync
  const id = String(name ?? '').trim()
  if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  const result = await exec('nmcli', ['-t', '-f', 'all', 'con', 'show', id], { timeoutMs: 8000 })
  if (!result || result.missing) throw new CmError(ERR.MISSING_BINARY, '这台机没有 nmcli。')
  if (result.code !== 0) {
    throw new CmError(ERR.NOT_FOUND, (result.stderr || result.stdout || '').trim() || ('找不到连接 ' + id))
  }
  const connection = normalizeConnection(parseTerseAll(result.stdout))
  // 私钥不出宿主
  if (connection.wireguard.privateKey) connection.wireguard.privateKey = '<hidden>'
  return connection
}

/** 能建的连接类型。team 要有 teamd，这台机没有。 */
export const CONNECTION_TYPES = ['ethernet', 'bridge', 'bond', 'vlan', 'wireguard', 'macvlan', 'dummy']

export const CONNECTION_TYPE_LABELS = {
  ethernet: '以太网',
  bridge: '网桥',
  bond: '链路聚合',
  vlan: 'VLAN',
  wireguard: 'WireGuard',
  macvlan: 'macvlan',
  dummy: '虚拟接口（dummy）',
}

/** nmcli con add 的参数。 */
export function connectionAddArgs(spec = {}) {
  const type = String(spec.type ?? '')
  const name = String(spec.name ?? '').trim()
  if (!name) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  if (!CONNECTION_TYPES.includes(type)) throw new CmError(ERR.BAD_ARGS, '不支持的类型：' + type)
  const args = ['con', 'add', 'type', type, 'con-name', name]
  const ifname = String(spec.interfaceName ?? '').trim()
  if (type === 'vlan') {
    if (!spec.parent) throw new CmError(ERR.BAD_ARGS, 'VLAN 要说清挂在哪块网卡上（parent）。')
    args.push('dev', String(spec.parent))
    const vlanId = Number(spec.vlanId)
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
      throw new CmError(ERR.BAD_ARGS, 'VLAN id 要在 1..4094 之间。')
    }
    args.push('id', String(vlanId))
  } else if (type === 'macvlan') {
    if (!spec.parent) throw new CmError(ERR.BAD_ARGS, 'macvlan 要挂在一块已有网卡上（parent）。')
    args.push('dev', String(spec.parent))
    if (ifname) args.push('ifname', ifname)
  } else if (type === 'dummy') {
    args.push('ifname', ifname || name)
  } else if (ifname) {
    args.push('ifname', ifname)
  }
  if (spec.mtu) args.push('mtu', String(Number(spec.mtu)))
  return args
}

export function describeConnectionSpec(spec = {}) {
  const parts = [CONNECTION_TYPE_LABELS[spec.type] ?? String(spec.type ?? '')]
  if (spec.interfaceName) parts.push('接口 ' + spec.interfaceName)
  if (spec.parent) parts.push('挂载 ' + spec.parent)
  if (spec.vlanId) parts.push('VLAN ' + spec.vlanId)
  if (spec.mtu) parts.push('MTU ' + spec.mtu)
  const ip = spec.ipv4 ?? {}
  if (ip.method) parts.push('IPv4 ' + ip.method + (ip.addresses?.length ? ' ' + ip.addresses.join(', ') : ''))
  return parts.join('，')
}

/** 新建连接：add → modify（补 IP 等）→ up。三步任何一步失败都要说清是哪一步。 */
export async function createConnection(spec = {}, options = {}) {
  const exec = options.exec ?? execFileAsync
  const args = connectionAddArgs(spec)
  const add = await exec('sudo', ['-n', 'nmcli', ...args], { timeoutMs: 20_000 })
  if (!add || add.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 sudo / nmcli。')
  if (add.code !== 0) {
    throw new CmError(ERR.NODE_UNAVAILABLE, (add.stderr || add.stdout || '').trim() || ('nmcli con add 退出码 ' + add.code))
  }
  const created = String(add.stdout ?? '').trim().split('\n').pop() || ''
  const match = /Connection '(.+)' \(([0-9a-f-]+)\)/.exec(created)
  const actual = match ? match[1] : String(spec.name)
  const patch = spec.patch ?? spec
  const modifyArgs = connectionPatchArgs(patch)
  if (modifyArgs.length) {
    const modify = await exec('sudo', ['-n', 'nmcli', 'con', 'modify', actual, ...modifyArgs], { timeoutMs: 20_000 })
    if (!modify || modify.code !== 0) {
      throw new CmError(
        ERR.NODE_UNAVAILABLE,
        '连接已创建（' + actual + '），但配置 IP 失败：' + ((modify?.stderr || modify?.stdout || '').trim() || ('退出码 ' + modify?.code)),
      )
    }
  }
  const up = await exec('sudo', ['-n', 'nmcli', 'con', 'up', actual], { timeoutMs: 30_000 })
  return {
    name: actual,
    activated: Boolean(up && up.code === 0),
    activationError: up && up.code !== 0 ? ((up.stderr || up.stdout || '').trim().slice(0, 400)) : '',
  }
}

export async function deleteConnection(name, options = {}) {
  const exec = options.exec ?? execFileAsync
  const id = String(name ?? '').trim()
  if (!id) throw new CmError(ERR.BAD_ARGS, '需要连接名。')
  const backup = await backupConnection(id, options)
  const result = await exec('sudo', ['-n', 'nmcli', 'con', 'delete', id], { timeoutMs: 20_000 })
  if (!result || result.missing) throw new CmError(ERR.MISSING_BINARY, '找不到 sudo / nmcli。')
  if (result.code !== 0) {
    throw new CmError(ERR.NODE_UNAVAILABLE, (result.stderr || result.stdout || '').trim() || ('nmcli con delete 退出码 ' + result.code))
  }
  return { name: id, deleted: true, backup }
}

/* ───────────────────────── 邻居 / 网卡细节 ───────────────────────── */

export function parseNeighbors(text) {
  let rows
  try {
    rows = JSON.parse(String(text ?? '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows
    .map(raw => ({
      address: String(raw.dst ?? ''),
      device: String(raw.dev ?? ''),
      mac: String(raw.lladdr ?? ''),
      state: Array.isArray(raw.state) ? raw.state.join(' ') : String(raw.state ?? ''),
    }))
    .filter(row => row.address)
}

/** 邻居表（ARP / NDP）。 */
export async function readNeighbors(options = {}) {
  const exec = options.exec ?? execFileAsync
  const result = await exec('ip', ['-j', 'neigh', 'show'], { timeoutMs: 6000 })
  if (!result || result.code !== 0) return []
  return parseNeighbors(result.stdout)
}

/** 链路速率（Mbps），虚拟网卡没有这个文件，返回 0。 */
export function readLinkSpeed(name, readImpl = readFileSync) {
  try {
    const value = Number(readImpl(SYS_NET + '/' + String(name) + '/speed', 'utf8').toString().trim())
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** 网卡驱动名（虚拟网卡没有 device 链接）。 */
export function readLinkDriver(name, realpathImpl = realpathSync) {
  try {
    const target = realpathImpl(String(SYS_NET + '/' + String(name) + '/device/driver'))
    return String(target).split('/').filter(Boolean).pop() || ''
  } catch {
    return ''
  }
}

/* ───────────────────────── WireGuard ───────────────────────── */

/** `wg show <if> dump`：第一行是接口本身，之后每行一个对端。 */
export function parseWgDump(text) {
  const lines = String(text ?? '').split('\n').filter(line => line.trim())
  const peers = []
  for (const line of lines.slice(1)) {
    const parts = line.split('\t')
    if (parts.length < 8) continue
    peers.push({
      publicKey: parts[0],
      presharedKey: parts[1] === '(none)' ? '' : parts[1],
      endpoint: parts[2] === '(none)' ? '' : parts[2],
      allowedIps: parts[3] ? parts[3].split(',').map(part => part.trim()).filter(Boolean) : [],
      latestHandshake: Number(parts[4]) || 0,
      rxBytes: Number(parts[5]) || 0,
      txBytes: Number(parts[6]) || 0,
      persistentKeepalive: Number(parts[7]) || 0,
    })
  }
  return peers
}

/**
 * 读 WireGuard 对端。nmcli 1.42 不导出 wireguard.peers（改得了、读不出），
 * 所以真数据只能从 wg 自己拿；这需要 root。
 */
export async function readWireguardPeers(ifname, options = {}) {
  const exec = options.exec ?? execFileAsync
  const name = String(ifname ?? '').trim()
  if (!name) return { ok: false, reason: '没有接口名。', peers: [] }
  const result = await exec('sudo', ['-n', 'wg', 'show', name, 'dump'], { timeoutMs: 8000 })
  if (!result || result.missing) return { ok: false, reason: '这台机没有 wg。', peers: [] }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || '').trim().split('\n').slice(-2).join('\n') || 'wg show 失败',
      peers: [],
    }
  }
  return { ok: true, peers: parseWgDump(result.stdout) }
}

