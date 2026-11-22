#!/usr/bin/env node
/**
 * LXC 新能力冒烟：快照 / 克隆 / 挂载点。
 *
 * 直接打 helper 的 unix socket，不经过 DSH —— 这几条是 root 侧真实动作，
 * 先在 helper 层面验证，出问题好定位是 helper 还是驱动。
 *
 * 容器名固定 cm-smoke-lxc*，结束时（含失败）一律清理。
 */

import { request } from 'node:http'

const SOCKET = process.env.CM_LXC_SOCKET || '/run/dsh-container-manager/lxcd.sock'
const BASE = 'cm-smoke-lxc'
const CLONE = 'cm-smoke-lxc-copy'

function call(path, body = {}, timeoutMs = 120000) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: SOCKET,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { return reject(new Error('返回不是 JSON：' + text.slice(0, 200))) }
        if (!json.ok) return reject(new Error((json.error && json.error.code) + '：' + (json.error && json.error.message)))
        resolve(json.data)
      })
    })
    req.on('timeout', () => req.destroy(new Error('helper 超时：' + path)))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function assert(ok, message) {
  if (!ok) throw new Error('断言失败：' + message)
}

async function destroyQuietly(name) {
  try {
    await call('/lxc/action', { name, action: 'stop' }, 60000)
  } catch { /* 可能本来就没跑 */ }
  try {
    await call('/lxc/action', { name, action: 'destroy' }, 120000)
  } catch (error) {
    process.stdout.write('  （清理 ' + name + ' 时报错：' + error.message + '）\n')
  }
}

async function main() {
  process.stdout.write('helper：' + SOCKET + '\n')

  await destroyQuietly(CLONE)
  await destroyQuietly(BASE)

  process.stdout.write('\n=== 1. 建一个最小容器 ===\n')
  const created = await call('/lxc/create', { name: BASE, distro: 'alpine', release: '3.22', arch: 'arm64', start: false }, 900000)
  process.stdout.write('已创建 ' + created.name + '（' + created.state + '）\n')

  process.stdout.write('\n=== 2. 挂载点读写 ===\n')
  const before = await call('/lxc/mounts/get', { name: BASE })
  assert(Array.isArray(before.mounts), 'mounts 不是数组')
  const settings = await call('/lxc/mounts/set', {
    name: BASE,
    mounts: [{ host: '/tmp', target: '/mnt/hosttmp' }],
  })
  assert(settings.changed === true, '写挂载点没有生效')
  const after = await call('/lxc/mounts/get', { name: BASE })
  assert(after.mounts.length === before.mounts.length + 1, '挂载点数量没加一')
  const added = after.mounts.find(item => item.target === '/mnt/hosttmp')
  assert(added && added.host === '/tmp', '挂载条目内容不对：' + JSON.stringify(after.mounts))
  assert(/bind/.test(added.options), '选项里没有 bind：' + added.options)
  const reset = await call('/lxc/mounts/set', { name: BASE, mounts: [] })
  assert(reset.changed === true, '清空挂载点没有生效')
  assert((await call('/lxc/mounts/get', { name: BASE })).mounts.length === before.mounts.length, '清空后数量不对')
  process.stdout.write('写入 / 读回 / 清空都正常\n')

  process.stdout.write('\n=== 3. 非法挂载点要被拒 ===\n')
  for (const bad of [
    { host: 'relative/path', target: '/x' },
    { host: '/tmp', target: 'relative' },
    { host: '/tmp', target: '/x y' },
  ]) {
    let rejected = false
    try {
      await call('/lxc/mounts/set', { name: BASE, mounts: [bad] })
    } catch (error) {
      rejected = /BAD_ARGS/.test(error.message)
    }
    assert(rejected, '非法挂载点没被拒：' + JSON.stringify(bad))
  }
  process.stdout.write('三条非法输入都被拒\n')

  process.stdout.write('\n=== 4. 快照 ===\n')
  const empty = await call('/lxc/snapshot/list', { name: BASE })
  assert(Array.isArray(empty.snapshots), 'snapshots 不是数组')
  assert(empty.note && /ext4/.test(empty.note), '没有 ext4 的提示')
  await call('/lxc/snapshot', { name: BASE, op: 'create', comment: 'dsh-cm-smoke' }, 900000)
  const listed = await call('/lxc/snapshot/list', { name: BASE })
  assert(listed.snapshots.length >= 1, '建完快照列表还是空的')
  const snap = listed.snapshots[0].name
  process.stdout.write('快照：' + listed.snapshots.map(item => item.name).join(', ') + '\n')
  await call('/lxc/snapshot', { name: BASE, op: 'delete', snapshot: snap }, 300000)
  const afterDelete = await call('/lxc/snapshot/list', { name: BASE })
  assert(afterDelete.snapshots.length === listed.snapshots.length - 1, '删完快照数量没减')
  process.stdout.write('建 / 列 / 删都正常\n')

  process.stdout.write('\n=== 5. 克隆 ===\n')
  const cloned = await call('/lxc/clone', { name: BASE, newName: CLONE }, 900000)
  assert(cloned.name === CLONE, '克隆返回的名字不对')
  const info = await call('/lxc/info', { name: CLONE })
  assert(info && info.name === CLONE, '克隆出来的容器读不到')
  process.stdout.write('克隆成功，新容器状态 ' + (cloned.state || 'unknown') + '\n')

  process.stdout.write('\n=== 6. 清理 ===\n')
  await destroyQuietly(CLONE)
  await destroyQuietly(BASE)
  process.stdout.write('两个容器都清了\n\n全部通过。\n')
}

try {
  await main()
} catch (error) {
  process.stdout.write('\n失败：' + (error && error.stack ? error.stack : String(error)) + '\n')
  await destroyQuietly(CLONE)
  await destroyQuietly(BASE)
  process.exit(1)
}
