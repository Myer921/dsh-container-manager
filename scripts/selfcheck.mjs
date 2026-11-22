#!/usr/bin/env node
/**
 * 离线自检：用假的 cordis ctx 调一次 apply()，
 * 确认 17 个工具、一段提示词、一个 REST 前缀、一条 WebSocket 升级路由都注册成功。
 * 不需要 DSH 在跑，也不会碰真实数据（数据目录指到临时目录）。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-selfcheck-'))

const { apply, name } = await import('../lib/index.js')

const seen = { tools: [], sections: [], routes: [], upgrades: [] }
const cleanups = []

const ctx = {
  effect(fn) {
    const dispose = fn()
    cleanups.push(typeof dispose === 'function' ? dispose : () => {})
    return () => {}
  },
  get(key) {
    return ctx[key]
  },
  tools: {
    register(definition) {
      if (!definition || !definition.name) throw new Error('工具没有 name')
      if (seen.tools.includes(definition.name)) throw new Error('工具重名：' + definition.name)
      seen.tools.push(definition.name)
    },
  },
  systemPrompt: {
    section(definition) {
      if (!definition.text) throw new Error('提示词为空')
      seen.sections.push({ name: definition.name, order: definition.order, chars: definition.text.length })
    },
  },
  webServer: {
    register(definition) {
      if (!definition.path) throw new Error('路由没有 path')
      seen.routes.push(definition.path)
    },
    registerUpgrade(definition) {
      if (!definition.path) throw new Error('升级路由没有 path')
      if (typeof definition.handler !== 'function') throw new Error('升级路由没有 handler')
      seen.upgrades.push(definition.path)
      return () => {}
    },
  },
}

const root = {
  inject(keys, callback) {
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('inject 没有 key')
    callback(ctx)
  },
}

apply(root, {})
for (const dispose of cleanups) dispose()

const expectedTools = [
  'container_nodes',
  'container_list',
  'container_inspect',
  'container_logs',
  'container_action',
  'container_create',
  'container_limits',
  'container_stats',
  'container_rename',
  'container_commit',
  'container_config',
  'network_manage',
  'network_host',
  'network_host_apply',
  'compose_projects',
  'compose_inspect',
  'compose_action',
  'compose_set_ports',
  'lxc_snapshot',
  'lxc_clone',
  'lxc_mounts',
  'pending_operations',
]

const problems = []
for (const tool of expectedTools) {
  if (!seen.tools.includes(tool)) problems.push('缺工具：' + tool)
}
if (seen.tools.length !== expectedTools.length) problems.push('工具数量不对：' + seen.tools.length)
if (seen.sections.length !== 1) problems.push('提示词 section 数量不对：' + seen.sections.length)
if (seen.routes.length !== 1) problems.push('REST 前缀数量不对：' + seen.routes.length)
if (seen.routes[0] !== '/api/container-manager') problems.push('前缀不对：' + seen.routes[0])
if (seen.upgrades.length !== 1) problems.push('WebSocket 升级路由数量不对：' + seen.upgrades.length)
if (seen.upgrades[0] !== '/api/container-manager/terminal') problems.push('升级路由不对：' + seen.upgrades[0])

console.log('包名     :', name)
console.log('工具     :', seen.tools.join(', '))
console.log('提示词   :', seen.sections.map(s => s.name + ' (order ' + s.order + ', ' + s.chars + ' 字)').join(', '))
console.log('接口前缀 :', seen.routes.join(', '))

if (problems.length > 0) {
  console.error('\n自检失败：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('\n自检通过。')
