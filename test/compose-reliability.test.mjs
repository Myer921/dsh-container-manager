import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseCompose, buildProject } from '../lib/compose/index.js'
import { checkPortConflicts, parseSsListeners } from '../lib/compose/ports.js'
import { renderServiceArgs } from '../lib/compose/render.js'
import { runCompose } from '../lib/compose/runner.js'

function project(text, env = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cm-compose-'))
  if (env) writeFileSync(join(dir, '.env'), env)
  const file = join(dir, 'compose.yaml')
  writeFileSync(file, text)
  const parsed = parseCompose(file)
  return buildProject(parsed, { name: 'demo', projectName: 'demo', dir, file, fileName: 'compose.yaml', mtimeMs: Date.now() })
}

test('compose 子进程使用 Node 认识的 timeout 选项', async () => {
  let seen = null
  await runCompose({
    binary: 'podman-compose',
    project: { file: '/tmp/compose.yaml', projectName: 'demo', dir: '/tmp' },
    action: 'up',
    timeoutMs: 50,
    exec: async (_file, _args, options) => { seen = options; return { stdout: '', stderr: '' } },
  })
  assert.equal(seen.timeout, 50)
  assert.equal(seen.timeoutMs, undefined)
})

test('compose 从 .env 解析插值', () => {
  const value = project('services:\n  web:\n    image: alpine\n    ports:\n      - "${PORT:-8080}:80"\n', 'PORT=9090\n')
  assert.equal(value.services[0].ports[0].hostPort, 9090)
  assert.deepEqual(value.dynamic, [])
})

test('未解析变量不会被当成无端口冲突', async () => {
  const value = project('services:\n  web:\n    image: alpine\n    ports:\n      - "${MISSING_PORT}:80"\n')
  const result = await checkPortConflicts(value, { exec: async () => parseSsListeners('') })
  assert.equal(result.supported, false)
  assert.match(result.detail, /MISSING_PORT/)
})

test('compose 常用资源键进入 podman 参数', () => {
  const value = project('services:\n  web:\n    image: alpine\n    mem_limit: 512m\n    cpus: 1.5\n    shm_size: 256m\n    pid: host\n')
  const args = renderServiceArgs(value.services[0], 'demo', { projectDir: value.dir })
  assert.ok(args.includes('--memory'))
  assert.ok(args.includes('1.5'))
  assert.ok(args.includes('--shm-size'))
  assert.ok(args.includes('--pid'))
})

test('端口预检排除项目自身监听', async () => {
  const value = project('services:\n  web:\n    image: alpine\n    ports:\n      - "8080:80"\n')
  const result = await checkPortConflicts(value, {
    containers: [{ ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }] }],
    exec: async () => parseSsListeners('LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("rootlessport",pid=1,fd=3))'),
  })
  assert.deepEqual(result.conflicts, [])
})
