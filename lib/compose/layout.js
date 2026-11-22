/**
 * 目录骨架（v0.3.0）
 *
 * 用户选的是一层「基础目录」（如 /opt/dsh-container），插件在它下面派生两个：
 *   <root>/podman/  —— compose 项目的家，一级子目录 = 一个项目
 *   <root>/lxc/     —— LXC 侧的家，每个容器一个子目录（挂载数据、导出、备份）
 *
 * 两个子目录不存在就建。建不了（权限）要给出**能直接粘的命令**，而不是一句「失败了」。
 */

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PODMAN_DIR = 'podman'
export const LXC_DIR = 'lxc'

/** 纯函数：不碰磁盘，只算路径。 */
export function composeLayout(rawRoot) {
  const root = typeof rawRoot === 'string' ? rawRoot.trim() : ''
  if (!root) return { root: '', podmanRoot: '', lxcRoot: '', configured: false }
  return {
    root,
    podmanRoot: join(root, PODMAN_DIR),
    lxcRoot: join(root, LXC_DIR),
    configured: true,
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 确保两个子目录存在。幂等。
 * @returns {{root:string,podmanRoot:string,lxcRoot:string,configured:boolean,created:string[],problem:null|{code:string,detail:string,path:string,hint?:string}}}
 */
export function ensureLayout(rawRoot) {
  const layout = composeLayout(rawRoot)
  if (!layout.configured) {
    return { ...layout, created: [], problem: null }
  }
  const created = []
  for (const dir of [layout.podmanRoot, layout.lxcRoot]) {
    if (isDirectory(dir)) continue
    try {
      mkdirSync(dir, { recursive: true })
      created.push(dir)
    } catch (error) {
      const code = String(error && error.code || '')
      const hint = code === 'EACCES' || code === 'EPERM'
        ? 'mkdir -p ' + dir + ' && sudo chown -R ' + (process.env.SUDO_USER || process.env.USER || 'root') + ' ' + layout.root
        : code === 'ENOENT'
          ? '父目录不存在，先建好 ' + layout.root + ' 再回来。'
          : undefined
      return {
        ...layout,
        created,
        problem: {
          code: 'LAYOUT_MKDIR_FAILED',
          path: dir,
          detail: String(error && (error.code || error.message) || error),
          ...(hint ? { hint } : {}),
        },
      }
    }
  }
  return { ...layout, created, problem: null }
}
