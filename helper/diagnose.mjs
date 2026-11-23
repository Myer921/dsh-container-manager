/**
 * 容器内网络排障：步骤表 + 生成脚本 + 结果解析 + 判读。
 *
 * 插件侧（Podman 走 podman exec）与 helper 侧（LXC 走 lxc-attach）共用这一份 ——
 * 「诊断」这种东西一旦两边各写一套，很快就变成两个答案。
 *
 * 只跑只读命令（ip / cat / getent / ping / nc），不改容器里的任何东西。
 */

/** 主机名 / IP 的白名单：这些值要拼进 shell 脚本，不能带引号与分号。 */
export function assertDiagTarget(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new Error('目标只能由字母、数字、点、下划线、冒号、连字符组成：' + text)
  }
  return text
}

const DEFAULT_TARGET = '1.1.1.1'

export const DIAG_STEPS = [
  // 不用 ip 的 -brief：BusyBox 的精简 ip 不认这个选项，会把用法说明当结果打出来。
  { id: 'ifaces', label: '网卡与地址', bin: 'ip', cmd: 'ip addr' },
  { id: 'routes', label: '路由表', bin: 'ip', cmd: 'ip route' },
  { id: 'resolv', label: 'DNS 配置', bin: 'cat', cmd: 'cat /etc/resolv.conf' },
  { id: 'hosts', label: 'hosts', bin: 'cat', cmd: 'cat /etc/hosts' },
  { id: 'resolve', label: '域名解析', bin: 'getent', cmd: 'getent hosts {host}' },
  { id: 'ping', label: 'ICMP 连通', bin: 'ping', cmd: 'ping -c 2 -W 2 {host}' },
  // 不用 nc -z：BusyBox 的 nc 不一定有 -z。改成「连上就退出、连不上就自己说一句」，
  // 这样成功=没输出、失败=一句话，两边都读得懂。
  { id: 'tcp', label: 'TCP 连通', bin: 'nc', cmd: 'nc -w 3 {host} {port} < /dev/null 2>&1 || echo "连不上 {host}:{port}（nc exit $?）"' },
]

/**
 * 打成一个 sh -c 脚本：每段以 @@cm:<id> 开头，宿主侧按标记切。
 * 容器里缺命令时明说「容器里没有 xxx」，而不是留一片空白让人以为结果是空的。
 */
export function buildDiagnoseScript({ host = DEFAULT_TARGET, port = 443 } = {}) {
  const target = assertDiagTarget(host) || DEFAULT_TARGET
  const numeric = Number(port)
  const tcpPort = Number.isFinite(numeric) && numeric > 0 && numeric < 65536 ? Math.floor(numeric) : 443
  const lines = []
  for (const step of DIAG_STEPS) {
    const command = step.cmd.replaceAll('{host}', target).replaceAll('{port}', String(tcpPort))
    lines.push(`echo "@@cm:${step.id}"`)
    lines.push(`if command -v ${step.bin} >/dev/null 2>&1; then ${command} 2>&1 | head -c 40000; else echo "(容器里没有 ${step.bin})"; fi`)
  }
  // 容器里可能没有 ip 但装了 iptables；反过来也一样。这一步单独兜：看有没有网络命名空间限制的迹象。
  lines.push('echo "@@cm:end"')
  return lines.join('\n')
}

/** 把脚本输出切成 { id: text }。 */
export function parseDiagnoseOutput(raw) {
  const text = String(raw ?? '')
  const out = []
  let current = null
  for (const line of text.split('\n')) {
    const marker = /^@@cm:([a-z]+)$/.exec(line.trim())
    if (marker) {
      if (current) out.push(current)
      current = { id: marker[1], lines: [] }
      continue
    }
    if (!current) continue
    current.lines.push(line)
  }
  if (current) out.push(current)
  return out
    .filter(item => item.id !== 'end')
    .map(item => ({
      id: item.id,
      label: (DIAG_STEPS.find(step => step.id === item.id) || {}).label || item.id,
      text: item.lines.join('\n').trim(),
    }))
}

/**
 * 网卡判读：认 `ip addr` 的接口行格式 —— `1: lo: <LOOPBACK,UP,LOWER_UP> mtu ...`。
 *
 * 为什么要解析 flags 而不是 grep "UP"：BusyBox 的 ip 不认 -brief，会把用法说明打出来，
 * 说明里有 "up|down" 字样；拿字符串当信号会得出「有网卡 DOWN」这种假故障。
 */
