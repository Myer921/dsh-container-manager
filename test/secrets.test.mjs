import test from 'node:test'
import assert from 'node:assert/strict'

import { createPodmanDriver } from '../lib/drivers/podman.js'

/** 假的 execFileAsync：按命令行内容回答，顺便把调用记下来。 */
function makeExec(handler) {
  const calls = []
  const exec = async (command, args, options) => {
    calls.push({ command, args, options })
    const answer = handler(args, command)
    return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false, ...answer }
  }
  return { exec, calls }
}

const NODE = { id: 'local-podman', kind: 'podman', transport: 'local' }

test('secret 列表用 Go 模板解析（4.3 的 --format json 会静默返回空）', async () => {
  const { exec, calls } = makeExec(() => ({
    code: 0,
    stdout: '28f23dedc02d|db-password|file|Less than a second ago|Less than a second ago\n' +
      '9a1b2c3d4e5f|tls-key|file|2 hours ago|3 hours ago\n',
  }))
  const driver = createPodmanDriver(NODE, { exec })
  const result = await driver.secrets()
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].name, 'db-password')
  assert.equal(result.items[1].driver, 'file')
  assert.equal(result.items[1].updatedAt, '3 hours ago')
  const used = calls[0].args.join(' ')
  assert.match(used, /secret ls/)
  assert.ok(!used.includes('--format json'), '不能用会静默返回空的 --format json')
  assert.match(used, /\{\{\.Name\}\}/)
})

test('secret 列表为空就是空，不报错', async () => {
  const { exec } = makeExec(() => ({ code: 0, stdout: '' }))
  const driver = createPodmanDriver(NODE, { exec })
  const result = await driver.secrets()
  assert.deepEqual(result.items, [])
})

test('podman secret ls 失败时如实报错，不当成空列表', async () => {
  const { exec } = makeExec(() => ({ code: 125, stdout: '', stderr: 'Error: no such thing' }))
  const driver = createPodmanDriver(NODE, { exec })
  await assert.rejects(() => driver.secrets(), /no such thing/)
})

test('secret 名字要校验：防止 weird 名字被拼进命令行', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: '' }))
  const driver = createPodmanDriver(NODE, { exec })
  for (const bad of ['', 'a b', 'a;rm -rf /', '$HOME', 'x'.repeat(65)]) {
    await assert.rejects(() => driver.secretRemove(bad), /secret 名字/)
  }
  assert.equal(calls.length, 0, '名字不合法时一条命令都不该跑')
})

test('删 secret 走 podman secret rm，名字校验后再传', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: 'ok' }))
  const driver = createPodmanDriver(NODE, { exec })
  const result = await driver.secretRemove('db-password')
  assert.deepEqual(result, { name: 'db-password', removed: true })
  assert.deepEqual(calls[0].args, ['secret', 'rm', 'db-password'])
})

test('远端节点建 secret 直接说不支持（stdin 传输没接）', async () => {
  const driver = createPodmanDriver({ id: 'r', kind: 'podman', transport: 'ssh', host: 'example.org', user: 'ops' })
  await assert.rejects(() => driver.secretCreate('x', 'value'), /远端节点/)
})
