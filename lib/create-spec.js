/**
 * 创建容器的参数归一化 —— 面板与 AI 工具共用这一份。
 *
 * 为什么单独一个文件：创建请求来自两个入口（REST 与 tool），如果各写一套校验，
 * 迟早会出现「AI 能建、面板建不了」或者反过来的偏差。这里只做「松散输入 → 严格 spec」，
 * 不碰进程、不碰磁盘，所以能脱离宿主机单测。
 */

import { availableParallelism } from 'node:os'
import { resolve as resolvePath } from 'node:path'

import { ARCHES, DISTROS, RELEASES } from '../helper/net-config.mjs'
import {
  CmError, ERR, assertContainerName, assertImage, assertIpv4, assertIpv6, assertMac,
  assertNetworkName, randomLxcMac,
} from './util.js'

export const RESTART_POLICIES = ['no', 'on-failure', 'always', 'unless-stopped']
export const UTS_MODES = ['host', 'private']
export const LXC_ARCHES = [...ARCHES]

/**
 * 面板输入框的候选（不是白名单 —— 白名单是 DISTROS/RELEASES 两个正则）。
 * 版本会过期，所以面板同时允许手填，候选只负责省事。
 */
export const LXC_TEMPLATE_SUGGESTIONS = [
  { distro: 'debian', releases: ['bookworm', 'trixie'] },
  { distro: 'ubuntu', releases: ['noble', 'jammy'] },
  { distro: 'alpine', releases: ['3.22', '3.21'] },
  { distro: 'archlinux', releases: ['current'] },
  { distro: 'fedora', releases: ['41', '40'] },
  { distro: 'centos', releases: ['9-Stream'] },
  { distro: 'rocky', releases: ['9'] },
  { distro: 'opensuse', releases: ['tumbleweed'] },
]

const MEMORY_RE = /^\d+[bkmgBKMG]?$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const MAX_ENV_VALUE = 4096

function bad(message) {
  return new CmError(ERR.BAD_ARGS, message)
}

function optionalText(value, field, { max = 255 } = {}) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw bad(`${field}必须是字符串。`)
  const text = value.trim()
  if (text.length > max) throw bad(`${field}太长（>${max}）。`)
  return text || undefined
}

function assertHostname(value) {
  const text = optionalText(value, 'hostname', { max: 63 })
  if (text === undefined) return undefined
  if (!HOSTNAME_RE.test(text)) throw bad(`hostname 不合法：${text}（只允许字母数字与 -，且不以 - 开头结尾）。`)
  return text
}

function assertRestart(value) {
  const text = optionalText(value, '重启策略', { max: 32 })
  if (text === undefined) return undefined
  if (!RESTART_POLICIES.includes(text)) throw bad(`重启策略只支持 ${RESTART_POLICIES.join(' / ')}，收到 ${text}。`)
  return text
}

function assertMemory(value, label = '内存上限') {
  const text = optionalText(value, label, { max: 32 })
  if (text === undefined) return undefined
  if (!MEMORY_RE.test(text)) throw bad(`${label}写 256m / 1g / 268435456 这种，收到 ${text}。`)
  return text.toLowerCase()
}

/** CPU 核心数：正整数。宿主核数的上限由 helper 再校验一次（它才知道真实核数）。 */
function assertCores(value) {
  const text = optionalText(value, 'CPU 核心数', { max: 4 })
  if (text === undefined) return undefined
  if (!/^\d+$/.test(text) || Number(text) < 1) throw bad(`CPU 核心数写 1 以上的整数，收到 ${text}。`)
  return text
}

/** 磁盘大小：8G / 512M 这种，落盘时给 lxc-create --fssize 用。 */
function assertDiskSize(raw, label = '磁盘大小') {
  const text = optionalText(raw, label, { max: 16 })
  if (text === undefined) return undefined
  const match = /^(\d+)\s*([MG])$/i.exec(text)
  if (!match) throw bad(`${label}写 8G / 512M 这种，收到 ${text}。`)
  const amount = Number(match[1])
  const unit = match[2].toUpperCase()
  const megabytes = unit === 'G' ? amount * 1024 : amount
  if (megabytes < 256) throw bad(`${label}太小：${text}（最小 256M）。`)
  if (megabytes > 4 * 1024 * 1024) throw bad(`${label}太大：${text}（上限 4096G）。`)
  return `${amount}${unit}`
}

