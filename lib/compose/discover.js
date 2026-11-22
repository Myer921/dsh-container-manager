/**
 * 项目发现（v0.3.0）
 *
 * 规则（grill 的 Q2/Q3）：
 *   - 根目录下的一级子目录，且 compose 文件直接位于其中
 *   - 不下探二级
 *   - 不含 compose 文件的一级目录完全不出现（不显示空分组）
 *
 * 只 stat 不读内容，所以扫一个大目录也是毫秒级。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]

/**
 * 目录名 → compose 项目名。
 * compose 要求 [a-z0-9][a-z0-9_-]*，但目录名可能有大小写、点、空格、中文。
 * 转义后撞名不自动加后缀 —— 那样标签会变得不可预测，改为报错让人改名。
 */
export function sanitizeProjectName(dirName) {
  const lowered = String(dirName ?? '').trim().toLowerCase()
  const replaced = lowered.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const head = /^[a-z0-9]/.test(replaced) ? replaced : 'p-' + replaced
  return head.slice(0, 63)
}

/**
 * 目录判断。符号链接也算 —— 「项目目录软链到 /srv 下」是很自然的用法，
 * 只认真目录会让人以为插件坏了。仍然只看一层，链接指向哪都不下探。
 */
function isDirectoryEntry(root, entry) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(join(root, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function foundComposeFile(dir) {
  for (const name of COMPOSE_FILES) {
    const path = join(dir, name)
    try {
      if (statSync(path).isFile()) return { name, path }
    } catch {
      continue
    }
  }
  return null
}

/**
 * @param {string} rawRoot 配置里的根目录
 * @returns {{root:string, projects:Array, problem:string|null, detail?:string, conflicts:Array}}
 */
export function discoverProjects(rawRoot, { maxEntries = 500 } = {}) {
  const root = typeof rawRoot === 'string' ? rawRoot.trim() : ''
  if (!root) return { root: '', projects: [], problem: 'ROOT_EMPTY', conflicts: [] }

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return {
      root,
      projects: [],
      problem: 'ROOT_UNREADABLE',
      detail: String(error && (error.code || error.message) || error),
      conflicts: [],
    }
  }

  const projects = []
  const seen = new Map()
  const conflicts = []

  for (const entry of entries) {
    if (projects.length >= maxEntries) break
    if (!isDirectoryEntry(root, entry)) continue
    if (entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const found = foundComposeFile(dir)
    if (!found) continue
    const projectName = sanitizeProjectName(entry.name)
    if (!projectName) continue
    const previous = seen.get(projectName)
    if (previous) {
      conflicts.push({ projectName, names: [previous, entry.name] })
      continue
    }
    seen.set(projectName, entry.name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(found.path).mtimeMs
    } catch {
      mtimeMs = 0
    }
    projects.push({ name: entry.name, projectName, dir, file: found.path, fileName: found.name, mtimeMs })
  }

  projects.sort((a, b) => a.name.localeCompare(b.name))
  return { root, projects, problem: null, conflicts }
}
