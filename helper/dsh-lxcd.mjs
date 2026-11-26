#!/usr/bin/env node
/**
 * dsh-lxcd —— DSH 容器台的 LXC root helper
 *
 * DSH 主进程是 CapEff=0 + NoNewPrivs=1，lxc 全是 root 的活。所以这里单开一个
 * root 小服务，只做白名单里的事，通过 unix socket 回答：
 *
 *   GET  /health
 *   POST /lxc/list  /lxc/info  /lxc/logs  /lxc/action  /lxc/create
 *   POST /lxc/net/get  /lxc/net/set
 *   POST /net/list  /net/host  /net/bridge  /net/module
 *
 * 规矩：
 *   - 只用 execFile + 参数数组，从不拼 shell。
 *   - 参数白名单 + 类型/正则校验；容器名、IP/CIDR、接口名、模块名都卡死。
 *   - 改配置先备份，再原子写。
 *   - 每次写操作进 /var/log/dsh-container-manager/audit.jsonl。
 *
 * 这个文件由 helper/install-helper.sh 装到 /usr/local/lib/dsh-container-manager/。
 */

import { execFile, spawn } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  writeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { isIPv4, isIPv6 } from 'node:net'

import {
  ARCHES,
  DISTROS,
  HelperError,
  LXC_SETTINGS,
  NAME_RE,
  RELEASES,
  assertCidr,
  assertIfname,
  assertIp,
  assertName,
  normalizeNic,
  parseConfigNet,
  readLxcSettings,
  replaceNetSection,
  writeLxcSettings,
} from './net-config.mjs'
import { basename, dirname, join } from 'node:path'

import { buildDiagnoseScript, parseDiagnoseOutput, readDiagnose } from './diagnose.mjs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SOCKET = process.env.LXCD_SOCKET || '/run/dsh-container-manager/lxcd.sock'
const LXC_ROOT = process.env.LXCD_LXC_ROOT || '/var/lib/lxc'
// 容器磁盘（虚拟磁盘镜像）落在工作目录下，每个容器一个子目录：<名字>-0.img 是 rootfs。
const DISK_ROOT = process.env.LXCD_DISK_ROOT || '/opt/dsh-container/lxc'
// dsh 自己管着 LXC 的系统镜像缓存，不跟 /var/cache/lxc 混。
// 注意 lxc-download 模板会自己再拼一层 /download/<distro>/<release>/<arch>/<variant>。
const IMAGE_ROOT = process.env.LXCD_IMAGE_ROOT || '/opt/dsh-container/lxc/image'
const IMAGE_DOWNLOAD = join(IMAGE_ROOT, 'download')
// 把数据盘 loop 挂进容器用的 hook（install-helper.sh 装到这里）。
const DATA_HOOK = process.env.LXCD_DATA_HOOK || '/usr/local/lib/dsh-container-manager/hook-datadisk'
// 内核 loop 设备默认 8 个，一块 rootfs 加若干数据盘都算在内。
const MAX_LOOP_DISKS = 8
const AUDIT_FILE = process.env.LXCD_AUDIT || '/var/log/dsh-container-manager/audit.jsonl'
// systemd 启动时没有 SUDO_USER，所以正常路径是 unit 里写死的 LXCD_GROUP；
// 手工跑的时候退回到调用 sudo 的那个用户。
const SOCKET_GROUP = process.env.LXCD_GROUP || process.env.SUDO_USER || process.env.USER || 'root'
// 请求体上限：普通配置都是几 KB，但容器内文件写入整份走 base64，
// 8MB 的文件编码后约 10.7MB —— 所以给到 16MB。套接字是 0660/root 组，不是对外的口子。
const MAX_BODY = 16 * 1024 * 1024
const HELPER_PROTOCOL = 2

const MODULE_ALLOW = new Set(['macvlan', 'ipvlan', 'veth', 'bridge', '8021q', 'br_netfilter'])
const ACTION_ALLOW = new Set(['start', 'stop', 'restart', 'freeze', 'unfreeze', 'destroy'])
// DISTROS / RELEASES / ARCHES 现在从 net-config.mjs 导入，与插件侧共用同一份规则。

/* ───────────────────────── 小工具 ───────────────────────── */

function audit(entry) {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true, mode: 0o700 })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    const fd = readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    fd.push(line.trimEnd())
    const kept = fd.slice(-2000)
    const temporary = AUDIT_FILE + '.tmp'
    writeFileSync(temporary, kept.join('\n') + '\n', { mode: 0o600 })
    renameSync(temporary, AUDIT_FILE)
  } catch {
    // 审计写不进去不能让操作失败
  }
}

const activeRuns = new Map()

async function run(command, args, { timeoutMs = 60_000, env, maxBuffer = 8 * 1024 * 1024, cancelKey = null } = {}) {
  // env 是「在这条命令上追加的环境变量」，比如给 lxc-create 指定 LXC_CACHE_PATH。
  const options = { timeout: timeoutMs, maxBuffer }
  if (env) options.env = { ...process.env, ...env }
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      if (cancelKey) activeRuns.delete(cancelKey)
      resolve(value)
    }
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      done({
        code: error && typeof error.code === 'number' ? error.code : error ? null : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
        missing: error?.code === 'ENOENT',
        timedOut: Boolean(error && (error.killed || error.signal === 'SIGTERM' || error.signal === 'SIGKILL')),
      })
    })
    if (cancelKey) activeRuns.set(cancelKey, child)
    child.on('error', error => {
      done({ code: error?.code === 'ENOENT' ? null : (typeof error?.code === 'number' ? error.code : null), stdout: '', stderr: error?.message ?? String(error), missing: error?.code === 'ENOENT', timedOut: false })
    })
  })
}

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

function containerConfigPath(name) {
  return join(LXC_ROOT, name, 'config')
}

function containerExists(name) {
  try {
    return statSync(containerConfigPath(name)).isFile()
  } catch {
    return false
  }
}

/* ───────────────────────── LXC 读 ───────────────────────── */

function readConfig(name) {
  return readFileSync(containerConfigPath(name), 'utf8')
}

function lxcState(name) {
  // lxc-info -n NAME -s -H：STOPPED / RUNNING / FROZEN / STARTING / STOPPING
  return run('lxc-info', ['-n', name, '-s', '-H'], { timeoutMs: 15_000 })
}

async function containerState(name) {
  const result = await lxcState(name)
  if (result.code !== 0) {
    if (/not found|not exist/i.test(result.stderr)) return 'missing'
    return 'unknown'
  }
  const value = result.stdout.trim().split('\n')[0].trim().toLowerCase()
  if (value.startsWith('running')) return 'running'
  if (value.startsWith('stopped')) return 'stopped'
  if (value.startsWith('frozen')) return 'frozen'
  if (value.startsWith('starting')) return 'starting'
  if (value.startsWith('stopping')) return 'stopping'
  return value || 'unknown'
}

async function containerIps(name) {
  const result = await run('lxc-info', ['-n', name, '-i', '-H'], { timeoutMs: 15_000 })
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line !== '-' && (isIPv4(line) || isIPv6(line)))
}

function readTemplate(name) {
  // /var/lib/lxc/<name>/config 里没有 distro 记录时，从 rootfs 或 lxc-create 日志猜。
  const metaFile = join(LXC_ROOT, name, '.dsh-cm-template')
  try {
    return readFileSync(metaFile, 'utf8').trim() || null
  } catch {
    return null
  }
}

