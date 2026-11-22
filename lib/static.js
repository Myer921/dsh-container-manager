/**
 * 静态资源：只服务 vendor/ 下的白名单路径（xterm 那些）。
 * 允许最多一层子目录（vendor/xterm/xterm.js），其余一律拒绝，所以不存在穿越。
 */

import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../vendor', import.meta.url))

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/

export function serveStatic(res, name) {
  const clean = String(name || '').trim()
  if (!SAFE.test(clean)) return false
  if (clean.split('/').some((part) => part === '..' || part === '.')) return false
  const file = join(ROOT, clean)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  res.statusCode = 200
  res.setHeader('content-type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream')
  res.setHeader('cache-control', 'public, max-age=600')
  res.setHeader('x-content-type-options', 'nosniff')
  createReadStream(file).pipe(res)
  return true
}

export const STATIC_ROOT = ROOT
