/**
 * 写回 compose 文件（v0.3.0，grill Q6）
 *
 * 两条路：
 *   1. 表单改字段 —— 定位到具体节点改值，document 其余部分原样保留（含注释）
 *   2. 直接编辑 —— 整份替换，但写前必须 parse 通过
 *
 * 两条都先备份 <file>.cm-bak-<ts>，只保留最近 10 份。
 * 写入用 tmp + rename：写一半断电不会留个半截 compose 文件。
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

import { CmError, ERR } from '../util.js'
import { parseCompose } from './parse.js'

const require = createRequire(import.meta.url)
const YAML = require('../../vendor/yaml/dist/index.js')

const KEEP_BACKUPS = 10
const BACKUP_SUFFIX = '.cm-bak-'

export function backupFile(file) {
  if (!existsSync(file)) return null
  const target = file + BACKUP_SUFFIX + Date.now()
  copyFileSync(file, target)
  pruneBackups(file)
  return target
}

export function pruneBackups(file) {
  try {
    const dir = dirname(file)
    const prefix = basename(file) + BACKUP_SUFFIX
    const backups = readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of backups.slice(KEEP_BACKUPS)) {
      try { unlinkSync(stale.path) } catch { /* 删不掉就留着 */ }
    }
  } catch {
    // 清理失败不影响写入
  }
}

function atomicWrite(file, text) {
  const temporary = join(dirname(file), '.' + basename(file) + '.cm-tmp-' + process.pid)
  let mode = 0o644
  try { mode = statSync(file).mode & 0o777 } catch { mode = 0o644 }
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, file)
}

/** 整份替换（直接编辑）。写前必须能 parse，否则拒绝。 */
export function writeComposeText(file, text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new CmError(ERR.BAD_ARGS, '内容为空，没写。')
  }
  parseCompose(file, { text })
  const backup = backupFile(file)
  atomicWrite(file, text.endsWith('\n') ? text : text + '\n')
  return { file, backup, bytes: Buffer.byteLength(text) }
}

/**
 * 端口值一律写成双引号字符串。
 * 理由：`- 80` 会被 YAML 解析成整数，而 `- 9090:80` 才是字符串；统一加引号可消除歧义，
 * 也和绝大多数人手写的 compose 风格一致。
 */
function portScalar(doc, value) {
  const node = doc.createNode(String(value))
  node.type = 'QUOTE_DOUBLE'
  return node
}

/**
 * 改某个服务的 ports（整组替换）。
 * @param {string} file
 * @param {string} serviceName
 * @param {string[]} ports 形如 ['8080:80', '127.0.0.1:9090:90/udp']
 */
export function updateServicePorts(file, serviceName, ports) {
  const list = Array.isArray(ports) ? ports.map(item => String(item).trim()).filter(Boolean) : []
  if (list.length === 0) throw new CmError(ERR.BAD_ARGS, '至少要留一个端口，或者用「删除该端口映射」而不是清空。')
  for (const item of list) {
    if (!/^[\w.:[\]\-]+(\/[a-z]+)?$/i.test(item)) {
      throw new CmError(ERR.BAD_ARGS, '端口写法看不懂：' + item, '示例：8080:80 或 127.0.0.1:9090:90/udp')
    }
  }

  const parsed = parseCompose(file)
  const doc = parsed.doc
  if (!parsed.services[serviceName]) {
    throw new CmError(ERR.NOT_FOUND, 'compose 里没有这个服务：' + serviceName)
  }

  const path = ['services', serviceName, 'ports']
  const sequence = new YAML.YAMLSeq(doc)
  sequence.spaceBefore = false
  for (const item of list) sequence.items.push(portScalar(doc, item))
  doc.setIn(path, sequence)

  const text = doc.toString()
  const backup = backupFile(file)
  atomicWrite(file, text)
  return { file, service: serviceName, ports: list, backup, text }
}

/** 列出这个文件的历史备份（新的在前）。 */
export function listBackups(file) {
  try {
    const dir = dirname(file)
    const prefix = basename(file) + BACKUP_SUFFIX
    return readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => {
        const path = join(dir, name)
        const stat = statSync(path)
        return {
          path,
          name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          stamp: Number(name.slice(prefix.length)) || 0,
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

