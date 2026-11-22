/**
 * compose 文件解析（v0.3.0）
 *
 * 用 vendor 进来的 yaml 2.9.1 的 Document API —— 这样写回时能保留注释与键序，
 * 而不是把用户的文件重新排版一遍。
 *
 * 关键取舍：遇到不认识的键不静默忽略，收集起来让 UI 红字列出。
 * 静默忽略是最坏的一种「假成功」—— 你写了 deploy.replicas: 3 却只起 1 个。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { CmError, ERR } from '../util.js'

const require = createRequire(import.meta.url)
const YAML = require('../../vendor/yaml/dist/index.js')

/** 我们（以及 podman-compose 1.6.0）能如实映射到 podman 的服务级键。 */
export const SUPPORTED_SERVICE_KEYS = new Set([
  'image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'ports', 'expose',
  'volumes', 'restart', 'network_mode', 'networks', 'depends_on', 'healthcheck', 'labels',
  'hostname', 'user', 'working_dir', 'container_name', 'privileged', 'cap_add', 'cap_drop',
  'sysctls', 'ulimits', 'tmpfs', 'init', 'stop_grace_period', 'read_only', 'stdin_open', 'tty',
  'extra_hosts', 'dns', 'dns_search', 'logging', 'security_opt', 'devices',
])

/** 明确不支持的服务级键 → 为什么不支持。 */
export const UNSUPPORTED_SERVICE_KEYS = new Map([
  ['profiles', '多 profile 切换这一版不做，写了会被忽略，起不到隔离作用。'],
  ['deploy', 'deploy 是 swarm 语义；本机 podman 不认副本数、资源、放置约束。资源上限请用 mem_limit / cpus。'],
  ['secrets', 'compose secrets 需要额外的文件/外部来源，这一版不实现。'],
  ['configs', '同上。'],
  ['extends', '跨文件继承会让「这个服务到底是什么配置」变得不可读，这一版不支持。'],
])

/** 明确不支持的顶层键。 */
export const UNSUPPORTED_TOP_KEYS = new Map([
  ['secrets', '顶层 secrets 定义这一版不实现。'],
  ['configs', '顶层 configs 定义这一版不实现。'],
])

function describeYamlError(error) {
  const line = error && error.linePos && error.linePos[0]
  if (!line) return String(error && error.message || error)
  return '第 ' + line.line + ' 行第 ' + line.col + ' 列：' + String(error.message || '')
}

/**
 * @param {string} filePath
 * @param {{text?:string}} [options] 传入 text 时不读盘（写回前校验用）
 */
export function parseCompose(filePath, options = {}) {
  const text = typeof options.text === 'string' ? options.text : readFileSync(filePath, 'utf8')
  let doc
  try {
    doc = YAML.parseDocument(text, { prettyErrors: true })
  } catch (error) {
    throw new CmError(ERR.BAD_ARGS, 'compose 文件解析失败：' + describeYamlError(error), '检查缩进与冒号后的空格。')
  }
  if (doc.errors && doc.errors.length > 0) {
    throw new CmError(ERR.BAD_ARGS, 'compose 文件解析失败：' + describeYamlError(doc.errors[0]), '检查缩进与冒号后的空格。')
  }

  const data = doc.toJS({ maxAliasCount: 100 }) || {}
  const services = data.services && typeof data.services === 'object' ? data.services : {}
  const serviceNames = Object.keys(services)

  const unsupported = []
  const warnings = []

  for (const [key, why] of UNSUPPORTED_TOP_KEYS) {
    if (data[key] !== undefined) unsupported.push({ scope: 'top', key, why })
  }
  if (data.version !== undefined) {
    warnings.push('compose 的 version 字段早已废弃，已忽略（不影响运行）。')
  }
  if (serviceNames.length === 0) {
    throw new CmError(ERR.BAD_ARGS, 'compose 文件里没有 services，无法作为项目。')
  }

  for (const name of serviceNames) {
    const raw = services[name]
    if (!raw || typeof raw !== 'object') {
      unsupported.push({ scope: 'service', service: name, key: '(整个服务)', why: '服务体不是对象。' })
      continue
    }
    for (const key of Object.keys(raw)) {
      if (key.startsWith('x-')) continue
      const why = UNSUPPORTED_SERVICE_KEYS.get(key)
      if (why) {
        unsupported.push({ scope: 'service', service: name, key, why })
        continue
      }
      if (!SUPPORTED_SERVICE_KEYS.has(key)) {
        unsupported.push({ scope: 'service', service: name, key, why: '这个键本插件不认识，不会作用到容器上。' })
      }
    }
    const hasImage = typeof raw.image === 'string' && raw.image.trim()
    const hasBuild = raw.build !== undefined && raw.build !== null
    if (!hasImage && !hasBuild) {
      warnings.push('服务 ' + name + ' 既没有 image 也没有 build，起不来。')
    }
  }

  return { file: filePath, text, doc, data, services, serviceNames, unsupported, warnings }
}
