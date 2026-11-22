/**
 * 端口预检（v0.3.0，grill Q10）
 *
 * 起因是一个真实事故：compose 里写的 18080 被宿主一个 python 进程占着，
 * podman-compose 不会报「端口冲突」，容器会卡在 Created，然后 down 还要等 10 秒 SIGKILL。
 * 用户看到的是「点了没反应」。所以 up 之前先把端口扫一遍。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 项目里所有需要在宿主上监听的端口。host 网络的服务等于直接用宿主端口，不需要发布。 */
export function hostPorts(project) {
  const out = []
  for (const service of project.services) {
    if (service.networkMode === 'host') {
      for (const port of service.ports) {
        if (!port.parsed || port.hostPort === null) continue
        out.push({ service: service.name, port: port.hostPort, protocol: port.protocol, ip: 'host-network', raw: port.raw })
      }
      continue
    }
    for (const port of service.ports) {
      if (!port.parsed || port.hostPort === null) continue
      const span = port.range ? port.hostPortEnd - port.hostPort : 0
      for (let step = 0; step <= span; step += 1) {
        out.push({
          service: service.name,
          port: port.hostPort + step,
          protocol: port.protocol,
          ip: port.hostIp || '*',
          raw: port.raw,
        })
      }
    }
  }
  return out
}

function portFromAddress(address) {
  const trimmed = String(address).replace(/%[^:]*$/, '')
  const cut = trimmed.lastIndexOf(':')
  if (cut < 0) return null
  const value = Number(trimmed.slice(cut + 1))
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : null
}

/**
 * 解析 ss -lntuHp 的输出。
 * 一行形如：LISTEN 0 4096 0.0.0.0:18080 0.0.0.0:* users:(("python3",pid=888,fd=21))
 */
export function parseSsListeners(text) {
  const listeners = new Map()
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const fields = trimmed.split(/\s+/)
    if (fields.length < 5) continue
    // ss 的列序是 State / Recv-Q / Send-Q / Local / Peer / Process，
    // 本地地址在下标 3 —— 拿下标 4 会读到对端，永远是 *，于是「冲突」永远查不出来。
    const state = fields[0].toUpperCase()
    const protocol = state === 'UNCONN' ? 'udp' : 'tcp'
    const port = portFromAddress(fields[3])
    if (port === null) continue
    const ownerMatch = /users:\(\((?:"([^"]+)",pid=(\d+))?/.exec(trimmed)
    const owner = ownerMatch && ownerMatch[1] ? { name: ownerMatch[1], pid: Number(ownerMatch[2]) } : null
    const key = port + '/' + protocol
    if (!listeners.has(key)) listeners.set(key, [])
    listeners.get(key).push(owner)
  }
  return listeners
}

async function defaultListeners() {
  const result = await execFileAsync('ss', ['-lntuHp'], { timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 })
  return parseSsListeners(result.stdout)
}

/**
 * @returns {{supported:boolean, conflicts:Array, detail?:string}}
 */
export async function checkPortConflicts(project, { exec = defaultListeners } = {}) {
  const wanted = hostPorts(project)
  if (wanted.length === 0) return { supported: true, conflicts: [] }
  let listeners
  try {
    listeners = await exec()
  } catch (error) {
    return {
      supported: false,
      conflicts: [],
      detail: '读不到宿主监听端口（ss 不可用）：' + String(error && (error.code || error.message) || error),
    }
  }
  const conflicts = []
  for (const item of wanted) {
    const key = item.port + '/' + item.protocol
    const owners = listeners.get(key)
    if (!owners) continue
    const owner = owners.find(entry => entry) || null
    conflicts.push({
      port: item.port,
      protocol: item.protocol,
      service: item.service,
      ip: item.ip,
      raw: item.raw,
      owner,
    })
  }
  return { supported: true, conflicts }
}

/** 冲突 → 一句人话。 */
export function describeConflict(conflict) {
  const who = conflict.owner && conflict.owner.name
    ? conflict.owner.name + '（pid ' + conflict.owner.pid + '）'
    : '别的进程'
  return '端口 ' + conflict.port + '/' + conflict.protocol + ' 已被 ' + who + ' 占着，服务 ' + conflict.service + ' 起不来。'
}
