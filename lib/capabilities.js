/**
 * 能力探针
 *
 * 菜单要按能力出，不能按愿望出：宿主没装 btrfs 却给一个「秒级快照」按钮，
 * 点下去等四分钟再报错 —— 那种体验比根本没有这个按钮更糟。
 *
 * 三条自我约束：
 *  1. 只读：不装包、不改 /etc、不碰 cgroup。
 *  2. 探不到就写 unknown + 原因，绝不把「我不知道」写成「不支持」。
 *  3. 60 秒缓存：这页会被反复点开，别每次都去 spawn 五个进程。
 */

import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

import { execFileAsync, safeJson } from './util.js'

const CACHE_MS = 60_000
const BINARIES = [
  'podman', 'newuidmap', 'newgidmap', 'fuse-overlayfs', 'pasta', 'slirp4netns',
  'skopeo', 'btrfs', 'zfs', 'lvcreate', 'systemctl', 'loginctl', 'lxc-create', 'lxc-export',
]

function defaultUser() {
  try {
    const info = userInfo()
    return { name: info.username, uid: info.uid }
  } catch {
    return { name: 'unknown', uid: null }
  }
}

/** 一次 spawn 问清所有命令在不在，省得为每个工具开一个进程。 */
function whichScript(names) {
  const body = names
    .map(name => 'if command -v ' + name + ' >/dev/null 2>&1; then echo "' + name + '=1"; else echo "' + name + '=0"; fi')
    .join('; ')
  return body
}

function parseWhich(stdout) {
  const out = {}
  for (const line of String(stdout || '').split('\n')) {
    const match = /^([a-z0-9-]+)=([01])$/.exec(line.trim())
    if (match) out[match[1]] = match[2] === '1'
  }
  for (const name of BINARIES) if (!(name in out)) out[name] = false
  return out
}

/** /etc/subuid、/etc/subgid 里属于当前用户的那几行。 */
function subIdLines(text, user) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [name, start, count] = trimmed.split(':')
    if (name !== user) continue
    out.push({ start: String(start || ''), count: String(count || '') })
  }
  return out
}