export function judgeIfaces(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return [{ level: 'unknown', text: '拿不到网卡信息（这段没有输出）。' }]
  if (/^\(容器里没有 ip\)$/m.test(raw.trim())) {
    return [{ level: 'unknown', text: '容器里没有 ip 命令，看不到网卡与路由。' }]
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const match = /^\d+:\s+([^:]+?):\s+<([^>]*)>/.exec(line.trim())
    if (!match) continue
    rows.push({ name: match[1], flags: match[2].split(',').map(flag => flag.trim()) })
  }
  if (rows.length === 0) {
    if (/BusyBox|Usage: ip/i.test(raw)) {
      return [{ level: 'unknown', text: '这个容器的 ip 是精简版，输出认不出来；用「终端」跑 ip addr 看。' }]
    }
    return [{ level: 'unknown', text: '网卡输出认不出来，没敢下判断。' }]
  }
  const physical = rows.filter(row => row.name !== 'lo')
  const upCount = physical.filter(row => row.flags.includes('UP')).length
  if (physical.length === 0) return [{ level: 'ok', text: '只有 lo（回环），这个容器没有接网络。' }]
  if (upCount === 0) {
    return [{ level: 'warn', text: '没有一块网卡是 UP —— 容器等于没联网。' }]
  }
  const down = physical.filter(row => !row.flags.includes('UP')).map(row => row.name)
  if (down.length > 0) {
    return [{ level: 'warn', text: '这些网卡是 DOWN：' + down.join(', ') }]
  }
  return [{ level: 'ok', text: upCount + ' 块网卡 UP。' }]
}

/**
 * 判读：只给「从这段输出里能确定的事」，拿不准的一句不写。
 * 返回值里每条都带 level：ok / warn / unknown。
 */
export function readDiagnose(sections, { host = DEFAULT_TARGET, port = 443 } = {}) {
  const byId = new Map(sections.map(item => [item.id, item.text]))
  const notes = []
  const routes = byId.get('routes') || ''
  const resolv = byId.get('resolv') || ''
  const ifaces = byId.get('ifaces') || ''

  notes.push(...judgeIfaces(ifaces))

  if (routes && !/^default\s/m.test(routes + '\n')) {
    notes.push({ level: 'warn', text: '路由表里没有 default —— 出不了容器所在网段。' })
  }

  if (resolv.includes('127.0.0.53')) {
    notes.push({ level: 'warn', text: 'DNS 指向 127.0.0.53（宿主上的 systemd-resolved 桩），容器里通常没有它 —— 解析会失败。' })
  }
  const nameservers = (resolv.match(/^nameserver\s+(\S+)/gm) || []).length
  if (resolv && nameservers === 0 && !resolv.includes('127.0.0.53')) {
    notes.push({ level: 'warn', text: '/etc/resolv.conf 里没有 nameserver。' })
  }

  const resolve = byId.get('resolve') || ''
  if (resolve && !/^\(容器里没有/.test(resolve) && !/\S+\s+(\S+)$/.test(resolve.trim())) {
    notes.push({ level: 'warn', text: '解析 ' + host + ' 没有结果。' })
  }

  const tcp = (byId.get('tcp') || '').trim()
  if (/^\(容器里没有 nc\)/.test(tcp)) {
    notes.push({ level: 'unknown', text: '容器里没有 nc，TCP 连通性没测成。' })
  } else if (!tcp) {
    notes.push({ level: 'ok', text: '连 ' + host + ':' + port + ' 通了（nc 没有报错）。' })
  } else if (/连不上|refused|timed out|unreachable|No route/i.test(tcp)) {
    notes.push({ level: 'warn', text: '连 ' + host + ':' + port + ' 没通：' + tcp.split('\n')[0].slice(0, 100) })
  } else if (/invalid option|Usage|unrecognized/i.test(tcp)) {
    notes.push({ level: 'unknown', text: '容器里的 nc 不支持这种连法，TCP 没测成。' })
  } else {
    notes.push({ level: 'ok', text: '连 ' + host + ':' + port + ' 有回应：' + tcp.split('\n')[0].slice(0, 100) })
  }

  return { notes, target: { host, port: Number(port) || 443 } }
}