async function listContainers() {
  let names = []
  try {
    names = readdirSync(LXC_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && NAME_RE.test(entry.name))
      .map(entry => entry.name)
  } catch (error) {
    // 以前这里是「静默返回空列表」，于是漏 import 之类的问题会表现成「有容器但列表是空」。
    // 宁可报错，也不要假装没有容器。
    throw new HelperError(
      'LXC_ERROR',
      `读不了 ${LXC_ROOT}：${error?.message ?? String(error)}`,
      '确认 helper 以 root 运行、/var/lib/lxc 存在且可读。',
    )
  }
  const out = []
  for (const name of names) {
    if (!containerExists(name)) continue
    const state = await containerState(name)
    const ips = state === 'running' ? await containerIps(name) : []
    out.push({
      name,
      state,
      ips,
      template: readTemplate(name),
      autostart: readAutostart(name),
      created: null,
      createdText: '',
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function readAutostart(name) {
  try {
    const text = readConfig(name)
    const match = /^lxc\.start\.auto\s*=\s*(\d+)/m.exec(text)
    return match ? Number(match[1]) > 0 : false
  } catch {
    return false
  }
}

async function containerInfo(name) {
  if (!containerExists(name)) throw new HelperError('NOT_FOUND', `没有这个容器：${name}`)
  const state = await containerState(name)
  const config = readConfig(name)
  const nics = parseConfigNet(config)
  const detail = await run('lxc-info', ['-n', name], { timeoutMs: 20_000 })
  let pid = null
  let memory = null
  for (const line of detail.stdout.split('\n')) {
    const pidMatch = /^PID:\s*(\d+)/.exec(line.trim())
    if (pidMatch) pid = Number(pidMatch[1])
    const memoryMatch = /^Memory use:\s*(.+)$/.exec(line.trim())
    if (memoryMatch) memory = memoryMatch[1].trim()
  }
  return {
    name,
    state,
    pid,
    memory,
    ips: state === 'running' ? await containerIps(name) : [],
    nics,
    template: readTemplate(name),
    autostart: readAutostart(name),
    resources: readCgroupResources(name),
    configPath: containerConfigPath(name),
    created: null,
  }
}

async function containerLogs(name, lines, since) {
  const count = Math.max(1, Math.min(2000, Number(lines) || 100))
  const args = ['-u', `lxc@${name}`, '-n', String(count), '--no-pager', '-o', 'short-iso']
  if (since) args.push('--since', String(since).slice(0, 64))
  // 先试 journal，再退到 /var/log/lxc/<name>.log
  const journal = await run('journalctl', args, { timeoutMs: 20_000 })
  if (journal.code === 0 && journal.stdout.trim()) {
    return { text: journal.stdout.slice(-1_000_000), source: 'journal' }
  }
  const logFile = `/var/log/lxc/${name}.log`
  try {
    const text = readFileSync(logFile, 'utf8').split('\n').slice(-count).join('\n')
    return { text, source: 'file' }
  } catch {
    return { text: `（${name} 没有可读日志：journal 里没有 lxc@${name}，${logFile} 也不存在）`, source: 'none' }
  }
}

/* ───────────────────────── LXC 写 ───────────────────────── */

const MAC_LINE_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/

/**
   * 同一个 L2 域里 MAC 必须唯一。撞了的话：桥接场景下两个容器互相顶掉，
   * 按 MAC 做 DHCP 保留、防火墙规则也会误伤。所以写之前先查一遍。
   *
   * 能查到两处来源：宿主自己的网卡（/sys/class/net）和其它容器 config 里写死的 hwaddr。
   * 其它容器已经跑起来但 config 里没写 hwaddr 的，它们的 MAC 是内核随机生成的，查不到 ——
   * 那种情况只能靠「我们自己创建的容器一律写死 MAC」来保证不再发生。
   */
  function macOwners(self) {
    const owners = new Map()
    try {
      for (const ifname of readdirSync('/sys/class/net')) {
        let mac = ''
        try { mac = readFileSync(`/sys/class/net/${ifname}/address`, 'utf8').trim().toLowerCase() } catch { continue }
        if (MAC_LINE_RE.test(mac) && mac !== '00:00:00:00:00:00') owners.set(mac, `宿主网卡 ${ifname}`)
      }
    } catch { /* 读不到就不做这项检查，不该因此挡住创建 */ }
    let names = []
    try { names = readdirSync(LXC_ROOT, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name) } catch { names = [] }
    for (const other of names) {
      if (other === self) continue
      const config = join(LXC_ROOT, other, 'config')
      if (!existsSync(config)) continue
      let parsed = []
      try { parsed = parseConfigNet(readFileSync(config, 'utf8')) } catch { continue }
      for (const nic of parsed) {
        const mac = String(nic.hwaddr ?? '').trim().toLowerCase()
        if (mac) owners.set(mac, `容器 ${other}`)
      }
    }
    return owners
  }

  /** 这个 MAC 现在归谁；没人用就返回 null。self 是正在改的容器，它自己写过的值不算冲突。 */
  function macOwner(mac, self, owners) {
    const value = String(mac ?? '').trim().toLowerCase()
    if (!value) return null
    const table = owners || macOwners(self)
    return table.get(value) || null
  }

  /** 跟 lib/util.js 的 randomLxcMac 同款：LXC / Xen 传统分给虚拟网卡的 OUI。 */
  function randomMac() {
    const bytes = []
    for (const one of randomBytes(3)) bytes.push(one.toString(16).padStart(2, '0'))
    return `00:16:3e:${bytes.join(':')}`
  }

  /**
   * 把撞车的 MAC 处理掉，返回被换过的记录。
   *
   * 分两种：插件随手给的（hwaddrAuto）撞了就自己换一个，最多试 8 次；
   * 人手填的撞了要拦住 —— 有人就是要某个 MAC 去对 DHCP 保留，悄悄换掉比报错更糟。
   */
  function settleMacs(nics, self) {
    const owners = macOwners(self)
    const swaps = []
    for (const nic of nics) {
      if (!nic.hwaddr) continue
      const owner = macOwner(nic.hwaddr, self, owners)
      if (!owner) {
        owners.set(nic.hwaddr, `容器 ${self}`)
        continue
      }
      if (!nic.hwaddrAuto) {
        throw new HelperError('BAD_ARGS', `MAC ${nic.hwaddr} 已经被 ${owner} 占用。想让它自己避让，点旁边的「随机」。`)
      }
      const from = nic.hwaddr
      let clash = owner
      let hit = null
      for (let attempt = 0; attempt < 8 && clash; attempt += 1) {
        const candidate = randomMac()
        if (owners.has(candidate)) continue
        hit = candidate
        clash = null
      }
      if (clash || !hit) {
        throw new HelperError('BAD_ARGS', `连试 8 次都撞车（${from} 已归 ${owner}），这个概率不正常，请手动指定一个 MAC。`)
      }
      nic.hwaddr = hit
      owners.set(hit, `容器 ${self}`)
      swaps.push({ from, to: hit, owner })
    }
    return swaps
  }

  async function setNetwork(name, rawNics, restart) {
    const container = assertName(name)
    if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
    if (!Array.isArray(rawNics) || rawNics.length === 0) throw new HelperError('BAD_ARGS', '至少要留一块网卡。')
    if (rawNics.length > 8) throw new HelperError('BAD_ARGS', '最多 8 块网卡。')
    const nics = rawNics.map(normalizeNic)
    const swaps = settleMacs(nics, container)
    const path = containerConfigPath(container)
    const before = readConfig(container)
    const after = replaceNetSection(before, nics)
    const backup = `${path}.cm-bak-${Date.now()}`
    writeFileSync(backup, before, { mode: 0o600 })
    const temporary = path + '.tmp'
    writeFileSync(temporary, after, { mode: 0o644 })
    renameSync(temporary, path)
    audit({ action: 'lxc.net.set', target: container, nics: nics.length, restart, backup })

    let restarted = false
    if (restart) {
    const state = await containerState(container)
    if (state === 'running' || state === 'frozen') {
      const stopped = await run('lxc-stop', ['-n', container, '-t', '10'], { timeoutMs: 30_000 })
      if (stopped.code !== 0) {
        writeFileSync(path, before, { mode: 0o644 })
        throw new HelperError('LXC_ERROR', `停容器失败，已恢复旧网络配置：${stopped.stderr.trim() || stopped.stdout.trim()}`, `备份在 ${backup}`)
      }
      const started = await run('lxc-start', ['-n', container, '-d'], { timeoutMs: 60_000 })
      if (started.code !== 0) {
        writeFileSync(path, before, { mode: 0o644 })
        const recovered = await run('lxc-start', ['-n', container, '-d'], { timeoutMs: 60_000 })
        throw new HelperError('LXC_ERROR', `新网络启动失败，已恢复旧配置${recovered.code === 0 ? '并重新启动容器' : '，但旧配置启动也失败'}：${started.stderr.trim() || started.stdout.trim()}`, `用 lxc-start -n ${container} -F 看前台日志；备份在 ${backup}`)
      }
      restarted = true
    }
  }
  return {
    name: container,
    nics: parseConfigNet(after),
    restarted,
    backup,
    // 自动避让换掉的 MAC；前端拿它提示一句「撞了，已经换成这个」。
    swaps,
  }
}

async function action(name, verb) {
  const container = assertName(name)
  if (!ACTION_ALLOW.has(verb)) throw new HelperError('BAD_ARGS', `不支持的动作：${verb}`)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const args = verb === 'restart'
    ? ['-n', container]
    : verb === 'destroy'
      ? ['-n', container, '-f']
      : ['-n', container]
  const command = verb === 'restart' ? 'lxc-stop' : `lxc-${verb}`
  if (verb === 'restart') {
    const stopped = await run('lxc-stop', ['-n', container, '-t', '10'], { timeoutMs: 40_000 })
    if (stopped.code !== 0) throw new HelperError('LXC_ERROR', stopped.stderr.trim() || `停容器失败（退出码 ${stopped.code}）`)
    const started = await run('lxc-start', ['-n', container, '-d'], { timeoutMs: 60_000 })
    if (started.code !== 0) throw new HelperError('LXC_ERROR', started.stderr.trim() || `启动失败（退出码 ${started.code}）`)
  } else {
    const result = await run(command, args, { timeoutMs: verb === 'destroy' ? 120_000 : 60_000 })
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `${command} 退出码 ${result.code}`
      // lxc-destroy 拒绝删「有快照的容器」。这不是 bug，是 LXC 的保护，
      // 所以给一条能直接照做的下一步，而不是让人对着 has snapshots 发愣。
      const hint = verb === 'destroy' && /has snapshots/i.test(detail)
        ? '这个容器还有快照。先去「快照」页把快照删掉，再回来删容器。'
        : undefined
      throw new HelperError('LXC_ERROR', detail, hint)
    }
  }
  // 容器元数据目录删了，工作目录里的虚拟磁盘也跟着删，不然盘会一直留着占地方。
  if (verb === 'destroy') {
    try {
      rmSync(join(DISK_ROOT, container), { recursive: true, force: true })
    } catch (error) {
      audit({ action: 'lxc.destroy.disk-cleanup-failed', target: container, error: error?.message })
    }
  }
  audit({ action: `lxc.${verb}`, target: container })
  return { name: container, action: verb, state: await containerState(container) }
}

/** 把 256m / 1g / 268435456 统一成字节数；空串返回 null（表示不限）。 */
function parseBytes(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const match = /^(\d+)\s*([bkmgBKMG]?)$/.exec(text)
  if (!match) throw new HelperError('BAD_ARGS', `内存上限不合法：${text}（写 256m / 1g / 268435456 这种）`)
  const units = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
  return Number(match[1]) * units[match[2].toLowerCase()]
}

/** 宿主 CPU 核数（不依赖 node:os，读 /proc 更直观）。 */
function hostCpuCount() {
  try {
    return readFileSync('/proc/cpuinfo', 'utf8').split('\n').filter(line => /^processor\s*:/.test(line)).length || 1
  } catch {
    return 1
  }
}

/** 1..宿主核数 → cpuset 写法（0-3）；空值返回 '' 表示不绑核。 */
function parseCores(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const count = Number(text)
  const max = hostCpuCount()
  if (!Number.isInteger(count) || count < 1) {
    throw new HelperError('BAD_ARGS', `CPU 核心数不合法：${text}（写 1 以上的整数）`)
  }
  if (count > max) {
    throw new HelperError('BAD_ARGS', `CPU 核心数不能超过宿主的 ${max} 核（这台是 ${max} 核）`)
  }
  return count === 1 ? '0' : `0-${count - 1}`
}

/** 从 cgroup 读回真实生效值；容器没在跑就返回 null。 */
/**
 * 一次 cgroup 采样：CPU 累计微秒、内存、pids。
 * 返回 null 表示这个容器的 cgroup 不在（没在跑）。
 */
function sampleUsage(name) {
  const base = `/sys/fs/cgroup/lxc.payload.${name}`
  if (!existsSync(base)) return null
  const read = file => {
    try {
      return readFileSync(join(base, file), 'utf8').trim()
    } catch {
      return ''
    }
  }
  let cpuUsec = 0
  for (const line of read('cpu.stat').split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (key === 'usage_usec') cpuUsec = Number(value) || 0
  }
  const memMaxRaw = read('memory.max')
  return {
    cpuUsec,
    memUsed: Number(read('memory.current')) || 0,
    memLimit: memMaxRaw === 'max' ? 0 : (Number(memMaxRaw) || 0),
    pids: Number(read('pids.current')) || 0,
  }
}

/** 累计 CPU 时间的可读写法，观感对齐 podman 那边的 CPU time。 */
function formatCpuTime(usec) {
  const total = Math.max(0, Number(usec) || 0) / 1e6
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${minutes}m${seconds.toFixed(0)}s`
  if (minutes > 0) return `${minutes}m${seconds.toFixed(1)}s`
  return `${seconds.toFixed(1)}s`
}

/** 宿主总内存：容器没设上限时拿它当分母算占比（和 podman 的口径一致）。 */
function hostMemoryTotal() {
  try {
    const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    return match ? Number(match[1]) * 1024 : 0
  } catch {
    return 0
  }
}

/**
 * 所有运行中 LXC 容器的实时占用。
 * CPU 百分比没法从 cgroup 一次读出来，只能采两次求差 —— 220ms 的窗口够稳，
 * 也不至于把 /stats 拖成慢接口。
 */
/** 递归量一个目录占多少字节；读不到就当 0，别因为一个坏链接炸整页。 */
function dirBytes(dir) {
  let total = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(full)
      else total += statSync(full).size
    } catch {
      // 读不到就跳过，统计差一点点比整页挂掉强
    }
  }
  return total
}

function humanBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + 'G'
  if (value >= 1024 ** 2) return Math.round(value / 1024 ** 2) + 'M'
  if (value >= 1024) return Math.round(value / 1024) + 'K'
  return String(value) + 'B'
}

/** 某个路径所在分区的容量，用来看还剩多少。 */
function diskUsage(path) {
  try {
    const stat = statfsSync(path)
    const total = stat.blocks * stat.bsize
    const free = stat.bavail * stat.bsize
    return { total, free, used: total - free, percent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0 }
  } catch {
    return null
  }
}

/**
 * 扫 LXC 的系统镜像缓存。
 * 结构是模板自己定的：<IMAGE_ROOT>/download/<distro>/<release>/<arch>/<variant>/rootfs.tar.xz
 * 没有 rootfs.tar.xz 的目录是下了一半的残骸，不算数。
 */
function scanImageCache() {
  const images = []
  if (!existsSync(IMAGE_DOWNLOAD)) return images
  const subdirs = dir => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return []
    }
  }
  for (const distro of subdirs(IMAGE_DOWNLOAD)) {
    for (const release of subdirs(join(IMAGE_DOWNLOAD, distro))) {
      for (const arch of subdirs(join(IMAGE_DOWNLOAD, distro, release))) {
        for (const variant of subdirs(join(IMAGE_DOWNLOAD, distro, release, arch))) {
          const variantDir = join(IMAGE_DOWNLOAD, distro, release, arch, variant)
          const rootfs = join(variantDir, 'rootfs.tar.xz')
          if (!existsSync(rootfs)) continue
          let bytes = 0
          let mtime = null
          try {
            const stat = statSync(rootfs)
            bytes = stat.size
            mtime = stat.mtime.toISOString()
          } catch {
            continue
          }
          let expiry = null
          try {
            const raw = readFileSync(join(variantDir, 'expiry'), 'utf8').trim()
            if (/^\d+$/.test(raw)) expiry = Number(raw)
          } catch {
            // 没有 expiry 就当永不过期
          }
          images.push({
            distro, release, arch, variant,
            // default 是默认 variant，展示时不带它，跟 lxc-image 列表的口径一致
            name: variant === 'default' ? `${distro}/${release}/${arch}` : `${distro}/${release}/${arch}/${variant}`,
            path: variantDir,
            rootfs: 'rootfs.tar.xz',
            bytes,
            size: humanBytes(bytes),
            mtime,
            expiry,
            expired: expiry !== null ? expiry * 1000 < Date.now() : false,
          })
        }
      }
    }
  }
  images.sort((left, right) => left.name.localeCompare(right.name))
  return images
}

async function listImageCache() {
  mkdirSync(IMAGE_DOWNLOAD, { recursive: true, mode: 0o755 })
  const images = scanImageCache()
  return {
    images,
    count: images.length,
    total: images.reduce((sum, item) => sum + (item.bytes || 0), 0),
    root: IMAGE_ROOT,
    download: IMAGE_DOWNLOAD,
  }
}

/** 删一条缓存。只认扫出来的那几条，外面传进来的路径一律不信。 */
async function deleteImageCache(target) {
  const wanted = String(target ?? '').trim()
  if (!wanted) throw new HelperError('BAD_ARGS', '需要镜像名，例如 debian/trixie/arm64。')
  const hit = scanImageCache().find(item => item.name === wanted || item.path === wanted)
  if (!hit) throw new HelperError('NOT_FOUND', `缓存里没有这个镜像：${wanted}`)
  const freed = dirBytes(hit.path)
  rmSync(hit.path, { recursive: true, force: true })
  // 顺手把空掉的上级目录收掉，免得面板里留一串空壳
  for (const dir of [
    join(IMAGE_DOWNLOAD, hit.distro, hit.release, hit.arch),
    join(IMAGE_DOWNLOAD, hit.distro, hit.release),
    join(IMAGE_DOWNLOAD, hit.distro),
  ]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {
      // 收不掉也无所谓
    }
  }
  audit({ action: 'lxc.image.delete', target: hit.name, freed })
  return { name: hit.name, freed, size: humanBytes(freed), images: scanImageCache().length }
}

/** 存储总览：每个容器占的虚拟磁盘 + 镜像缓存 + 分区余量。 */
async function storageInfo() {
  const containers = []
  let names = []
  try {
    names = readdirSync(DISK_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'image')
      .map(entry => entry.name)
  } catch {
    names = []
  }
  for (const name of names) {
    const dir = join(DISK_ROOT, name)
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const disks = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.img')) continue
      let bytes = 0
      try {
        bytes = statSync(join(dir, entry.name)).size
      } catch {
        continue
      }
      disks.push({ file: entry.name, bytes, size: humanBytes(bytes) })
    }
    if (disks.length === 0) continue
    const bytes = disks.reduce((sum, item) => sum + item.bytes, 0)
    containers.push({ name, disks, bytes, size: humanBytes(bytes) })
  }
  containers.sort((left, right) => left.name.localeCompare(right.name))
  const images = scanImageCache()
  return {
    root: DISK_ROOT,
    imageRoot: IMAGE_ROOT,
    images: {
      count: images.length,
      bytes: images.reduce((sum, item) => sum + (item.bytes || 0), 0),
      size: humanBytes(images.reduce((sum, item) => sum + (item.bytes || 0), 0)),
    },
    containers,
    containersTotal: containers.reduce((sum, item) => sum + item.bytes, 0),
    disk: diskUsage(DISK_ROOT),
  }
}

async function statsAll() {
  let entries = []
  try {
    entries = readdirSync('/sys/fs/cgroup', { withFileTypes: true })
  } catch {
    return []
  }
  const prefix = 'lxc.payload.'
  const names = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => entry.name.slice(prefix.length))
    .filter(name => NAME_RE.test(name))
    .sort()
  if (names.length === 0) return []

  const first = names.map(sampleUsage)
  const spanMs = 220
  await new Promise(resolve => setTimeout(resolve, spanMs))
  const second = names.map(sampleUsage)

  const hostTotal = hostMemoryTotal()
  const rows = []
  for (let index = 0; index < names.length; index += 1) {
    const before = first[index]
    const after = second[index]
    if (!after) continue
    const baseUsec = before ? before.cpuUsec : after.cpuUsec
    const deltaUsec = Math.max(0, after.cpuUsec - baseUsec)
    // 100% 等于占满一个核，和 podman 的口径一致
    const cpuPercent = Math.round((deltaUsec / (spanMs * 1000)) * 100 * 100) / 100
    const memLimit = after.memLimit > 0 ? after.memLimit : hostTotal
    rows.push({
      id: '',
      name: names[index],
      cpuPercent,
      cpuTime: formatCpuTime(after.cpuUsec),
      // 平均 CPU 得长期采样才有意义，这一版不编数字
      avgCpu: 0,
      memUsed: after.memUsed,
      memLimit,
      memPercent: memLimit > 0 ? Math.round((after.memUsed / memLimit) * 1000) / 10 : 0,
      // cgroup v2 不按容器统计网络与块设备吞吐，宁可不报也不编
      netIo: '',
      blockIo: '',
      pids: after.pids,
    })
  }
  return rows
}

function readCgroupResources(name) {
  const base = `/sys/fs/cgroup/lxc.payload.${name}`
  if (!existsSync(base)) return null
  const read = file => {
    try {
      return readFileSync(join(base, file), 'utf8').trim()
    } catch {
      return null
    }
  }
  return {
    cpusetCpus: read('cpuset.cpus'),
    cpusetEffective: read('cpuset.cpus.effective'),
    cpuMax: read('cpu.max'),
    cpuWeight: read('cpu.weight'),
    memoryMax: read('memory.max'),
    memoryCurrent: read('memory.current'),
    memoryHigh: read('memory.high'),
    memoryPeak: read('memory.peak'),
    oomGroup: read('memory.oom.group'),
    swapMax: read('memory.swap.max'),
    swapCurrent: read('memory.swap.current'),
    pidsMax: read('pids.max'),
    pidsCurrent: read('pids.current'),
    ioWeight: read('io.weight'),
  }
}

/**
 * 把限制直接写进运行中的 cgroup —— 这是「不重启就生效」的唯一途径。
 * config 是下次开机的状态，cgroup 是此刻的状态，两边都写才不会各自漂移。
 */
async function applyCgroup(name, settings) {
  const base = `/sys/fs/cgroup/lxc.payload.${name}`
  if (!existsSync(base)) return { live: false, errors: [] }
  const writes = []
  if ('cores' in settings) {
    // 清空绑核 = 交还给宿主可用的全部核。cgroup 不接受空串，要读出 cpuset.cpus.effective。
    let value = settings.cores
    if (!value) {
      try {
        value = readFileSync('/sys/fs/cgroup/cpuset.cpus.effective', 'utf8').trim()
      } catch {
        value = ''
      }
    }
    if (value) writes.push(['cpuset.cpus', value])
  }
  if ('cpuMax' in settings) writes.push(['cpu.max', settings.cpuMax || 'max 100000'])
  if ('cpuWeight' in settings) writes.push(['cpu.weight', String(settings.cpuWeight || 100)])
  if ('memoryMax' in settings) writes.push(['memory.max', settings.memoryMax || 'max'])
  if ('memoryHigh' in settings) writes.push(['memory.high', settings.memoryHigh || 'max'])
  // oom.group 只认 0/1：开了以后整组一起被 OOM 杀，而不是只杀一个进程。
  if ('oomGroup' in settings) writes.push(['memory.oom.group', settings.oomGroup ? '1' : '0'])
  if ('swapMax' in settings) writes.push(['memory.swap.max', settings.swapMax || 'max'])
  if ('pidsMax' in settings) writes.push(['pids.max', settings.pidsMax || 'max'])
  // io.weight 的格式是「default 100」或「8:0 200」，面板统一用 default。
  if ('ioWeight' in settings) writes.push(['io.weight', 'default ' + (settings.ioWeight || 100)])

  const errors = []
  for (const [file, value] of writes) {
    try {
      writeFileSync(join(base, file), value + '\n')
    } catch (error) {
      errors.push(`${file}: ${error?.message ?? error}`)
    }
  }
  return { live: true, errors }
}

/**
 * 改 CPU 核数 / 内存上限 / swap 上限：写 config 持久化，同时写 cgroup 立即生效。
 * 容器没在跑时只写 config，下次启动自动应用。
 */
/** CPU 配额：面板按「核数」填（可带小数），换算成 cpu.max 的 quota/period。 */
function parseQuota(raw) {
  if (raw === '' || raw === null || raw === undefined || raw === '0' || raw === 0) return ''
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new HelperError('BAD_ARGS', 'CPU 配额要填正数（单位是核，可以带小数，例如 1.5）。')
  }
  if (value > hostCpuCount()) {
    throw new HelperError('BAD_ARGS', `CPU 配额不能超过宿主的 ${hostCpuCount()} 核。`)
  }
  const period = 100000
  return `${Math.round(value * period)} ${period}`
}

/** cpu.weight / io.weight：1..10000 的整数，默认 100。 */
function parseWeight(raw, label) {
  if (raw === '' || raw === null || raw === undefined) return ''
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 10000) {
    throw new HelperError('BAD_ARGS', `${label}要填 1..10000 的整数（默认 100，越大分到的越多）。`)
  }
  return String(value)
}

/** pids.max：正整数，或留空表示不限。 */
function parsePids(raw) {
  if (raw === '' || raw === null || raw === undefined) return ''
  const text = String(raw).trim()
  if (text === 'max') return 'max'
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1) {
    throw new HelperError('BAD_ARGS', 'PID 上限要填正整数，留空表示不限。')
  }
  return String(value)
}

/** 启动顺序 / 延迟之类的非负整数。 */
function parseCount(raw, label) {
  if (raw === '' || raw === null || raw === undefined) return ''
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new HelperError('BAD_ARGS', `${label}要填 0 或正整数。`)
  }
  return String(value)
}

/** 主机名：对应 lxc.uts.name，受内核 64 字节上限约束。 */
function parseHostname(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.length > 63 || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(text)) {
    throw new HelperError('BAD_ARGS', '主机名只能用字母、数字和连字符，不能以连字符开头或结尾（最长 63 字符）。')
  }
  return text
}

async function setResources(name, patch) {
  const container = assertName(name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const next = {}
  // ── 资源（同时写 config 与 cgroup）──
  if (patch && 'cores' in patch) next.cores = parseCores(patch.cores)
  if (patch && 'cpuQuota' in patch) next.cpuMax = parseQuota(patch.cpuQuota)
  if (patch && 'cpuWeight' in patch) next.cpuWeight = parseWeight(patch.cpuWeight, 'CPU 权重')
  if (patch && 'ioWeight' in patch) next.ioWeight = parseWeight(patch.ioWeight, 'IO 权重')
  if (patch && 'pids' in patch) next.pidsMax = parsePids(patch.pids)
  if (patch && 'memory' in patch) {
    const bytes = parseBytes(patch.memory)
    next.memoryMax = bytes === null ? '' : String(bytes)
  }
  if (patch && 'memoryHigh' in patch) {
    const bytes = parseBytes(patch.memoryHigh)
    next.memoryHigh = bytes === null ? '' : String(bytes)
  }
  if (patch && 'swap' in patch) {
    const bytes = parseBytes(patch.swap)
    next.swapMax = bytes === null ? '' : String(bytes)
  }
  if (patch && 'oomGroup' in patch) next.oomGroup = Boolean(patch.oomGroup)
  // ── 基本（只写 config，下次开机生效；hostname 例外，下面单独处理）──
  if (patch && 'autostart' in patch) next.autostart = Boolean(patch.autostart)
  if (patch && 'startOrder' in patch) next.startOrder = parseCount(patch.startOrder, '启动顺序')
  if (patch && 'startDelay' in patch) next.startDelay = parseCount(patch.startDelay, '启动延迟')
  if (patch && 'initCmd' in patch) next.initCmd = String(patch.initCmd ?? '').trim()
  if (patch && 'capDrop' in patch) next.capDrop = String(patch.capDrop ?? '').trim().replace(/\s+/g, ' ')
  if (patch && 'hostname' in patch) next.hostname = parseHostname(patch.hostname)
  if (Object.keys(next).length === 0) {
    throw new HelperError('BAD_ARGS', '没有要改的项。可改：cores / cpuQuota / cpuWeight / memory / memoryHigh / swap / oomGroup / pids / ioWeight / hostname / autostart / startOrder / startDelay / initCmd / capDrop。')
  }

  const path = containerConfigPath(container)
  const before = readConfig(container)
  const after = writeLxcSettings(before, next)
  let backup = null
  if (after !== before) {
    backup = `${path}.cm-bak-${Date.now()}`
    writeFileSync(backup, before, { mode: 0o600 })
    const temporary = path + '.tmp'
    writeFileSync(temporary, after, { mode: 0o644 })
    renameSync(temporary, path)
  }

  const cgroup = await applyCgroup(container, next)
  if (cgroup.errors.length > 0) {
    throw new HelperError(
      'LXC_ERROR',
      `配置已写入，但有一部分没即时生效：${cgroup.errors.join('；')}`,
      '停止再启动容器后，这些值会按 config 重新应用。',
    )
  }
  // hostname 写在 config 里只管下次开机，跑着的容器得 attach 进去改。
  const running = (await containerState(container)) === 'running'
  let hostnameLive = null
  if ('hostname' in next && next.hostname && running) {
    try {
      await lxcSh(container, `hostname ${next.hostname}`)
      hostnameLive = true
    } catch {
      hostnameLive = false
    }
  }

  // capabilities、init、启动顺序都是启动那一刻才读的，改完得重启。
  const restartOnly = ['capDrop', 'initCmd', 'startOrder', 'startDelay'].filter(key => key in next && running)

  audit({ action: 'lxc.resources.set', target: container, patch: next, live: cgroup.live, backup, restartOnly })
  return {
    name: container,
    changed: after !== before,
    backup,
    settings: readLxcSettings(after),
    live: cgroup.live,
    resources: readCgroupResources(container),
    hostnameLive,
    restartRequired: restartOnly,
  }
}

/**
 * 老的 /lxc/config 入口。字段集合已经和 setResources 合成一套，
 * 只有内存上限在那边叫 memory，转一下再转发，免得两处校验各写一遍。
 */
async function setConfig(name, patch) {
  const forwarded = { ...(patch || {}) }
  if ('memoryMax' in forwarded) {
    forwarded.memory = forwarded.memoryMax
    delete forwarded.memoryMax
  }
  if ('swapMax' in forwarded) {
    forwarded.swap = forwarded.swapMax
    delete forwarded.swapMax
  }
  return setResources(name, forwarded)
}

/** 在容器内跑一段 sh，返回 stdout。容器没起来或 attach 失败时抛。 */
async function lxcSh(name, script, timeoutMs = 60_000) {
  const result = await run('lxc-attach', ['-n', name, '--', 'sh', '-c', script], { timeoutMs })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || result.stdout.trim() || `lxc-attach 退出码 ${result.code}`)
  }
  return result.stdout
}

/**
 * 让容器自己去拿 DHCP 地址。
 * 挂 lxcbr0 时有 lxc-net 的 dnsmasq，但容器内照样要跑客户端；
 * 挂 br0 这类主网桥时更是只有容器自己跑客户端才拿得到地址。
 * 按发行版选最合适的做法，幂等，已经有地址就直接返回。
 */
async function configureDhcp(name) {
  const container = assertName(name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const state = await containerState(container)
  if (state !== 'running') {
    return { name: container, configured: false, reason: '容器没在运行，等它起来再配。', state }
  }

  // init 起来之前 attach 会失败，最多等 12 秒。
  let osText = ''
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      osText = await lxcSh(container, 'cat /etc/os-release 2>/dev/null || cat /etc/alpine-release 2>/dev/null', 20_000)
      break
    } catch (error) {
      if (attempt === 5) throw error
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  // 已经拿到地址就别折腾。
  const hasV4 = await lxcSh(container, "ip -4 addr show eth0 2>/dev/null | grep -q 'inet ' && echo yes || echo no")
  if (String(hasV4).includes('yes')) {
    return { name: container, configured: true, method: 'already-has-address' }
  }

  if (/alpine/i.test(osText)) {
    const hasService = await lxcSh(container, 'test -x /etc/init.d/dhcpcd && echo yes || echo no')
    if (String(hasService).includes('yes')) {
      await lxcSh(container, 'rc-update add dhcpcd default >/dev/null 2>&1; rc-service dhcpcd start >/dev/null 2>&1; true', 90_000)
      audit({ action: 'lxc.dhcp', target: container, method: 'dhcpcd' })
      return { name: container, configured: true, method: 'dhcpcd' }
    }
    await lxcSh(container, 'udhcpc -i eth0 -b -q -n -t 5 >/dev/null 2>&1; true', 60_000)
    audit({ action: 'lxc.dhcp', target: container, method: 'udhcpc-once' })
    return { name: container, configured: true, method: 'udhcpc-once' }
  }

  if (/debian|ubuntu/i.test(osText)) {
    const hasNetworking = await lxcSh(container, 'systemctl list-unit-files networking.service 2>/dev/null | grep -q networking && echo yes || echo no')
    if (String(hasNetworking).includes('yes')) {
      await lxcSh(container, 'mkdir -p /etc/network/interfaces.d && printf "auto eth0\\niface eth0 inet dhcp\\n" > /etc/network/interfaces.d/eth0 && systemctl restart networking >/dev/null 2>&1; true', 90_000)
      audit({ action: 'lxc.dhcp', target: container, method: 'ifupdown' })
      return { name: container, configured: true, method: 'ifupdown' }
    }
    await lxcSh(container, 'command -v dhclient >/dev/null 2>&1 && dhclient -1 eth0 >/dev/null 2>&1; true', 90_000)
    audit({ action: 'lxc.dhcp', target: container, method: 'dhclient-once' })
    return { name: container, configured: true, method: 'dhclient-once' }
  }

  return { name: container, configured: false, reason: `不认识的发行版：${String(osText).split('\n')[0] || '未知'}` }
}

/** 校验 8G / 512M 这种大小，返回 lxc-create --fssize 认的写法。 */
function assertDiskSize(raw, label = '磁盘大小') {
  const text = String(raw ?? '').trim()
  if (!text) return '8G'
  const match = /^(\d+)\s*([MG])$/i.exec(text)
  if (!match) throw new HelperError('BAD_ARGS', `${label}不合法：${text}（写 8G / 512M 这种）`)
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  const megabytes = unit === 'G' ? value * 1024 : value
  if (megabytes < 256) throw new HelperError('BAD_ARGS', `${label}太小：${text}（最小 256M）`)
  if (megabytes > 4 * 1024 * 1024) throw new HelperError('BAD_ARGS', `${label}太大：${text}（上限 4096G）`)
  return `${value}${unit}`
}

/** config 里换掉（或补上）lxc.rootfs.path。 */
function setRootfsPath(config, rootfsPath) {
  const line = `lxc.rootfs.path = ${rootfsPath}`
  if (/^lxc\.rootfs\.path\s*=.*$/m.test(config)) return config.replace(/^lxc\.rootfs\.path\s*=.*$/m, line)
  return config.replace(/\n*$/, '\n') + line + '\n'
}

async function createContainer(spec) {
  const container = assertName(spec?.name)
  if (containerExists(container)) throw new HelperError('BAD_ARGS', `容器已存在：${container}`)
  const distro = String(spec?.distro ?? 'debian')
  const release = String(spec?.release ?? 'bookworm')
  const arch = String(spec?.arch ?? 'arm64')
  // rootfs 后端：loop（一块 img，默认）或 dir（宿主上的一个目录）。
  // 其它后端没实现就明确拒绝 —— 悄悄换成 loop 会让人以为用的是 btrfs 快照。
  const backend = String(spec?.backend ?? 'loop') || 'loop'
  if (!['loop', 'dir'].includes(backend)) {
    throw new HelperError('BAD_ARGS', `rootfs 后端只支持 loop 或 dir，收到 ${backend}（btrfs / zfs / lvm 还没实现）。`)
  }
  const diskSize = assertDiskSize(spec?.diskSize, '磁盘大小')
  const dataDisks = Array.isArray(spec?.dataDisks) ? spec.dataDisks : []
  if (!DISTROS.test(distro)) throw new HelperError('BAD_ARGS', `发行版不合法：${distro}`)
  if (!RELEASES.test(release)) throw new HelperError('BAD_ARGS', `版本不合法：${release}`)
  if (!ARCHES.has(arch)) throw new HelperError('BAD_ARGS', `架构不合法：${arch}`)
  if (dataDisks.length + 1 > MAX_LOOP_DISKS) {
    throw new HelperError('BAD_ARGS', `数据盘最多 ${MAX_LOOP_DISKS - 1} 块（内核 loop 设备上限 ${MAX_LOOP_DISKS}）。`)
  }

  // 每个容器一个磁盘目录：<名字>-0.img 是 rootfs，-1、-2… 是数据盘。
  const diskDir = join(DISK_ROOT, container)
  mkdirSync(diskDir, { recursive: true, mode: 0o700 })

  // 系统镜像统一缓存在 IMAGE_ROOT，不落 /var/cache/lxc。
  // 模板会自己拼 /download/<distro>/<release>/<arch>/<variant>，所以这里只给基路径。
  mkdirSync(IMAGE_ROOT, { recursive: true, mode: 0o755 })

  // loop：lxc-create 先把镜像建在 /var/lib/lxc/<名字>/rootdev，再解包进去（下面会搬走）。
  // dir ：rootfs 直接解包成 /var/lib/lxc/<名字>/rootfs，没有镜像要搬。
  const createArgs = backend === 'loop'
    ? ['-n', container, '-t', 'download', '-B', 'loop', '--fssize', diskSize,
      '--', '--dist', distro, '--release', release, '--arch', arch]
    : ['-n', container, '-t', 'download', '-B', 'dir',
      '--', '--dist', distro, '--release', release, '--arch', arch]
  const runCreate = () => run('lxc-create', createArgs, {
    timeoutMs: 600_000,
    env: { LXC_CACHE_PATH: IMAGE_ROOT },
  })

  // download 模板拉 rootfs 时自己会重试 3 次，但网络瞬断能让 3 次全挂。
  // 这种多半是偶发，重来一次通常就过了（第二次还会命中已下好的缓存），所以自动重试一轮。
  const isDownloadFailure = text => /Failed to download|Could not resolve|Connection (refused|timed out)|Network is unreachable|Temporary failure/i.test(text)
  let result = await runCreate()
  if (result.code !== 0 && isDownloadFailure(String(result.stderr) + String(result.stdout))) {
    // 失败会留下半成品目录，先清干净再重来。
    await run('lxc-destroy', ['-n', container, '-f'], { timeoutMs: 120_000 })
    rmSync(join(LXC_ROOT, container), { recursive: true, force: true })
    result = await runCreate()
  }
  if (result.code !== 0) {
    rmSync(diskDir, { recursive: true, force: true })
    await run('lxc-destroy', ['-n', container, '-f'], { timeoutMs: 120_000 })
    const output = String(result.stderr) + String(result.stdout)
    throw new HelperError(
      'LXC_ERROR',
      result.stderr.trim() || result.stdout.trim() || 'lxc-create 失败',
      isDownloadFailure(output)
        ? '下载 rootfs 失败（已自动重试过一次）。确认宿主能访问 images.linuxcontainers.org 再重试；同一个发行版下载过一次后就走本地缓存，快很多。'
        : 'download 模板要联网拉 rootfs，确认出口网络和磁盘空间。',
    )
  }

  // loop：把镜像搬进工作目录，config 指过去。dir：什么都不用搬，rootfs 已经就位。
  try {
    if (backend === 'loop') {
      const rootImage = join(diskDir, `${container}-0.img`)
      const created = join(LXC_ROOT, container, 'rootdev')
      if (!existsSync(created)) throw new Error('lxc-create 没有留下 rootdev（没走 loop 后端？）')
      renameSync(created, rootImage)
      writeFileSync(containerConfigPath(container), setRootfsPath(readConfig(container), `loop:${rootImage}`))
    } else {
      const rootfsDir = join(LXC_ROOT, container, 'rootfs')
      if (!existsSync(rootfsDir)) throw new Error('lxc-create -B dir 没有留下 rootfs 目录。')
      // 显式写成 dir: 形式：以后有人读 config 也一眼知道 rootfs 在哪
      writeFileSync(containerConfigPath(container), setRootfsPath(readConfig(container), `dir:${rootfsDir}`))
    }
  } catch (error) {
    await run('lxc-destroy', ['-n', container, '-f'], { timeoutMs: 120_000 })
    rmSync(diskDir, { recursive: true, force: true })
    throw new HelperError('LXC_ERROR', `磁盘落位失败：${error?.message ?? error}`, '检查 /opt/dsh-container/lxc 的权限与剩余空间。')
  }

  // 数据盘：每块一张 ext4，启动时由 hook loop 挂进 rootfs。任何一步失败都整个撤掉。
  try {
    const lines = []
    for (let index = 0; index < dataDisks.length; index += 1) {
      const disk = dataDisks[index] ?? {}
      const size = assertDiskSize(disk.size, `第 ${index + 1} 块数据盘大小`)
      const mount = String(disk.mount ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (!mount || mount.includes('..')) {
        throw new HelperError('BAD_ARGS', `第 ${index + 1} 块数据盘的挂载点不合法：${disk.mount ?? '(空)'}`)
      }
      const image = join(diskDir, `${container}-${index + 1}.img`)
      const truncate = await run('/usr/bin/truncate', ['-s', size, image], { timeoutMs: 60_000 })
      if (truncate.code !== 0) throw new HelperError('LXC_ERROR', `建数据盘失败：${truncate.stderr.trim()}`)
      const mkfs = await run('/sbin/mkfs.ext4', ['-q', '-F', image], { timeoutMs: 180_000 })
      if (mkfs.code !== 0) throw new HelperError('LXC_ERROR', `格式化数据盘失败：${mkfs.stderr.trim()}`)
      lines.push(`${image} ${mount}`)
    }
    writeFileSync(join(LXC_ROOT, container, '.dsh-data-disks'), lines.join('\n') + '\n', { mode: 0o644 })
    const config = readConfig(container)
    if (!/^lxc\.hook\.mount\s*=/m.test(config)) {
      writeFileSync(containerConfigPath(container), config.replace(/\n*$/, '\n') + `lxc.hook.mount = ${DATA_HOOK}\n`)
    }
  } catch (error) {
    await run('lxc-destroy', ['-n', container, '-f'], { timeoutMs: 120_000 })
    rmSync(diskDir, { recursive: true, force: true })
    throw error instanceof HelperError
      ? error
      : new HelperError('LXC_ERROR', `数据盘准备失败：${error?.message ?? error}`, '检查 /opt/dsh-container/lxc 的权限与剩余空间。')
  }
  try {
    writeFileSync(join(LXC_ROOT, container, '.dsh-cm-template'), `${distro}/${release}/${arch}`, { mode: 0o644 })
  } catch { /* 记录失败不影响容器 */ }
  // 自动避让换掉的 MAC，最后一起返回给前端提示。
  let netSwaps = []
  if (spec?.network) {
    try {
      const applied = await setNetwork(container, [spec.network], false)
      netSwaps = applied?.swaps ?? []
    } catch (error) {
      audit({ action: 'lxc.create.network-failed', target: container, error: error?.message })
      // MAC 撞车必须抛出去：静默吞掉会得到一个「建好了但没有网卡」的容器，比失败更难查。
      if (/MAC .* 已经被|连试 8 次都撞车/.test(String(error?.message ?? ''))) throw error
    }
  }
  // 内存上限在创建时就写进 config，省得建完再走一次改配置（那条要确认）。
  // 创建时给的资源限制：写进 config，容器一启动 LXC 就按它建 cgroup。
  if (spec?.memoryMax || spec?.swapMax || spec?.cores) {
    try {
      const patch = {}
      if (spec.memoryMax) {
        const bytes = parseBytes(spec.memoryMax)
        if (bytes !== null) patch.memoryMax = String(bytes)
      }
      if (spec.swapMax) {
        const bytes = parseBytes(spec.swapMax)
        if (bytes !== null) patch.swapMax = String(bytes)
      }
      if (spec.cores) {
        const cpus = parseCores(spec.cores)
        if (cpus) patch.cores = cpus
      }
      if (Object.keys(patch).length > 0) {
        const before = readConfig(container)
        writeFileSync(containerConfigPath(container), writeLxcSettings(before, patch), { mode: 0o644 })
      }
    } catch (error) {
      audit({ action: 'lxc.create.resources-failed', target: container, error: error?.message })
    }
  }
  audit({ action: 'lxc.create', target: container, distro, release, arch })
  return { name: container, distro, release, arch, state: await containerState(container), swaps: netSwaps }
}

/* ───────────────────────── 快照 / 克隆 / 挂载 ───────────────────────── */

const SNAPSHOT_TAG = /^snap[A-Za-z0-9_.-]{0,32}$/

/** lxc-snapshot -L 的输出是一行一个快照；没装或者没快照时不报错，给空表。 */
async function listSnapshots(name) {
  const container = assertName(name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const result = await run('lxc-snapshot', ['-n', container, '-L'], { timeoutMs: 30_000 })
  const snapshots = []
  for (const line of String(result.stdout || '').split('\n')) {
    const match = line.match(/^\s*(snap[A-Za-z0-9_.-]{0,32})\b\s*(.*)$/)
    if (!match) continue
    snapshots.push({ name: match[1], detail: match[2].trim(), raw: line.trim() })
  }
  return {
    name: container,
    snapshots,
    supported: result.code === 0,
    detail: result.code === 0 ? null : (result.stderr || result.stdout || '').trim() || null,
    // 这台机是 ext4：快照是完整拷贝，不共享底层数据块。
    note: 'rootfs 在 ext4 上时，快照是把整个 rootfs 复制一份，不共享数据块，占空间也慢。',
  }
}

async function snapshotOp(name, op, options = {}) {
  const container = assertName(name)
  const cancelKey = options.cancelKey || null
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  if (op === 'create') {
    const before = (await listSnapshots(container)).snapshots
    const args = ['-n', container, '-c', String(options.comment || 'dsh-container-manager').slice(0, 120)]
    const result = await run('lxc-snapshot', args, { timeoutMs: 600_000, cancelKey })
    // 上游 dir 后端有个脾气：快照确实建出来了，命令却退 1 且没有任何输出。
    // 所以不看退出码，看「快照数量有没有变多」——这才是事实。
    const after = (await listSnapshots(container)).snapshots
    const grew = after.length > before.length
    if (!grew) {
      throw new HelperError(
        'LXC_ERROR',
        result.stderr.trim() || result.stdout.trim() || '建快照失败，快照列表没有变化。',
        'ext4 上会整份复制 rootfs，空间不够就失败；容器冻结状态下也不行。',
      )
    }
    audit({ action: 'lxc.snapshot.create', target: container, comment: options.comment ?? null, exit: result.code })
    return {
      name: container,
      op,
      ok: result.code === 0,
      warning: result.code === 0 ? null : 'lxc-snapshot 退出码是 ' + result.code + '，但快照已经建出来了（上游 dir 后端的已知行为）。',
      output: (result.stdout || result.stderr || '').trim(),
      snapshots: after,
    }
  }
  const tag = String(options.snapshot || '')
  if (!SNAPSHOT_TAG.test(tag)) throw new HelperError('BAD_ARGS', `快照名不合法：${tag}`)
  if (op === 'restore') {
    const before = (await listSnapshots(container)).snapshots.map(item => item.name)
    const safety = await snapshotOp(container, 'create', { comment: 'before-restore-' + tag, cancelKey })
    const safetyTag = safety.snapshots.map(item => item.name).find(name => !before.includes(name))
    if (!safetyTag) throw new HelperError('LXC_ERROR', '恢复前安全快照没有建出来，已中止恢复。')
    const result = await run('lxc-snapshot', ['-n', container, '-r', tag], { timeoutMs: 600_000, cancelKey })
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      const rollback = await run('lxc-snapshot', ['-n', container, '-r', safetyTag], { timeoutMs: 600_000, cancelKey })
      throw new HelperError(
        'LXC_ERROR',
        (detail || '恢复快照失败') + (rollback.code === 0 ? '，已回滚到恢复前安全快照。' : '，恢复前安全快照回滚失败。'),
        '安全快照：' + safetyTag,
      )
    }
    audit({ action: 'lxc.snapshot.restore', target: container, snapshot: tag, safetySnapshot: safetyTag })
    return { name: container, op, snapshot: tag, safetySnapshot: safetyTag, state: await containerState(container), output: (result.stdout || result.stderr || '').trim() }
  }
  if (op === 'delete') {
    const before = (await listSnapshots(container)).snapshots
    const result = await run('lxc-snapshot', ['-n', container, '-d', tag], { timeoutMs: 120_000, cancelKey })
    const after = (await listSnapshots(container)).snapshots
    if (after.length >= before.length) {
      throw new HelperError('LXC_ERROR', result.stderr.trim() || '删快照失败，快照还在。')
    }
    audit({ action: 'lxc.snapshot.delete', target: container, snapshot: tag })
    return { name: container, op, snapshot: tag, snapshots: after }
  }
  throw new HelperError('BAD_ARGS', `不认识的快照操作：${op}（只支持 create / restore / delete）`)
}

/** 克隆：lxc-copy 整份复制，新容器是停止状态。 */
async function cloneContainer(spec) {
  const source = assertName(spec?.name)
  const target = assertName(spec?.newName)
  if (!containerExists(source)) throw new HelperError('NOT_FOUND', `没有这个容器：${source}`)
  if (containerExists(target)) throw new HelperError('BAD_ARGS', `目标容器已存在：${target}`)
  const state = await containerState(source)
  if (state === 'running') {
    throw new HelperError('BAD_ARGS', '运行中的容器不能直接克隆，先停掉。', 'lxc-copy 需要源容器处于停止状态才能保证 rootfs 一致。')
  }
  const result = await run('lxc-copy', ['-n', source, '-N', target], { timeoutMs: 900_000, cancelKey: spec?.cancelKey })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || result.stdout.trim() || '克隆失败', 'ext4 上克隆是整份复制，磁盘不够就会失败。')
  }
  const configPath = containerConfigPath(target)
  const cloned = readConfig(target).split('\n').map(line => {
    const mac = /^(\s*lxc\.net\.\d+\.hwaddr\s*=).*$/i.exec(line)
    if (mac) return mac[1] + ' ' + randomMac()
    if (/^\s*lxc\.net\.\d+\.ipv[46]\.(address|gateway)\s*=/i.test(line)) return null
    return line
  }).filter(line => line !== null).join('\n')
  writeFileSync(configPath, cloned, { mode: 0o644 })
  audit({ action: 'lxc.clone', target, source, networkIdentityReset: true })
  return { name: target, source, state: await containerState(target) }
}

function parseMountEntries(config) {
  const mounts = []
  for (const line of String(config || '').split('\n')) {
    const match = line.match(/^\s*lxc\.mount\.entry\s*=\s*(.+)$/)
    if (!match) continue
    const parts = match[1].trim().split(/\s+/)
    if (parts.length < 3) continue
    mounts.push({
      host: parts[0],
      target: parts[1],
      type: parts[2],
      options: parts.slice(3).join(' '),
    })
  }
  return mounts
}

function readMounts(name) {
  const container = assertName(name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const config = readConfig(container)
  return { name: container, mounts: parseMountEntries(config), configPath: containerConfigPath(container) }
}

/** 挂载点写入：宿主路径与容器路径都必须绝对路径，选项里必须含 bind。 */
function sanitizeMounts(input) {
  if (!Array.isArray(input)) throw new HelperError('BAD_ARGS', 'mounts 得是数组。')
  const out = []
  for (const item of input.slice(0, 32)) {
    const host = String(item?.host ?? '').trim()
    const target = String(item?.target ?? '').trim()
    let options = String(item?.options ?? 'bind,create=dir').trim() || 'bind,create=dir'
    if (!host || !target) throw new HelperError('BAD_ARGS', '宿主路径与容器路径都不能空。')
    if (!host.startsWith('/') || !target.startsWith('/')) throw new HelperError('BAD_ARGS', `两边都得是绝对路径：${host} -> ${target}`)
    if (/[\s]/.test(host) || /[\s]/.test(target)) throw new HelperError('BAD_ARGS', `路径里不能有空格：${host} -> ${target}`)
    if (/[\r\n]/.test(options)) throw new HelperError('BAD_ARGS', '挂载选项里不能有换行。')
    if (!/(^|,)bind(,|$)/.test(options)) options = 'bind,' + options
    if (!/create=/.test(options)) options += ',create=dir'
    out.push({ host, target, type: 'none', options })
  }
  return out
}

async function setMounts(name, mounts) {
  const container = assertName(name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const clean = sanitizeMounts(mounts)
  const path = containerConfigPath(container)
  const before = readConfig(container)
  const kept = before.split('\n').filter(line => !/^\s*lxc\.mount\.entry\s*=/.test(line))
  const added = clean.map(item => `lxc.mount.entry = ${item.host} ${item.target} ${item.type} ${item.options}`)
  const after = [...kept, ...added].join('\n').replace(/\n+$/, '') + '\n'
  if (after === before) {
    return { name: container, changed: false, mounts: parseMountEntries(before) }
  }
  const backup = `${path}.cm-bak-${Date.now()}`
  writeFileSync(backup, before, { mode: 0o600 })
  const temporary = path + '.tmp'
  writeFileSync(temporary, after, { mode: 0o644 })
  renameSync(temporary, path)
  audit({ action: 'lxc.mounts.set', target: container, mounts: clean, backup })
  return { name: container, changed: true, backup, mounts: parseMountEntries(after) }
}

/* ───────────────────────── 宿主网络 ───────────────────────── */

function listInterfaces() {
  let names = []
  try {
    names = readdirSync('/sys/class/net')
  } catch {
    return []
  }
  return names.map(name => {
    let operandState = 'unknown'
    try {
      operandState = readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim()
    } catch { /* 忽略 */ }
    let mac = ''
    try {
      mac = readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim()
    } catch { /* 忽略 */ }
    return { name, state: operandState, mac }
  }).filter(item => item.name)
}

function moduleLoaded(name) {
  try {
    return readFileSync('/proc/modules', 'utf8').split('\n').some(line => line.startsWith(name + ' '))
  } catch {
    return false
  }
}

function readLxcNetConf() {
  try {
    const text = readFileSync('/etc/default/lxc-net', 'utf8')
    const get = key => {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, 'm').exec(text)
      return match ? match[1].trim() : undefined
    }
    return {
      enabled: String(get('USE_LXC_BRIDGE') ?? '').toLowerCase().includes('true'),
      bridge: get('LXC_BRIDGE') ?? 'lxcbr0',
      address: get('LXC_ADDR') ?? '10.0.3.1',
      network: get('LXC_NETWORK') ?? '10.0.3.0/24',
      dhcpRange: get('LXC_DHCP_RANGE') ?? '10.0.3.2,10.0.3.254',
      file: '/etc/default/lxc-net',
    }
  } catch {
    return { enabled: false, bridge: 'lxcbr0', file: '/etc/default/lxc-net', missing: true }
  }
}

async function lxcNetStatus() {
  const conf = readLxcNetConf()
  const bridge = conf.bridge ?? 'lxcbr0'
  const address = await run('ip', ['-4', '-o', 'addr', 'show', 'dev', bridge], { timeoutMs: 10_000 })
  const parsed = /inet\s+([0-9.]+\/\d+)/.exec(address.stdout)
  const containers = await listContainers()
  const members = containers
    .filter(container => Array.isArray(container.ips) && container.ips.length > 0)
    .map(container => ({ name: container.name, ips: container.ips }))
  return {
    name: bridge,
    subnet: parsed ? parsed[1] : (conf.network ?? ''),
    gateway: conf.address ?? '',
    up: address.code === 0 && Boolean(parsed),
    containers: members,
    configFile: conf.file,
    nat: conf.enabled,
  }
}

async function ensureBridge({ name, subnet, gateway, nat = true }) {
  const bridge = name ? assertIfname(name, '网桥名') : 'lxcbr0'
  if (bridge !== 'lxcbr0') {
    throw new HelperError('BAD_ARGS', '第一版只管理 lxcbr0（lxc-net 的默认网桥）。自定义网桥请手写 /etc/default/lxc-net。')
  }
  const network = assertCidr(subnet ?? '10.0.3.0/24', '子网')
  const address = assertIp(gateway ?? '10.0.3.1', '网关')
  const lines = readLxcNetConf()
  const text = [
    '# Managed by dsh-container-manager',
    `USE_LXC_BRIDGE="true"`,
    `LXC_BRIDGE="${bridge}"`,
    `LXC_ADDR="${address}"`,
    `LXC_NETWORK="${network}"`,
    `LXC_DHCP_RANGE="${network.split('/')[0].replace(/\.0$/, '.2')},${network.split('/')[0].replace(/\.0$/, '.254')}"`,
    'LXC_DHCP_MAX="253"',
    `LXC_IPV6_ADDR=""`,
    `LXC_IPV6_NETWORK=""`,
    '',
  ].join('\n')
  if (!existsSync('/etc/default')) mkdirSync('/etc/default', { recursive: true })
  const backup = `/etc/default/lxc-net.cm-bak-${Date.now()}`
  if (existsSync('/etc/default/lxc-net')) {
    writeFileSync(backup, readFileSync('/etc/default/lxc-net', 'utf8'))
  }
  writeFileSync('/etc/default/lxc-net', text, { mode: 0o644 })
  const restarted = await run('systemctl', ['restart', 'lxc-net'], { timeoutMs: 60_000 })
  if (restarted.code !== 0) {
    throw new HelperError('LXC_ERROR', `已写配置，但重启 lxc-net 失败：${restarted.stderr.trim()}`, `备份在 ${backup}`)
  }
  audit({ action: 'net.bridge', name: bridge, subnet: network, gateway: address, nat: Boolean(nat), backup })
  return lxcNetStatus()
}

async function ensureModule(name) {
  const module = String(name ?? '')
  if (!MODULE_ALLOW.has(module)) throw new HelperError('BAD_ARGS', `不允许加载这个模块：${module}`)
  if (moduleLoaded(module)) return { module, loaded: true, already: true }
  const result = await run('modprobe', [module], { timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', `modprobe ${module} 失败：${result.stderr.trim() || result.code}`, '宿主机内核可能没有这个模块；换 bridge 方案。')
  }
  audit({ action: 'net.module', name: module })
  return { module, loaded: moduleLoaded(module) }
}

async function hostNetwork() {
  const ipAddr = await run('ip', ['-4', '-o', 'addr'], { timeoutMs: 10_000 })
  const addresses = []
  for (const line of ipAddr.stdout.split('\n')) {
    const match = /^\d+:\s+([^\s]+)\s+inet\s+([0-9.]+\/\d+)/.exec(line.trim())
    if (match) addresses.push({ interface: match[1].split('@')[0], address: match[2] })
  }
  const route = await run('ip', ['route'], { timeoutMs: 10_000 })
  const defaultRoute = /default via ([0-9.]+) dev ([^\s]+)/.exec(route.stdout)
  return {
    interfaces: listInterfaces(),
    addresses,
    defaultRoute: defaultRoute ? { gateway: defaultRoute[1], interface: defaultRoute[2] } : null,
    modules: { macvlan: moduleLoaded('macvlan'), ipvlan: moduleLoaded('ipvlan'), veth: moduleLoaded('veth'), bridge: moduleLoaded('bridge') },
    lxcNet: readLxcNetConf(),
  }
}

/* ───────────────────────── HTTP 层 ───────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        req.destroy()
        reject(new HelperError('BAD_ARGS', '请求体太大。'))
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new HelperError('BAD_ARGS', '请求体不是合法 JSON。'))
      }
    })
    req.on('error', reject)
  })
}

let templateCache = null
let templateCacheAt = 0
async function listTemplates() {
  if (templateCache && Date.now() - templateCacheAt < 3_600_000) return templateCache
  const result = await run('/usr/share/lxc/templates/lxc-download', ['--list'], { timeoutMs: 45_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.code !== 0) throw new HelperError('LXC_ERROR', '读不到 LXC 模板列表：' + (result.stderr || result.stdout).trim())
  const grouped = new Map()
  for (const line of String(result.stdout).split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] === 'DIST') continue
    const [distro, release, arch, variant] = parts
    if (!grouped.has(distro)) grouped.set(distro, { distro, releases: [], arches: [] })
    const item = grouped.get(distro)
    if (!item.releases.includes(release)) item.releases.push(release)
    if (!item.arches.includes(arch)) item.arches.push(arch)
    if (variant !== 'default' && !item.arches.includes(variant)) item.arches.push(variant)
  }
  templateCache = { suggestions: [...grouped.values()], arches: [...new Set([...grouped.values()].flatMap(item => item.arches))] }
  templateCacheAt = Date.now()
  return templateCache
}

/* ───────────────────────── 导出 / 导入 ───────────────────────── */

// 导出落盘目录：默认放在插件自己的地盘里，别顺手写进 /var/lib/lxc 把 rootfs 目录搞乱。
const EXPORT_DIR = process.env.LXCD_EXPORT_DIR || '/var/lib/dsh-container-manager/exports'
const ARCHIVE_EXT = /\.tar(\.gz|\.xz|\.bz2|\.zst|\.lzma)?$/

/** 导出目录必须存在且可写；路径不允许是相对路径，也不允许穿出目录。 */
function resolveExportDir(dir) {
  const wanted = String(dir || EXPORT_DIR).trim()
  if (!wanted.startsWith('/')) throw new HelperError('BAD_ARGS', '导出目录要给绝对路径。')
  if (wanted.includes('..')) throw new HelperError('BAD_ARGS', '导出目录里不许出现 ..')
  mkdirSync(wanted, { recursive: true, mode: 0o750 })
  return wanted
}

function archiveName(container) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return container + '-' + stamp + '.tar.gz'
}

/**
 * lxc export：整份打包。ext4 + dir 后端上 --optimized 没有意义（那是 btrfs/zfs 的），
 * 所以默认不带；--instance-only 默认开 —— 快照单独占一份空间，导出它往往是意外。
 */
async function exportContainer(spec) {
  const container = assertName(spec?.name)
  if (!containerExists(container)) throw new HelperError('NOT_FOUND', `没有这个容器：${container}`)
  const dir = resolveExportDir(spec?.dir)
  const target = join(dir, archiveName(container))
  const partial = target + '.part'
  try { unlinkSync(partial) } catch { /* 上次失败可能没留下文件 */ }
  const args = ['export', container, partial]
  if (spec?.instanceOnly !== false) args.push('--instance-only')
  const result = await run('lxc', args, { timeoutMs: 1_800_000, cancelKey: spec?.cancelKey })
  let bytes = 0
  let sha256 = null
  try {
    bytes = statSync(partial).size
    if (bytes > 0) sha256 = createHash('sha256').update(readFileSync(partial)).digest('hex')
  } catch {
    bytes = 0
  }
  if (result.code !== 0 || bytes === 0) {
    try { unlinkSync(partial) } catch { /* best effort */ }
    const detail = (result.stderr || result.stdout || '').trim()
    throw new HelperError(
      'LXC_ERROR',
      detail || '导出失败：没有生成归档文件。',
      '导出要写一整份 rootfs，磁盘满或路径不可写都会失败；运行中的容器导出的是活文件系统，建议先停。',
    )
  }
  renameSync(partial, target)
  audit({ action: 'lxc.export', target: container, file: target, bytes, sha256 })
  return {
    name: container,
    file: target,
    bytes,
    sha256,
    instanceOnly: spec?.instanceOnly !== false,
    output: (result.stdout || result.stderr || '').trim(),
  }
}

/** 列导出目录里的归档：只看后缀对得上的，别把别的文件当备份。 */
async function listExports(spec) {
  const dir = resolveExportDir(spec?.dir)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }
  const files = []
  for (const name of names) {
    if (!ARCHIVE_EXT.test(name)) continue
    let stats = null
    try {
      stats = statSync(join(dir, name))
    } catch {
      continue
    }
    if (!stats || !stats.isFile()) continue
    files.push({
      name,
      path: join(dir, name),
      bytes: stats.size,
      at: new Date(stats.mtimeMs).toISOString(),
    })
  }
  files.sort((left, right) => String(right.at).localeCompare(String(left.at)))
  return { dir, files }
}

async function deleteExport(spec) {
  const dir = resolveExportDir(spec?.dir)
  const name = String(spec?.name || '')
  if (!ARCHIVE_EXT.test(name) || name.includes('/')) throw new HelperError('BAD_ARGS', '归档名不合法。')
  const target = join(dir, name)
  if (!existsSync(target)) throw new HelperError('NOT_FOUND', `没有这个归档：${name}`)
  unlinkSync(target)
  audit({ action: 'lxc.export.delete', file: target })
  return { name, dir }
}

async function validateLxcArchive(file, cancelKey = null) {
  const listed = await run('tar', ['-tf', file], { timeoutMs: 60_000, cancelKey })
  if (listed.code !== 0) throw new HelperError('BAD_ARGS', '归档无法读取：' + (listed.stderr || listed.stdout).trim())
  const entries = String(listed.stdout).split('\n').map(line => line.trim()).filter(Boolean)
  const configEntry = entries
    .filter(entry => basename(entry) === 'config')
    .sort((left, right) => left.split('/').length - right.split('/').length)[0]
  if (!configEntry) throw new HelperError('BAD_ARGS', '归档里没有 LXC config，拒绝导入。')
  const extracted = await run('tar', ['-xOf', file, configEntry], { timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024, cancelKey })
  if (extracted.code !== 0) throw new HelperError('BAD_ARGS', '读不到归档里的 config。')
  for (const raw of String(extracted.stdout).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^lxc\.hook\./i.test(line)) throw new HelperError('BAD_ARGS', '归档含 lxc.hook，拒绝导入。')
    if (/^lxc\.apparmor\.profile\s*=\s*unconfined/i.test(line)) throw new HelperError('BAD_ARGS', '归档关闭 AppArmor，拒绝导入。')
    if (/^lxc\.mount\.entry\s*=/i.test(line)) {
      const source = line.slice(line.indexOf('=') + 1).trim().split(/\s+/)[0]
      if (['/', '/home', '/root', '/etc'].includes(source) || source.startsWith('/home/') || source.startsWith('/root/')) {
        throw new HelperError('BAD_ARGS', '归档含宿主敏感目录挂载，拒绝导入。')
      }
    }
  }
}

/** lxc import：从一个归档建容器。名字必须给，别让 lxc 自己从文件名猜。 */
async function importContainer(spec) {
  const file = String(spec?.file || '').trim()
  const name = assertName(spec?.name)
  if (!file.startsWith('/')) throw new HelperError('BAD_ARGS', '归档路径要给绝对路径。')
  if (!ARCHIVE_EXT.test(file)) throw new HelperError('BAD_ARGS', '只认 .tar / .tar.gz / .tar.xz / .tar.bz2 / .tar.zst 归档。')
  if (!existsSync(file)) throw new HelperError('NOT_FOUND', `没有这个归档：${file}`)
  if (containerExists(name)) throw new HelperError('BAD_ARGS', `目标容器已存在：${name}`)
  await validateLxcArchive(file, spec?.cancelKey)
  const result = await run('lxc', ['import', file, name], { timeoutMs: 1_800_000, cancelKey: spec?.cancelKey })
  if (result.code !== 0 || !containerExists(name)) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new HelperError(
      'LXC_ERROR',
      detail || '导入失败：容器没有建出来。',
      '归档要能被 lxc 认出来（lxc export 产出的那种）；名字不能和现有容器重名。',
    )
  }
  audit({ action: 'lxc.import', target: name, file })
  return {
    name,
    file,
    state: await containerState(name),
    output: (result.stdout || result.stderr || '').trim(),
  }
}


/* ───────────────────────── 容器内文件 ───────────────────────── */

/**
 * LXC 的好处：rootfs 就在宿主上，停着也能读写。
 * 代价是这里以 root 身份直接动文件系统，所以路径校验必须自己扛：
 *  - 规整掉 . 空段，拒绝 ..
 *  - 对最终路径做 realpath，确认没有从软链接跑到 rootfs 外面
 *  - 单次读写 8MB 封顶
 */
const FILE_LIMIT = 8 * 1024 * 1024

/**
 * 容器的 rootfs 有两种完全不同的形态，文件面板必须分开走：
 *  - dir（目录型，模板/非特权常见）：rootfs 就是宿主上的一个目录 —— 停着也能读写，这是 LXC 的便宜。
 *  - image / 子卷（loop: / btrfs: / zfs: / lvm: / overlayfs:）：rootfs 是一块镜像或子卷，
 *    宿主上看不到挂载点（lxc-start 是在容器自己的命名空间里挂的），只能进容器里操作，
 *    所以这种必须运行中，走 lxc-attach。
 * 猜是不行的：猜错会把空的挂载点当成 rootfs，列出「一个空目录」还理直气壮。
 */

/** 从 <LXC_ROOT>/<名字>/config 读 lxc.rootfs.path，判断后端类型。 */
function rootfsSpec(container) {
  const configFile = join(LXC_ROOT, container, 'config')
  let text = ''
  try {
    text = readFileSync(configFile, 'utf8')
  } catch {
    throw new HelperError('NOT_FOUND', `读不到 ${container} 的 config。`)
  }
  const line = text.split('\n').map(row => row.trim()).find(row => row.startsWith('lxc.rootfs.path'))
  const fallback = join(LXC_ROOT, container, 'rootfs')
  if (!line) return { kind: 'dir', path: fallback }
  const value = line.slice(line.indexOf('=') + 1).trim()
  if (value.startsWith('dir:')) return { kind: 'dir', path: value.slice(4) }
  const colon = value.indexOf(':')
  if (colon > 0) return { kind: value.slice(0, colon), path: value.slice(colon + 1) }
  return { kind: 'dir', path: value.startsWith('/') ? value : fallback }
}

/** 容器是不是活着：attach 路线的前提。 */
async function isRunning(container) {
  try {
    const { stdout } = await execFileAsync('lxc-info', ['-n', container, '-sH'], { timeout: 10_000 })
    return String(stdout).trim().toLowerCase() === 'running'
  } catch {
    return false
  }
}

/** 判定这一台该走哪条路，顺便把「为什么不能」说清楚。 */
async function backendOf(name) {
  const container = assertName(name)
  const spec = rootfsSpec(container)
  if (spec.kind === 'dir') {
    const root = spec.path
    let info = null
    try {
      info = statSync(root)
    } catch {
      throw new HelperError('BAD_ARGS', `${container} 的 rootfs 目录不在了：${root}`)
    }
    if (!info.isDirectory()) {
      throw new HelperError('BAD_ARGS', `${container} 的 rootfs 不是目录：${root}`)
    }
    return { container, mode: 'direct', root: realpathSync(root) }
  }
  if (!(await isRunning(container))) {
    throw new HelperError('BAD_ARGS',
      `${container} 的 rootfs 是 ${spec.kind} 后端（${spec.path}），宿主上看不到它的挂载点，` +
      '所以文件操作要进容器里做 —— 但现在容器没在运行。',
      '先启动容器再从「文件」里看；或者用「备份」页的导出把整份 rootfs 打包出来。')
  }
  return { container, mode: 'attach', backend: spec.kind }
}

/** 进容器里跑一条命令，返回 Buffer（文件内容可能是二进制，不能走 utf8）。 */
function attachBuffer(container, argv, { input = null, timeoutMs = 30_000, maxBytes = FILE_LIMIT + 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child = null
    try {
      child = spawn('lxc-attach', ['-n', container, '--', ...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new HelperError('LXC_ERROR', `起不了 lxc-attach：${error?.message ?? error}`))
      return
    }
    const out = []
    const err = []
    let bytes = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      finish(new HelperError('TIMEOUT', `进容器执行超时（${argv[0]}）。`))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        finish(new HelperError('BAD_ARGS', '读出来的内容太大，已中止。', '大文件请用「终端」：tail / less。'))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      finish(new HelperError('LXC_ERROR', `lxc-attach 失败：${error?.message ?? error}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      finish(null, {
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    try {
      child.stdin.end(input ?? '')
    } catch { /* 命令不需要 stdin 就算了 */ }
  })
}

function normalizeRel(raw) {
  const text = String(raw ?? '/')
  if (!text.startsWith('/')) throw new HelperError('BAD_ARGS', '容器内路径要给绝对路径。')
  if (text.includes('\0')) throw new HelperError('BAD_ARGS', '路径里有 NUL 字节。')
  if (text.length > 4096) throw new HelperError('BAD_ARGS', '路径太长了。')
  const parts = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') throw new HelperError('BAD_ARGS', '路径里不许出现 ..（越界）。')
    parts.push(segment)
  }
  return { rel: '/' + parts.join('/'), parts }
}

function insideRoot(root, target) {
  if (target === root) return true
  return target.startsWith(root + '/')
}

/** 已经存在的路径：realpath 之后必须还在 rootfs 里（挡软链接逃逸）。 */
function resolveExisting(root, container, raw) {
  const { rel, parts } = normalizeRel(raw)
  const target = join(root, ...parts)
  let real = null
  try {
    real = realpathSync(target)
  } catch {
    throw new HelperError('NOT_FOUND', `容器 ${container} 里没有这个路径：${rel}`)
  }
  if (!insideRoot(root, real)) {
    throw new HelperError('BAD_ARGS', '这个路径通过软链接跑到 rootfs 外面了，拒绝访问。')
  }
  return { rel, real }
}

/** 还不存在的路径（新建文件 / 目录）：父目录必须存在且在 rootfs 里。 */
function resolveNew(root, container, raw) {
  const { rel, parts } = normalizeRel(raw)
  if (parts.length === 0) throw new HelperError('BAD_ARGS', '不能对根目录做这个操作。')
  const parentRel = '/' + parts.slice(0, -1).join('/')
  const parent = join(root, ...parts.slice(0, -1))
  let realParent = null
  try {
    realParent = realpathSync(parent)
  } catch {
    throw new HelperError('NOT_FOUND', `父目录不存在：${parentRel}`)
  }
  if (!insideRoot(root, realParent)) {
    throw new HelperError('BAD_ARGS', '父目录通过软链接跑到 rootfs 外面了，拒绝访问。')
  }
  const target = join(realParent, parts[parts.length - 1])
  try {
    const info = lstatSync(target)
    if (info.isSymbolicLink()) throw new HelperError('BAD_ARGS', '拒绝通过最终软链接写入。')
  } catch (error) {
    if (error instanceof HelperError) throw error
    if (error?.code !== 'ENOENT') throw error
  }
  return { rel, target }
}

// 进容器列目录用的脚本：路径从 $1 进，不拼字符串（文件名里有引号也不会被 shell 吃掉）。
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

function sortEntries(entries) {
  entries.sort((left, right) => {
    if (left.type === 'dir' && right.type !== 'dir') return -1
    if (right.type === 'dir' && left.type !== 'dir') return 1
    return left.name.localeCompare(right.name)
  })
  return entries
}

/** 网络排障：要跑命令，所以两种 rootfs 都走 attach；容器没在运行就明说。 */
async function diagnoseContainer(spec) {
  const backend = await backendOf(spec?.name)
  if (backend.mode === 'direct' && !(await isRunning(backend.container))) {
    throw new HelperError('BAD_ARGS',
      `${backend.container} 没在运行。诊断要在容器里跑命令，起它一下再来。`)
  }
  const script = buildDiagnoseScript({ host: spec?.host, port: spec?.port })
  const result = await attachBuffer(backend.container, ['sh', '-c', script], {
    timeoutMs: 60_000,
    maxBytes: 4 * 1024 * 1024,
  })
  const sections = parseDiagnoseOutput(result.stdout.toString('utf8'))
  if (sections.length === 0) {
    throw new HelperError('LXC_ERROR',
      result.stderr.trim() || '诊断命令没跑起来。',
      '容器得在运行中，并且里面有 /bin/sh。')
  }
  return {
    ...readDiagnose(sections, { host: spec?.host, port: spec?.port }),
    sections,
    mode: backend.mode,
  }
}

async function filesList(spec) {
  const backend = await backendOf(spec?.name)
  const { rel } = normalizeRel(spec?.path)
  if (backend.mode === 'direct') {
    const { real } = resolveExisting(backend.root, backend.container, spec?.path)
    let info = null
    try {
      info = statSync(real)
    } catch {
      throw new HelperError('NOT_FOUND', '读不到这个路径。')
    }
    if (!info.isDirectory()) throw new HelperError('BAD_ARGS', `这不是目录：${rel}`)
    const entries = []
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      const full = join(real, entry.name)
      let size = 0
      let mtime = null
      try {
        const item = lstatSync(full)
        size = item.size
        mtime = new Date(item.mtimeMs).toISOString()
      } catch {
        continue
      }
      entries.push({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
        size,
        mtime,
      })
    }
    return { name: backend.container, path: rel, mode: 'direct', entries: sortEntries(entries) }
  }

  const result = await attachBuffer(backend.container, ['sh', '-c', LIST_SCRIPT, 'sh', rel], {
    maxBytes: 4 * 1024 * 1024,
  })
  if (result.code !== 0 || /__CM_ERR__/.test(result.stdout.toString('utf8'))) {
    throw new HelperError('LXC_ERROR',
      result.stderr.trim() || `容器 ${backend.container} 里打不开这个目录：${rel}`,
      '目录不存在或没有读权限时会这样。')
  }
  const entries = []
  for (const line of result.stdout.toString('utf8').split('\n')) {
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
  return { name: backend.container, path: rel, mode: 'attach', entries: sortEntries(entries) }
}

async function filesRead(spec) {
  const backend = await backendOf(spec?.name)
  if (backend.mode === 'direct') {
    const { real, rel } = resolveExisting(backend.root, backend.container, spec?.path)
    const info = statSync(real)
    if (info.isDirectory()) throw new HelperError('BAD_ARGS', `这是个目录：${rel}`)
    if (info.size > FILE_LIMIT) {
      throw new HelperError('BAD_ARGS', `文件有 ${info.size} 字节，超过 8MB 上限，不在浏览器里打开。`,
        '要看大文件请用「终端」：tail -n 200 或 less。')
    }
    const data = readFileSync(real)
    return { name: backend.container, path: rel, mode: 'direct', size: data.length, base64: data.toString('base64') }
  }

  const { rel } = normalizeRel(spec?.path)
  const stat = await attachBuffer(backend.container, ['sh', '-c', 'stat -c %s -- "$1" 2>/dev/null || echo -', 'sh', rel], { timeoutMs: 15_000 })
  const size = Number(stat.stdout.toString('utf8').trim())
  if (!Number.isFinite(size)) {
    throw new HelperError('NOT_FOUND', `容器 ${backend.container} 里没有这个文件：${rel}`)
  }
  if (size > FILE_LIMIT) {
    throw new HelperError('BAD_ARGS', `文件有 ${size} 字节，超过 8MB 上限，不在浏览器里打开。`,
      '要看大文件请用「终端」：tail -n 200 或 less。')
  }
  const result = await attachBuffer(backend.container, ['cat', '--', rel], { timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || `读不出这个文件：${rel}`,
      '它可能是个目录，或者没有读权限。')
  }
  return {
    name: backend.container,
    path: rel,
    mode: 'attach',
    size: result.stdout.length,
    base64: result.stdout.toString('base64'),
  }
}

async function filesWrite(spec) {
  const data = spec?.base64 != null
    ? Buffer.from(String(spec.base64), 'base64')
    : Buffer.from(String(spec?.text ?? ''), 'utf8')
  if (data.length > FILE_LIMIT) throw new HelperError('BAD_ARGS', '内容超过 8MB，不在浏览器里写。')
  const backend = await backendOf(spec?.name)

  if (backend.mode === 'direct') {
    const { rel, target } = resolveNew(backend.root, backend.container, spec?.path)
    let fd = null
    try {
      fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644)
      let offset = 0
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset)
      }
      fsyncSync(fd)
    } catch (error) {
      throw new HelperError('LXC_ERROR', error?.message ?? '写文件失败。', '只读挂载、软链接或权限问题都会阻止写入。')
    } finally {
      if (fd !== null) closeSync(fd)
    }
    audit({ action: 'lxc.files.write', target: backend.container, path: rel, bytes: data.length, mode: 'direct' })
    return { name: backend.container, path: rel, mode: 'direct', bytes: data.length }
  }

  const { rel } = normalizeRel(spec?.path)
  const result = await attachBuffer(backend.container, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', rel], {
    input: data,
    timeoutMs: 60_000,
  })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || `写不进去：${rel}`,
      '父目录不存在、或者容器里那块是只读挂载。')
  }
  audit({ action: 'lxc.files.write', target: backend.container, path: rel, bytes: data.length, mode: 'attach' })
  return { name: backend.container, path: rel, mode: 'attach', bytes: data.length }
}