export function createCapabilityProbe(options = {}) {
  const {
    ttlMs = CACHE_MS,
    exec = execFileAsync,
    readFile = file => readFileSync(file, 'utf8'),
    exists = file => existsSync(file),
    user = defaultUser(),
    now = () => Date.now(),
  } = options

  const cache = new Map()

  async function collect(node) {
    const id = node && node.id ? node.id : 'local'
    const kind = node && node.kind === 'lxc' ? 'lxc' : 'podman'
    const transport = node && node.transport ? node.transport : 'local'

    if (transport === 'ssh') {
      return {
        node: id, kind, ok: false, scoped: 'local', at: now(),
        reason: '这个节点在远端（ssh），能力探针目前只支持本机。要看本机能力请切回 local 节点。',
        checks: [],
      }
    }

    const [whichResult, infoResult, lingerResult] = await Promise.all([
      exec('/bin/sh', ['-c', whichScript(BINARIES)], { timeoutMs: 8000 }),
      kind === 'podman' ? exec('podman', ['info', '--format', 'json'], { timeoutMs: 15_000 }) : Promise.resolve(null),
      exec('loginctl', ['show-user', user.name, '--property=Linger'], { timeoutMs: 5000 }),
    ])

    const tools = parseWhich(whichResult && whichResult.stdout)
    const info = infoResult && infoResult.code === 0 ? safeJson(infoResult.stdout, null) : null
    const linger = /Linger=yes/.test(String((lingerResult && lingerResult.stdout) || ''))

    let subuid = []
    let subgid = []
    try { subuid = subIdLines(readFile('/etc/subuid'), user.name) } catch { subuid = [] }
    try { subgid = subIdLines(readFile('/etc/subgid'), user.name) } catch { subgid = [] }

    const cgroupV2 = exists('/sys/fs/cgroup/cgroup.controllers')
    const podman = info
      ? {
        version: String((info.version && info.version.Version) || ''),
        rootless: Boolean(info.host && info.host.security && info.host.security.rootless),
        cgroupManager: String((info.host && info.host.cgroupManager) || ''),
        cgroupVersion: String((info.host && info.host.cgroupVersion) || ''),
        graphDriver: String((info.store && info.store.graphDriverName) || ''),
        networkBackend: String((info.host && info.host.networkBackend) || ''),
        uidMap: Array.isArray(info.host && info.host.idMappings && info.host.idMappings.uidmap)
          ? info.host.idMappings.uidmap.length : 0,
        gidMap: Array.isArray(info.host && info.host.idMappings && info.host.idMappings.gidmap)
          ? info.host.idMappings.gidmap.length : 0,
      }
      : null

    const checks = []
    const add = (id2, label, state, detail, fix) => checks.push({ id: id2, label, state, detail, fix: fix || null })

    if (kind === 'podman') {
      if (podman) {
        add('podman', 'Podman 可用', 'ok', 'podman ' + (podman.version || '?')
          + '，' + (podman.rootless ? 'rootless' : 'rootful')
          + (podman.graphDriver ? '，存储驱动 ' + podman.graphDriver : ''))
      } else {
        add('podman', 'Podman 可用', 'missing', 'podman info 读不到（没装或不可执行）', '装 podman 后重试')
      }
      if (podman && podman.rootless) {
        if (subuid.length > 0 && subgid.length > 0) {
          add('subid', '用户 ID 映射区间', 'ok', '/etc/subuid 与 /etc/subgid 都有 ' + user.name + ' 的区间')
        } else {
          add('subid', '用户 ID 映射区间', 'missing',
            '/etc/subuid 或 /etc/subgid 里没有 ' + user.name + ' 的行，rootless 容器会起不来',
            'sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ' + user.name)
        }
        if (tools.newuidmap && tools.newgidmap) {
          add('uidmap', 'newuidmap / newgidmap', 'ok', 'uidmap 包已安装')
        } else {
          add('uidmap', 'newuidmap / newgidmap', 'missing', '缺 uidmap 包，rootless 的多 ID 映射用不了',
            'sudo apt install uidmap（或对应发行版的包名）')
        }
        if (podman.graphDriver === 'vfs') {
          add('driver', '存储驱动', 'degraded', '正在用 vfs：每层整份复制，慢且吃盘',
            tools.fuseOverlayfs ? '装好 fuse-overlayfs 后把 storage.conf 的 driver 换成 overlay'
              : '先装 fuse-overlayfs，再把 storage.conf 的 driver 换成 overlay')
        } else {
          add('driver', '存储驱动', 'ok', '存储驱动 ' + (podman.graphDriver || '未知'))
        }
      }
      if (tools.pasta || tools.slirp4netns) {
        add('netns', 'rootless 网络栈', 'ok', tools.pasta ? 'pasta 可用' : 'slirp4netns 可用')
      } else {
        add('netns', 'rootless 网络栈', 'missing', '既没有 pasta 也没有 slirp4netns，rootless 容器连不上外网',
          'sudo apt install passt（推荐）或 slirp4netns')
      }
    }

    if (cgroupV2) {
      add('cgroup', 'cgroup 版本', 'ok', 'v2（统一层级）')
    } else {
      add('cgroup', 'cgroup 版本', 'degraded', '没有 /sys/fs/cgroup/cgroup.controllers，像是 v1 或未挂载',
        'cgroup v1 下内存与 CPU 限制的行为和 v2 不同，限制可能不生效')
    }

    if (linger) {
      add('linger', '用户 linger', 'ok', '已开启：注销后 user 单元继续跑')
    } else {
      add('linger', '用户 linger', 'degraded', '没开 linger：注销登录后 user systemd 单元会被停掉，Quadlet 起的容器也跟着停',
        'loginctl enable-linger ' + user.name)
    }

    if (tools.btrfs || tools.zfs || tools.lvcreate) {
      const list = []
      if (tools.btrfs) list.push('btrfs')
      if (tools.zfs) list.push('zfs')
      if (tools.lvcreate) list.push('lvm')
      add('storage', 'LXC 存储后端', 'ok', '可用：dir（永远可用）、' + list.join('、'),
        null)
    } else {
      add('storage', 'LXC 存储后端', 'degraded', '只有 dir 可用（每容器一个 loop img，快照是整份复制）',
        '装 btrfs-progs 或 zfs 后可用秒级快照')
    }

    if (tools.skopeo) {
      add('skopeo', '镜像远端比对', 'ok', 'skopeo 可用，能查 registry 上的 digest')
    } else {
      add('skopeo', '镜像远端比对', 'degraded', '没装 skopeo：问不到仓库 tag 现在指向的 digest，镜像更新检测只能是 unknown（manifest inspect 不比顶层 digest，拿它比会全判成有新版）',
        'sudo apt install skopeo')
    }

    if (tools['lxc-export']) {
      add('lxc-export', 'LXC 导出', 'ok', 'lxc-export 可用')
    } else {
      add('lxc-export', 'LXC 导出', 'unknown', '没找到 lxc-export，导出功能会直接报错而不是静默降级',
        '装 lxc 工具包（lxc-export 通常随 lxc 一起）')
    }

    return {
      node: id,
      kind,
      ok: true,
      scoped: 'local',
      at: now(),
      user: { name: user.name, uid: user.uid, linger, subuid, subgid },
      podman,
      tools,
      cgroup: { version: cgroupV2 ? '2' : '1' },
      lxcBackends: ['dir'].concat(tools.btrfs ? ['btrfs'] : [], tools.zfs ? ['zfs'] : [], tools.lvcreate ? ['lvm'] : []),
      checks,
    }
  }

  return {
    /** 探测一个节点的能力；同一节点 60 秒内复用结果。 */
    async probe(node) {
      const id = node && node.id ? node.id : 'local'
      const cached = cache.get(id)
      if (cached && now() - cached.at < ttlMs) return cached.value
      const value = await collect(node)
      cache.set(id, { at: now(), value })
      return value
    },
    /** 只清缓存，不重新探测（改配置后用）。 */
    invalidate() {
      cache.clear()
    },
  }
}