function assertCpus(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw bad(`CPU 上限必须是正数，收到 ${value}。`)
  const ceiling = Math.max(1, availableParallelism()) * 4
  if (number > ceiling) throw bad(`CPU 上限太大（>${ceiling}），宿主只有 ${availableParallelism()} 个核。`)
  return Math.round(number * 100) / 100
}

function normalizePorts(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw bad('ports 必须是数组。')
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw bad('ports 里每一项都必须是对象。')
    const containerPort = Number(item.containerPort)
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw bad(`端口映射缺 containerPort 或超出 1..65535：${JSON.stringify(item)}`)
    }
    const hostPort = item.hostPort === undefined || item.hostPort === null || item.hostPort === ''
      ? containerPort
      : Number(item.hostPort)
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      throw bad(`hostPort 超出 1..65535：${JSON.stringify(item)}`)
    }
    const protocol = String(item.protocol ?? 'tcp').toLowerCase()
    if (protocol !== 'tcp' && protocol !== 'udp') throw bad(`端口协议只支持 tcp/udp，收到 ${protocol}。`)
    const hostIp = item.hostIp ? assertIpv4(item.hostIp, 'hostIp') : ''
    const key = `${hostIp}/${hostPort}/${protocol}`
    if (seen.has(key)) throw bad(`端口重复：${key}`)
    seen.add(key)
    out.push({ ...(hostIp ? { hostIp } : {}), hostPort, containerPort, protocol })
  }
  return out
}

function normalizeEnv(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('env 必须是键值对象。')
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY_RE.test(key)) throw bad(`环境变量名不合法：${key}`)
    const text = value === null || value === undefined ? '' : String(value)
    if (text.length > MAX_ENV_VALUE) throw bad(`环境变量 ${key} 太长（>${MAX_ENV_VALUE}）。`)
    out[key] = text
  }
  return out
}

function hasTraversal(path) {
  return path.split(/[\\/]+/).some(segment => segment === '..')
}

function normalizeVolumes(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw bad('volumes 必须是数组。')
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw bad('volumes 里每一项都必须是对象。')
    const source = optionalText(item.source, '挂载 source', { max: 512 })
    const destination = optionalText(item.destination, '挂载 destination', { max: 512 })
    if (!source || !destination) throw bad(`挂载需要 source 与 destination：${JSON.stringify(item)}`)
    if (hasTraversal(source) || hasTraversal(destination)) throw bad(`挂载路径里不许有 ..：${source} → ${destination}`)
    if (!destination.startsWith('/')) throw bad(`挂载目标必须是绝对路径：${destination}`)
    if (source.startsWith('/') || source.startsWith('~') || source.startsWith('.')) {
      const expanded = source.startsWith('~') ? source.replace(/^~/, process.env.HOME || '/root') : source
      const absolute = resolvePath(expanded)
      const blocked = ['/', '/home', '/root', '/etc', process.env.DSH_HOME || '/home/icecat/.dsh-next'].filter(Boolean).map(item => resolvePath(item))
      if (blocked.includes(absolute)) throw bad(`禁止挂载宿主敏感根目录：${source}`)
    }
    out.push({ source, destination, ...(item.ro === true ? { ro: true } : {}) })
  }
  return out
}

function normalizeCommand(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? text.split(/\s+/) : []
  }
  if (!Array.isArray(raw)) throw bad('command 必须是字符串数组。')
  return raw.map(item => {
    if (typeof item !== 'string' || !item) throw bad('command 里只能是非空字符串。')
    return item
  })
}

