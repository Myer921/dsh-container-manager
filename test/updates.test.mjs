import test from 'node:test'
import assert from 'node:assert/strict'

import { compareDigests, checkImageUpdates, SKOPEO_HINT } from '../lib/updates.js'

const LOCAL = 'sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'

/** 假 runner：按命令记调用，回答由 handler 决定。 */
function makeRun(handler) {
  const calls = []
  const run = async (command, args) => {
    calls.push(command + ' ' + args.join(' '))
    const answer = handler(command, args) ?? {}
    return { code: 0, stdout: '', stderr: '', ...answer }
  }
  return { run, calls }
}

test('digest 一样是 current，不一样是 stale', () => {
  assert.equal(compareDigests(LOCAL, LOCAL).state, 'current')
  assert.equal(compareDigests(LOCAL, LOCAL.replace('sha256:', '')).state, 'current')
  assert.equal(compareDigests(LOCAL, 'sha256:deadbeef').state, 'stale')
})

test('本地没 digest 时是 unknown，不是 current', () => {
  assert.equal(compareDigests('', LOCAL).state, 'unknown')
  assert.equal(compareDigests('<none>', LOCAL).state, 'unknown')
  assert.match(compareDigests('<none>', LOCAL).reason, /自己 build/)
})

test('远端没拿到时是 unknown，不是 fresh', () => {
  const verdict = compareDigests(LOCAL, '')
  assert.equal(verdict.state, 'unknown')
  assert.ok(verdict.reason)
})

test('有 skopeo 时：本地 .Digest 和 skopeo 的 {{.Digest}} 直接比', async () => {
  const { run, calls } = makeRun((command, args) => {
    if (command === 'podman') return { stdout: LOCAL + '\n' }
    return { stdout: LOCAL + '\n' }
  })
  const result = await checkImageUpdates({ images: [{ reference: 'docker.io/library/alpine:3.22' }], run, hasSkopeo: true })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].state, 'current')
  assert.equal(result.stale, 0)
  // 关键：必须问 skopeo 的顶层 digest，而不是 podman manifest inspect 的各平台条目
  assert.ok(calls.some(line => line.startsWith('skopeo inspect --format {{.Digest}} docker://docker.io/library/alpine:3.22')))
  assert.ok(!calls.some(line => line.includes('manifest inspect')))
})

test('没装 skopeo：全部 unknown，并给安装提示（绝不猜「已是最新」）', async () => {
  const { run, calls } = makeRun(() => ({ stdout: LOCAL + '\n' }))
  const result = await checkImageUpdates({ images: [{ reference: 'docker.io/library/alpine:3.22' }], run, hasSkopeo: false })
  assert.equal(result.items[0].state, 'unknown')
  assert.match(result.items[0].reason, /skopeo/)
  assert.ok(result.items[0].reason.includes(SKOPEO_HINT.slice(0, 10)))
  assert.equal(result.hasSkopeo, false)
  assert.ok(!calls.some(line => line.startsWith('skopeo')), '没装就别去调它')
})

test('自建 localhost/ 镜像和 <none> 不去问仓库', async () => {
  const { run, calls } = makeRun(() => ({ stdout: LOCAL }))
  const result = await checkImageUpdates({
    images: [{ reference: 'localhost/myapp:dev' }, { reference: '<none>:<none>' }, { reference: '' }],
    run,
    hasSkopeo: true,
  })
  assert.equal(result.items.length, 0)
  assert.equal(result.checked, 0)
  assert.equal(calls.length, 0)
})

test('查多少个有上限，超出的记 skipped（不把仓库打满）', async () => {
  const images = Array.from({ length: 5 }, (_, index) => ({ reference: 'docker.io/library/img' + index + ':latest' }))
  const { run, calls } = makeRun(() => ({ stdout: LOCAL }))
  const result = await checkImageUpdates({ images, run, hasSkopeo: true, limit: 2 })
  assert.equal(result.checked, 2)
  assert.equal(result.skipped, 3)
  assert.equal(result.items.length, 2)
  assert.equal(calls.length, 4)
})

test('skopeo 问仓库失败时如实说失败，不冒充 current', async () => {
  const { run } = makeRun((command) => {
    if (command === 'skopeo') return { code: 1, stdout: '', stderr: 'Error: unauthorized' }
    return { stdout: LOCAL }
  })
  const result = await checkImageUpdates({ images: [{ reference: 'docker.io/x:1' }], run, hasSkopeo: true })
  assert.equal(result.items[0].state, 'unknown')
  assert.match(result.items[0].reason, /unauthorized|问仓库失败/)
})
