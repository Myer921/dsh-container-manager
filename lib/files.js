/**
 * 容器内文件浏览 / 读写
 *
 * 两条完全不同的路：
 *  - LXC：容器的 rootfs 就在宿主上（/var/lib/lxc/<名字>/rootfs），helper 以 root 直接读写，
 *         所以停着也能改 —— 这是 LXC 天然的便宜。
 *  - Podman：rootless 下容器文件系统在用户命名空间里，宿主上看不到，只能
 *         `podman cp` 走 tar 流。cp 对停止的容器也有效；**列目录要 exec，所以必须运行中**。
 *
 * 安全边界（三条都必须做，少一条就是路径穿越）：
 *  1. 进来就规整成绝对路径，拒绝 ..、拒绝 NUL、拒绝超长；
 *  2. LXC 侧 helper 再用 realpath 确认最终落在 rootfs 里面（软链接逃逸就靠这条挡）；
 *  3. 单次读写有上限，超了直接拒绝 —— 别把一个 8G 的日志文件读进内存。
 */

import { CmError, ERR } from './util.js'

/** 一次读写的内容上限：8MB。再大就不该在浏览器里编辑了。 */
export const FILE_LIMIT_BYTES = 8 * 1024 * 1024
/** 一屏最多列这么多条，再多就该用终端了。 */
export const FILE_LIST_LIMIT = 2000

const PATH_MAX = 4096

/**
 * 容器内绝对路径校验。
 * @param {string} raw
 * @returns {string} 归一化后的绝对路径
 */
export function assertContainerPath(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new CmError(ERR.BAD_ARGS, '需要容器内路径。')
  if (text.length > PATH_MAX) throw new CmError(ERR.BAD_ARGS, '路径太长了。')
  if (text.includes('\0')) throw new CmError(ERR.BAD_ARGS, '路径里有 NUL 字节。')
  if (!text.startsWith('/')) throw new CmError(ERR.BAD_ARGS, '容器内路径要给绝对路径。')
  const parts = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') throw new CmError(ERR.BAD_ARGS, '路径里不许出现 ..（越界）。')
    parts.push(segment)
  }
  return '/' + parts.join('/')
}

/** 文件名：单段、不许带斜杠、不许 . 与 .. */
export function assertFileName(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new CmError(ERR.BAD_ARGS, '需要文件名。')
  if (text === '.' || text === '..') throw new CmError(ERR.BAD_ARGS, '文件名不能是 . 或 ..')
  if (text.includes('/')) throw new CmError(ERR.BAD_ARGS, '文件名里不能有斜杠。')
  if (text.includes('\0')) throw new CmError(ERR.BAD_ARGS, '文件名里有 NUL 字节。')
  if (Buffer.byteLength(text) > 100) throw new CmError(ERR.BAD_ARGS, '文件名超过 100 字节（ustar 头放不下）。')
  return text
}

/** 父目录 / 名字拆开，写文件时要用。 */
export function splitContainerPath(path) {
  // 结尾带斜杠是「这是目录」的明确写法，当文件路径用一定是调用方搞错了。
  if (String(path ?? '').trim().endsWith('/') && String(path ?? '').trim() !== '/') {
    throw new CmError(ERR.BAD_ARGS, '这是目录写法（结尾有斜杠），不是文件路径。')
  }
  const normalized = assertContainerPath(path)
  const at = normalized.lastIndexOf('/')
  const dir = at <= 0 ? '/' : normalized.slice(0, at)
  const name = normalized.slice(at + 1)
  if (!name) throw new CmError(ERR.BAD_ARGS, '这是一个目录，不是文件路径。')
  return { dir, name: assertFileName(name) }
}

/** 看起来是文本吗：前 8KB 里没有 NUL 就当文本。 */
export function looksLikeText(buffer) {
  const probe = Buffer.isBuffer(buffer) ? buffer.subarray(0, 8192) : Buffer.from(String(buffer ?? ''), 'utf8')
  return !probe.includes(0)
}