/** Podman：podman run -d 需要的全部参数。 */
export function normalizePodmanCreate(input = {}) {
  const image = assertImage(input.image, '镜像')
  const spec = { image, ports: [], env: {}, volumes: [], command: [] }

  if (input.name !== undefined && input.name !== null && input.name !== '') spec.name = assertContainerName(input.name)
  if (input.network !== undefined && input.network !== null && input.network !== '') spec.network = assertNetworkName(input.network, '网络名')
  spec.ports = normalizePorts(input.ports)
  spec.env = normalizeEnv(input.env)
  spec.volumes = normalizeVolumes(input.volumes)
  spec.command = normalizeCommand(input.command)

  const hostname = assertHostname(input.hostname)
  if (hostname) spec.hostname = hostname
  const uts = optionalText(input.uts, 'UTS 模式', { max: 16 })
  if (uts !== undefined) {
    if (!UTS_MODES.includes(uts)) throw bad(`UTS 只支持 ${UTS_MODES.join(' / ')}，收到 ${uts}。`)
    spec.uts = uts
  }
  const restart = assertRestart(input.restart)
  if (restart) spec.restart = restart
  const memory = assertMemory(input.memory)
  if (memory) spec.memory = memory
  const cpus = assertCpus(input.cpus)
  if (cpus !== undefined) spec.cpus = cpus

  const hostMount = spec.volumes.some(volume => volume.source.startsWith('/') || volume.source.startsWith('~') || volume.source.startsWith('.'))
  if (hostMount || spec.command.length > 0 || spec.uts === 'host') spec.requiresConfirm = true
  return spec
}

