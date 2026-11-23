/**
 * 镜像更新检测：本地镜像的 digest 和仓库里 tag 现在指向的 digest 比。
 *
 * 为什么只认 skopeo 给的 digest —— 这一条是拿真机验出来的，别改回去：
 *  - podman 的 `.Digest` 存的是 tag 指向的**顶层 digest**（多架构时就是 index digest）。
 *    实测：docker.io/library/alpine:3.22 本地 .Digest 与 registry 的 Docker-Content-Digest 完全一致。
 *  - `podman manifest inspect` 给的是**各平台条目**的 digest，跟顶层 digest 本来就不是一个东西；
 *    拿它比会把所有镜像都判成「有新版」（真踩过：3 个镜像全 stale，其实全都是最新）。
 *  - `skopeo inspect --format {{.Digest}}` 给的正是 Docker-Content-Digest，可以直接比。
 *  - 没装 skopeo 时 podman 4.3 拿不到可比的远端 digest —— 那是 unknown，不是 fresh。
 *
 * 纯逻辑在这里，跑命令由调用方注入，方便测试。
 */

export const SKOPEO_HINT = '装上 skopeo 就能比：Debian / Ubuntu 用 sudo apt install skopeo，Fedora 用 sudo dnf install skopeo。'

/** 本地/远端 digest 是否一致。返回 current / stale / unknown 加一句原因。 */
export function compareDigests(local, remote) {
  const left = String(local ?? '').trim()
  const right = String(remote ?? '').trim()
  if (!left || left === '<none>') {
    return { state: 'unknown', reason: '本地镜像没有 digest（自己 build 的镜像一般没有），比不了。' }
  }
  if (!right || right === '<none>') {
    return { state: 'unknown', reason: '没问到仓库的 digest。' }
  }
  const normalize = value => value.replace(/^sha256:/, '').trim()
  if (normalize(left) === normalize(right)) return { state: 'current', reason: null }
  return { state: 'stale', reason: '仓库里这个 tag 指向的 digest 变了，有新版。' }
}

/**
 * 查这些镜像有没有更新。
 * @param {{ images: Array<{reference?: string}>, run: (command: string, args: string[]) => Promise<{code:number, stdout:string, stderr:string}>, hasSkopeo: boolean, limit?: number }} input
 */
export async function checkImageUpdates({ images, run, hasSkopeo, limit = 12 }) {
  const list = (images || []).filter(image => {
    const reference = String(image.reference ?? '')
    if (!reference || reference.startsWith('<none>')) return false
    // 自己 build 的 localhost/ 镜像不去问仓库（问了也是问一个不存在的仓库）
    if (reference.startsWith('localhost/')) return false
    return true
  })
  const picked = list.slice(0, Math.max(1, Number(limit) || 12))
  const items = []
  for (const image of picked) {
    const reference = String(image.reference)
    const local = await run('podman', ['image', 'inspect', reference, '--format', '{{.Digest}}'])
    const localDigest = local.code === 0 ? String(local.stdout || '').trim() : ''
    if (!localDigest || localDigest === '<none>') {
      items.push({
        reference,
        localDigest: null,
        remoteDigest: null,
        state: 'unknown',
        reason: '本地镜像没有 digest（自己 build 的镜像一般没有），比不了。',
      })
      continue
    }
    if (!hasSkopeo) {
      items.push({
        reference,
        localDigest,
        remoteDigest: null,
        state: 'unknown',
        reason: '没装 skopeo，问不到仓库现在指向哪个 digest。' + SKOPEO_HINT,
      })
      continue
    }
    const remote = await run('skopeo', ['inspect', '--format', '{{.Digest}}', 'docker://' + reference])
    const remoteDigest = remote.code === 0 ? String(remote.stdout || '').trim() : ''
    if (remote.code !== 0) {
      // 问不到就是问不到：把 skopeo 的最后一句话原样转述，别用「没问到 digest」糊过去
      const detail = String(remote.stderr || '').trim().split('\n').filter(Boolean).pop() || '没有输出'
      items.push({
        reference,
        localDigest,
        remoteDigest: null,
        state: 'unknown',
        reason: '问仓库失败：' + detail,
      })
      continue
    }
    const verdict = compareDigests(localDigest, remoteDigest)
    items.push({
      reference,
      localDigest,
      remoteDigest: remoteDigest || null,
      state: verdict.state,
      reason: verdict.reason,
    })
  }
  return {
    items,
    checked: picked.length,
    skipped: list.length - picked.length,
    hasSkopeo: Boolean(hasSkopeo),
    stale: items.filter(item => item.state === 'stale').length,
    unknown: items.filter(item => item.state === 'unknown').length,
  }
}