async function filesMkdir(spec) {
  const backend = await backendOf(spec?.name)
  if (backend.mode === 'direct') {
    const { rel, target } = resolveNew(backend.root, backend.container, spec?.path)
    try {
      mkdirSync(target, { recursive: true, mode: 0o755 })
    } catch (error) {
      throw new HelperError('LXC_ERROR', error?.message ?? '建目录失败。')
    }
    audit({ action: 'lxc.files.mkdir', target: backend.container, path: rel, mode: 'direct' })
    return { name: backend.container, path: rel, mode: 'direct', created: true }
  }
  const { rel } = normalizeRel(spec?.path)
  const result = await attachBuffer(backend.container, ['mkdir', '-p', '--', rel], { timeoutMs: 20_000 })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || `建不了目录：${rel}`)
  }
  audit({ action: 'lxc.files.mkdir', target: backend.container, path: rel, mode: 'attach' })
  return { name: backend.container, path: rel, mode: 'attach', created: true }
}

async function filesRemove(spec) {
  const backend = await backendOf(spec?.name)
  if (backend.mode === 'direct') {
    const { rel, real } = resolveExisting(backend.root, backend.container, spec?.path)
    if (real === backend.root) throw new HelperError('BAD_ARGS', '不能删 rootfs 根目录。')
    try {
      rmSync(real, { recursive: true, force: true })
    } catch (error) {
      throw new HelperError('LXC_ERROR', error?.message ?? '删除失败。')
    }
    audit({ action: 'lxc.files.remove', target: backend.container, path: rel, mode: 'direct' })
    return { name: backend.container, path: rel, mode: 'direct', removed: true }
  }
  const { rel, parts } = normalizeRel(spec?.path)
  if (parts.length === 0) throw new HelperError('BAD_ARGS', '不能删容器根目录。')
  const result = await attachBuffer(backend.container, ['rm', '-rf', '--', rel], { timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new HelperError('LXC_ERROR', result.stderr.trim() || `删不掉：${rel}`)
  }
  audit({ action: 'lxc.files.remove', target: backend.container, path: rel, mode: 'attach' })
  return { name: backend.container, path: rel, mode: 'attach', removed: true }
}

function cancelRun(id) {
  const key = String(id ?? '')
  const child = activeRuns.get(key)
  if (!child) return { id: key, cancelled: false }
  try { child.kill('SIGTERM') } catch { /* 已经退出 */ }
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经退出 */ } }, 5000).unref()
  audit({ action: 'lxc.run.cancel', id: key })
  return { id: key, cancelled: true }
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://lxcd')
  const path = url.pathname
  const method = String(req.method ?? 'GET').toUpperCase()

  if (method === 'GET' && path === '/health') {
    const version = await run('lxc-info', ['--version'], { timeoutMs: 10_000 })
    const net = await lxcNetStatus()
    return send(res, 200, ok({
      lxc: version.code === 0,
      version: (version.stdout || version.stderr).trim().split('\n')[0],
      macvlan: moduleLoaded('macvlan'),
      ipvlan: moduleLoaded('ipvlan'),
      lxcbr0: { name: net.name, subnet: net.subnet, up: net.up },
      root: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
      protocol: HELPER_PROTOCOL,
      socket: SOCKET,
      pid: process.pid,
    }))
  }

  if (method !== 'POST') return send(res, 405, fail('BAD_ARGS', '只支持 GET /health 与 POST 操作。'))
  if (String(req.headers['x-cm-helper'] ?? '') !== String(HELPER_PROTOCOL)) {
    return send(res, 400, fail('BAD_ARGS', 'helper 协议版本不匹配，请升级插件与 helper。'))
  }
  const body = await readBody(req)

  switch (path) {
    case '/lxc/list':
      return send(res, 200, ok(await listContainers()))
    case '/lxc/stats':
      return send(res, 200, ok(await statsAll()))
    case '/lxc/cancel':
      return send(res, 200, ok(cancelRun(body?.id)))
    case '/lxc/templates':
      return send(res, 200, ok(await listTemplates()))
    case '/lxc/images':
      return send(res, 200, ok(await listImageCache()))
    case '/lxc/images/delete':
      return send(res, 200, ok(await deleteImageCache(body?.name)))
    case '/lxc/storage':
      return send(res, 200, ok(await storageInfo()))
    case '/lxc/info': {
      const name = assertName(body?.name)
      const info = await containerInfo(name)
      try {
        info.settings = readLxcSettings(readConfig(name))
      } catch {
        info.settings = null
      }
      return send(res, 200, ok(info))
    }
    case '/lxc/logs':
      return send(res, 200, ok(await containerLogs(assertName(body?.name), body?.lines, body?.since)))
    case '/lxc/action':
      return send(res, 200, ok(await action(assertName(body?.name), String(body?.action ?? ''))))
    case '/lxc/create':
      return send(res, 200, ok(await createContainer(body ?? {})))
    case '/lxc/dhcp':
      return send(res, 200, ok(await configureDhcp(assertName(body?.name))))
    case '/lxc/net/get': {
      const name = assertName(body?.name)
      if (!containerExists(name)) throw new HelperError('NOT_FOUND', `没有这个容器：${name}`)
      const config = readConfig(name)
      return send(res, 200, ok({ name, nics: parseConfigNet(config), configPath: containerConfigPath(name), config }))
    }
    case '/lxc/net/set':
      return send(res, 200, ok(await setNetwork(assertName(body?.name), body?.nics, body?.restart !== false)))
    case '/lxc/resources':
      return send(res, 200, ok(await setResources(assertName(body?.name), body ?? {})))
    case '/lxc/config/set':
      return send(res, 200, ok(await setConfig(assertName(body?.name), body ?? {})))
    case '/lxc/snapshot/list':
      return send(res, 200, ok(await listSnapshots(body?.name)))
    case '/lxc/snapshot':
      return send(res, 200, ok(await snapshotOp(assertName(body?.name), String(body?.op ?? ''), body ?? {})))
    case '/lxc/clone':
      return send(res, 200, ok(await cloneContainer(body ?? {})))
    case '/lxc/diagnose':
      return send(res, 200, ok(await diagnoseContainer(body ?? {})))
    case '/lxc/files/list':
      return send(res, 200, ok(await filesList(body ?? {})))
    case '/lxc/files/read':
      return send(res, 200, ok(await filesRead(body ?? {})))
    case '/lxc/files/write':
      return send(res, 200, ok(await filesWrite(body ?? {})))
    case '/lxc/files/mkdir':
      return send(res, 200, ok(await filesMkdir(body ?? {})))
    case '/lxc/files/remove':
      return send(res, 200, ok(await filesRemove(body ?? {})))
    case '/lxc/export':
      return send(res, 200, ok(await exportContainer(body ?? {})))
    case '/lxc/export/list':
      return send(res, 200, ok(await listExports(body ?? {})))
    case '/lxc/export/delete':
      return send(res, 200, ok(await deleteExport(body ?? {})))
    case '/lxc/import':
      return send(res, 200, ok(await importContainer(body ?? {})))
    case '/lxc/mounts/get':
      return send(res, 200, ok(readMounts(assertName(body?.name))))
    case '/lxc/mounts/set':
      return send(res, 200, ok(await setMounts(assertName(body?.name), body?.mounts)))
    case '/net/list':
      return send(res, 200, ok({ bridges: [await lxcNetStatus()], host: await hostNetwork() }))
    case '/net/host':
      return send(res, 200, ok(await hostNetwork()))
    case '/net/bridge':
      return send(res, 200, ok(await ensureBridge(body ?? {})))
    case '/net/module':
      return send(res, 200, ok(await ensureModule(body?.name)))
    default:
      return send(res, 404, fail('NOT_FOUND', `没有这个接口：${method} ${path}`))
  }
}