/** LXC：lxc-create -t download 需要的参数 + 建完要写的启动项。 */
export function normalizeLxcCreate(input = {}) {
  const name = assertContainerName(input.name)
  const distro = optionalText(input.distro, '发行版', { max: 42 }) ?? 'debian'
  if (!DISTROS.test(distro)) throw bad(`发行版不合法：${distro}（只允许小写字母数字与 . + -）。`)
  const release = optionalText(input.release, '版本', { max: 32 }) ?? 'bookworm'
  if (!RELEASES.test(release)) throw bad(`版本不合法：${release}`)
  const arch = optionalText(input.arch, '架构', { max: 8 }) ?? 'arm64'
  if (!ARCHES.has(arch)) throw bad(`架构只支持 ${[...ARCHES].join(' / ')}，收到 ${arch}。`)

  const spec = { name, distro, release, arch, start: input.start !== false, autostart: input.autostart === true }
  const memoryMax = assertMemory(input.memoryMax ?? input.memory)
  if (memoryMax) spec.memoryMax = memoryMax
  const swapMax = assertMemory(input.swapMax ?? input.swap, 'swap 上限')
  if (swapMax) spec.swapMax = swapMax
  const cores = assertCores(input.cores ?? input.cpus)
  if (cores) spec.cores = cores

  // rootfs 后端：默认 loop（一块 <名字>-0.img），也可以选 dir（rootfs 就是宿主上的一个目录）。
  // 其它后端（btrfs / zfs / lvm）这台机的 helper 还没接 —— 明确拒绝，不悄悄换成 loop。
  const backend = String(input.backend ?? 'loop').trim() || 'loop'
  if (!['loop', 'dir'].includes(backend)) {
    throw bad(`rootfs 后端只支持 loop 或 dir，收到 ${backend}。` +
      '（btrfs / zfs / lvm 的 helper 还没实现，选了也建不出来，所以直接说。）')
  }
  spec.backend = backend
  // loop 才谈得上磁盘大小；dir 后端长在宿主文件系统上，这个数字没意义，别留着误导人。
  const diskSize = assertDiskSize(input.diskSize, '磁盘大小') ?? '8G'
  if (backend === 'loop') spec.diskSize = diskSize

  // 额外数据盘：<名字>-1.img、-2.img…，每块 { size, mount }。
  const rawDisks = input.dataDisks
  if (rawDisks !== undefined && rawDisks !== null) {
    if (!Array.isArray(rawDisks)) throw bad('dataDisks 要是数组。')
    if (rawDisks.length > 7) throw bad(`数据盘最多 7 块（一块 rootfs 加 7 块数据盘就是内核的 8 个 loop 设备上限）。`)
    spec.dataDisks = rawDisks.map((entry, index) => {
      const item = entry ?? {}
      const size = assertDiskSize(item.size, `第 ${index + 1} 块数据盘大小`) ?? '8G'
      const mount = optionalText(item.mount, `第 ${index + 1} 块数据盘挂载点`, { max: 120 })
      if (!mount) throw bad(`第 ${index + 1} 块数据盘要给挂载点（容器内的相对路径，例如 data 或 mnt/disk1）。`)
      const clean = String(mount).replace(/^\/+|\/+$/g, '')
      if (!clean || clean.includes('..')) throw bad(`第 ${index + 1} 块数据盘挂载点不能是绝对路径或带 ..：${mount}`)
      return { size, mount: clean }
    })
  }

  const raw = input.network
  if (raw === undefined || raw === null || raw === 'none' || raw === '') {
    spec.network = null
  } else if (typeof raw === 'string') {
    // 面板上「接 lxcbr0」最省事的写法：直接给网桥名。
    spec.network = { type: 'veth', link: String(raw) }
  } else if (typeof raw === 'object') {
    const type = String(raw.type ?? 'veth')
    if (type !== 'veth') throw bad('创建时只支持 veth 网卡（macvlan 可以建好后再改）。')
    const link = optionalText(raw.link, '网桥名', { max: 15 })
    if (!link) throw bad('veth 网卡要给网桥名（例如 lxcbr0）。')
    const network = { type: 'veth', link }
    const mode = String(raw.ipv4?.mode ?? 'dhcp')
    if (mode === 'static') {
      const address = optionalText(raw.ipv4?.address, 'IPv4 地址', { max: 80 })
      if (!address) throw bad('静态地址要给 ipv4.address（形如 10.0.3.200/24）。')
      if (!address.includes('/')) throw bad(`静态地址要带前缀长度：${address}`)
      network.ipv4 = { address }
      const gateway = optionalText(raw.ipv4?.gateway, 'IPv4 网关', { max: 64 })
      if (gateway) network.ipv4.gateway = assertIpv4(gateway, 'IPv4 网关')
    } else if (mode !== 'dhcp') {
      throw bad(`IPv4 模式只支持 dhcp / static，收到 ${mode}。`)
    }
    // IPv6：off / dhcp 都不写进 network —— 这两种靠容器里的客户端和宿主 RA，
    // LXC 侧没有对应的静态项；只有 static 才落 lxc.net.0.ipv6.*。
    const mode6 = String(raw.ipv6?.mode ?? 'off')
    if (mode6 === 'static') {
      const address6 = optionalText(raw.ipv6?.address, 'IPv6 地址', { max: 80 })
      if (!address6) throw bad('静态 IPv6 要给 ipv6.address（形如 2408:8207::5/64）。')
      if (!address6.includes('/')) throw bad(`静态 IPv6 地址要带前缀长度：${address6}`)
      network.ipv6 = { address: address6 }
      const gateway6 = optionalText(raw.ipv6?.gateway, 'IPv6 网关', { max: 64 })
      if (gateway6) network.ipv6.gateway = assertIpv6(gateway6, 'IPv6 网关')
    } else if (mode6 !== 'off' && mode6 !== 'dhcp') {
      throw bad(`IPv6 模式只支持 off / dhcp / static，收到 ${mode6}。`)
    }
    // MAC 一律写死：不填就生成一个。留空让内核随机的话每次启动 MAC 都可能变，
    // 桥接场景下 DHCP 保留地址、按 MAC 做的防火墙规则都会失效。
    const hwaddr = optionalText(raw.hwaddr, 'MAC 地址', { max: 17 })
    network.hwaddr = hwaddr ? assertMac(hwaddr, 'MAC 地址') : randomLxcMac()
    // 这个 MAC 是插件随手给的，还是人定的？撞车时 helper 靠它决定
    // 「自动换一个」还是「拦住报错」。没表态（含上面刚生成的那种）一律按自动算。
    network.hwaddrAuto = raw.hwaddrAuto !== false
    spec.network = network
  } else {
    throw bad('network 只能是 null / 网桥名 / 网卡对象。')
  }

  return spec
}

/** 按节点类型分派；调用方只需要知道 node.kind。 */
export function normalizeCreate(kind, input = {}) {
  if (kind === 'podman') return normalizePodmanCreate(input)
  if (kind === 'lxc') return normalizeLxcCreate(input)
  throw bad(`不支持创建容器到这个节点类型：${kind}`)
}