/**
 * 文件服务：API 与 AI 工具共用。校验在这里做一次，驱动只管干活。
 */
export function createFileService({ registry }) {
  function driverFor(node) {
    const entry = registry.find(node)
    if (!entry) throw new CmError(ERR.NOT_FOUND, `没有这个节点：${node}`)
    const driver = registry.driverFor(entry)
    for (const method of ['filesList', 'filesRead', 'filesWrite', 'filesMkdir', 'filesRemove']) {
      if (typeof driver[method] !== 'function') {
        throw new CmError(ERR.BAD_ARGS, `这个节点的驱动还不支持文件操作（缺 ${method}）。`)
      }
    }
    return driver
  }

  return {
    async list({ node, ref, path }) {
      const normalized = assertContainerPath(path)
      const result = await driverFor(node).filesList(String(ref), normalized)
      const entries = Array.isArray(result.entries) ? result.entries : []
      return {
        node,
        ref: String(ref),
        path: normalized,
        parent: normalized === '/' ? null : (normalized.slice(0, normalized.lastIndexOf('/')) || '/'),
        entries: entries.slice(0, FILE_LIST_LIMIT),
        truncated: entries.length > FILE_LIST_LIMIT || Boolean(result.truncated),
        // direct = 直接读宿主上的 rootfs（停着也能看）；attach = rootfs 是镜像/子卷，进容器里读（要运行中）
        mode: result.mode ?? null,
        detail: result.detail ?? null,
      }
    },

    /** 读一个文件；文本直接给 text，二进制给 base64，并标明是哪种。 */
    async read({ node, ref, path, maxBytes = FILE_LIMIT_BYTES }) {
      const normalized = assertContainerPath(path)
      const limit = Math.max(1024, Math.min(FILE_LIMIT_BYTES, Number(maxBytes) || FILE_LIMIT_BYTES))
      const result = await driverFor(node).filesRead(String(ref), normalized, { maxBytes: limit })
      const data = Buffer.isBuffer(result.data) ? result.data : Buffer.from(String(result.data ?? ''), 'utf8')
      if (data.length > limit) {
        throw new CmError(ERR.BAD_ARGS,
          `文件有 ${data.length} 字节，超过 ${limit} 字节上限，不在浏览器里打开。`,
          '要看大文件请用「终端」：tail -n 200 或 less。')
      }
      const binary = result.binary === true || !looksLikeText(data)
      return {
        node,
        ref: String(ref),
        path: normalized,
        name: normalized.slice(normalized.lastIndexOf('/') + 1),
        size: data.length,
        binary,
        text: binary ? null : data.toString('utf8'),
        base64: binary ? data.toString('base64') : null,
        truncated: Boolean(result.truncated),
      }
    },

    /** 写文件：文本按 utf8 存，base64 就按原始字节存。 */
    async write({ node, ref, path, text = null, base64 = null }) {
      const normalized = assertContainerPath(path)
      const { name } = splitContainerPath(normalized)
      const data = base64 != null ? Buffer.from(String(base64), 'base64') : Buffer.from(String(text ?? ''), 'utf8')
      if (data.length > FILE_LIMIT_BYTES) {
        throw new CmError(ERR.BAD_ARGS, '内容超过 8MB，不在浏览器里写。', '大文件请用容器内的工具（scp / curl / dd）处理。')
      }
      const result = await driverFor(node).filesWrite(String(ref), normalized, data, { name })
      return { ...result, node, ref: String(ref), path: normalized, bytes: data.length }
    },

    async mkdir({ node, ref, path }) {
      const normalized = assertContainerPath(path)
      const result = await driverFor(node).filesMkdir(String(ref), normalized)
      return { ...result, node, ref: String(ref), path: normalized }
    },

    async remove({ node, ref, path }) {
      const normalized = assertContainerPath(path)
      if (normalized === '/') throw new CmError(ERR.BAD_ARGS, '不能删根目录。')
      const result = await driverFor(node).filesRemove(String(ref), normalized)
      return { ...result, node, ref: String(ref), path: normalized }
    },
  }
}