function start() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    process.stderr.write('[dsh-lxcd] 警告：不是 root 运行，LXC 操作会失败。\n')
  }
  try {
    if (existsSync(SOCKET)) unlinkSync(SOCKET)
  } catch { /* 忽略 */ }
  mkdirSync(dirname(SOCKET), { recursive: true, mode: 0o770 })
  try {
    const dirGid = resolveGroupId(SOCKET_GROUP)
    if (dirGid !== null) chownSync(dirname(SOCKET), 0, dirGid)
    chmodSync(dirname(SOCKET), 0o770)
  } catch (error) {
    process.stderr.write('[dsh-lxcd] socket 目录权限设置失败：' + String(error && error.message ? error.message : error) + '\n')
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      const code = error instanceof HelperError ? error.code : 'INTERNAL'
      const message = error?.message ?? String(error)
      if (!(error instanceof HelperError)) {
        process.stderr.write(`[dsh-lxcd] ${error?.stack ?? message}\n`)
      }
      try {
        send(res, code === 'NOT_FOUND' ? 404 : code === 'BAD_ARGS' ? 400 : 500, fail(code, message, error?.hint))
      } catch { /* 响应已结束 */ }
    })
  })

  server.on('error', (error) => {
    process.stderr.write(`[dsh-lxcd] server error: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })

  server.listen(SOCKET, () => {
    try {
      chmodSync(SOCKET, 0o660)
      const gid = resolveGroupId(SOCKET_GROUP)
      if (gid !== null) chownSync(SOCKET, 0, gid)
    } catch (error) {
      process.stderr.write(`[dsh-lxcd] socket 权限设置失败：${error?.message ?? error}\n`)
    }
    process.stdout.write(`[dsh-lxcd] listening on ${SOCKET} (root=${process.getuid?.()})\n`)
  })

  const shutdown = () => {
    server.close(() => {
      try {
        if (existsSync(SOCKET)) unlinkSync(SOCKET)
      } catch { /* 忽略 */ }
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

function resolveGroupId(name) {
  try {
    const passwd = readFileSync('/etc/passwd', 'utf8')
    for (const line of passwd.split('\n')) {
      const parts = line.split(':')
      if (parts[0] === name && parts[3]) return Number(parts[3])
    }
  } catch { /* 忽略 */ }
  return 1001
}

start()
