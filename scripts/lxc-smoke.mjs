#!/usr/bin/env node
/**
 * LXC 真机冒烟测试
 *
 * 前提：已经装好 lxc 与 root helper，并手工建好一个测试容器（脚本只操作名字以 cm-smoke 开头的容器）。
 * 全程走插件自己的 REST 接口，不走 lxc-* 命令 —— 验的是插件那条路。
 *
 *   sudo lxc-create -n cm-smoke-lxc -t download -- -d alpine -r 3.22 -a arm64
 *   node scripts/lxc-smoke.mjs
 *
 * 加 --with-create 就不用手工建：脚本自己走 POST /containers 拉一个 alpine 出来（要联网下载 rootfs），
 * 结束时删掉。这条路径顺带把「面板的创建按钮」也验了。
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-lxc-smoke-'))

const { PREFIX, createApi } = await import('../lib/api.js')
const { createActions } = await import('../lib/actions.js')
const { createAudit } = await import('../lib/audit.js')
const { createConfigStore, paths } = await import('../lib/config.js')
const { createNodeRegistry } = await import('../lib/nodes.js')
const { createPendingStore } = await import('../lib/pending.js')

const NAME = process.env.CM_LXC_NAME || 'cm-smoke-lxc'
const NODE = 'local-lxc'
const WITH_CREATE = process.argv.slice(2).includes('--with-create')

if (!NAME.startsWith('cm-smoke')) {
  console.error('拒绝执行：容器名必须以 cm-smoke 开头，避免误伤真实容器。')
  process.exit(1)
}

const run = promisify(execFile)

const configStore = createConfigStore({})
const dataPaths = paths()
const audit = createAudit({ file: dataPaths.audit, keepLines: 500 })
const pendings = createPendingStore({ file: dataPaths.pending, ttlSeconds: 600 })
const registry = createNodeRegistry(configStore, { helperHint: () => 'sudo bash helper/install-helper.sh' })
const actions = createActions({ registry, configStore, pendings, audit })
const api = createApi({
  registry,
  configStore,
  pendings,
  actions,
  audit,
  verify: () => ({ ok: true }),
  helperHint: () => 'sudo bash helper/install-helper.sh',
})

const server = createServer((req, res) => {
  Promise.resolve(api.handle(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: { message: String(error?.message) } }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + PREFIX

const PANEL = {
  'content-type': 'application/json',
  'x-cm-request': '1',
  'x-cm-principal': 'panel',
}

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : PANEL,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: response.status, body: json }
}

const failures = []
function check(label, condition, detail) {
  const line = (condition ? '  ok   ' : '  FAIL ') + label + (detail ? ' — ' + detail : '')
  console.log(line)
  if (!condition) failures.push(label)
}

async function rootRead(path) {
  try {
    const { stdout } = await run('sudo', ['-n', 'cat', path], { timeoutMs: 15000 })
    return stdout
  } catch (error) {
    return null
  }
}

async function rootExists(path) {
  try {
    await run('sudo', ['-n', 'test', '-e', path], { timeoutMs: 15000 })
    return true
  } catch {
    return false
  }
}

async function rootList(dir) {
  try {
    const { stdout } = await run('sudo', ['-n', 'ls', '-1', dir], { timeoutMs: 15000 })
    return stdout.split('\n').map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function stateOf() {
  const detail = await call('GET', '/containers/' + NODE + '/' + NAME)
  if (detail.status !== 200) return null
  return String(detail.body?.data?.state ?? '')
}

let created = false
try {
  console.log('目标容器: ' + NAME + ' @ ' + NODE + '\n')

  if (WITH_CREATE) {
    console.log('[0] 通过面板接口创建容器（--with-create）')
    const createRes = await call('POST', '/containers', {
      node: NODE,
      name: NAME,
      distro: 'alpine',
      release: '3.22',
      arch: 'arm64',
      network: 'lxcbr0',
      start: false,
      autostart: false,
    })
    check(
      'POST /containers 创建 LXC 成功',
      createRes.status === 200 && createRes.body?.data?.created?.name === NAME,
      'HTTP ' + createRes.status + ' ' + JSON.stringify(createRes.body?.data ?? createRes.body?.error).slice(0, 240),
    )
    if (createRes.status !== 200) throw new Error('创建失败，后面的步骤没有意义')
    console.log('')
  }

  console.log('[1] 先决条件')
  const configPath = '/var/lib/lxc/' + NAME + '/config'
  const existedBefore = await rootExists(configPath)
  check('容器配置存在（已经手工建好）', existedBefore, configPath)
  if (!existedBefore) {
    console.log('\n没有这个容器。先跑：sudo lxc-create -n ' + NAME + ' -t download -- -d alpine -r 3.22 -a arm64')
    process.exit(1)
  }

  const health = await call('GET', '/health')
  check('helper 可用', health.body?.data?.nodes?.some(n => n.id === NODE && n.available), 'HTTP ' + health.status)

  console.log('\n[2] 列表与详情（stopped 状态）')
  const list = await call('GET', '/containers?node=' + NODE)
  const listed = Array.isArray(list.body?.data) ? list.body.data : []
  const found = listed.find(item => item.name === NAME)
  check('container_list 能看到它', Boolean(found), found ? found.state : 'missing（拿到 ' + listed.length + ' 个）')
  const detailStopped = await call('GET', '/containers/' + NODE + '/' + NAME)
  check('container_inspect 成功', detailStopped.status === 200, 'HTTP ' + detailStopped.status + ' state=' + detailStopped.body?.data?.state)

  console.log('\n[3] 启动')
  const started = await call('POST', '/actions', { node: NODE, ref: NAME, action: 'start' })
  check('start 直接执行（不是危险动作）', started.body?.data?.status === 'done', 'HTTP ' + started.status + ' ' + JSON.stringify(started.body?.data?.status ?? started.body))
  await new Promise(resolve => setTimeout(resolve, 1500))
  const stateAfterStart = await stateOf()
  check('容器变成 running', stateAfterStart === 'running', String(stateAfterStart))

  const detailRunning = await call('GET', '/containers/' + NODE + '/' + NAME)
  check('详情里有 pid', Number(detailRunning.body?.data?.pid) > 0, 'pid=' + String(detailRunning.body?.data?.pid))

  console.log('\n[4] 日志')
  const logs = await call('GET', '/containers/' + NODE + '/' + NAME + '/logs?tail=20')
  check('logs 接口可用', logs.status === 200 && typeof logs.body?.data?.text === 'string', 'HTTP ' + logs.status + ' ' + String(logs.body?.data?.text ?? '').length + ' 字节')

  console.log('\n[5] 读网卡配置')
  const netRead = await call('GET', '/containers/' + NODE + '/' + NAME + '/network')
  const nics = netRead.body?.data?.nics ?? []
  check('读到网卡结构', netRead.status === 200 && nics.length > 0, JSON.stringify(nics.map(nic => nic.type + ':' + (nic.link ?? '—'))))

  console.log('\n[6] 改网卡（veth + lxcbr0，不重启）')
  const beforeConfig = await rootRead(configPath)
  const changed = await call('POST', '/containers/' + NODE + '/' + NAME + '/network', {
    nics: [{ type: 'veth', link: 'lxcbr0', ipv4: { address: '10.0.3.200/24', gateway: '10.0.3.1' } }],
    restart: false,
  })
  check('改网卡进待确认', changed.body?.data?.status === 'pending', String(changed.body?.data?.status ?? JSON.stringify(changed.body)))
  const token = changed.body?.data?.token

  const denied = await fetch(base + '/actions/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cm-request': '1' },
    body: JSON.stringify({ token }),
  })
  check('不带 panel principal 的确认被拒', denied.status === 403, 'HTTP ' + denied.status)

  const confirmed = await call('POST', '/actions/confirm', { token })
  check('面板确认后执行成功', confirmed.body?.data?.status === 'done', 'HTTP ' + confirmed.status + ' ' + String(confirmed.body?.data?.status ?? JSON.stringify(confirmed.body)))

  const afterConfig = await rootRead(configPath)
  check('配置里出现 lxc.net.0.link = lxcbr0', String(afterConfig).includes('lxc.net.0.link = lxcbr0'), '')
  check('配置里出现新地址', String(afterConfig).includes('10.0.3.200/24'), '')

  const backups = (await rootList('/var/lib/lxc/' + NAME)).filter(file => file.startsWith('config.cm-bak-'))
  check('改之前留了备份', backups.length > 0, backups.join(', '))
  check('原配置里的非网络行还在', String(afterConfig).includes('lxc.include') || String(afterConfig).includes('lxc.rootfs') || String(afterConfig).includes('lxc.arch'), '')
  check('新配置里网卡数量为 1', (String(afterConfig).match(/lxc\.net\.\d+\.type/g) ?? []).length === 1, '')

  console.log('\n[7] 改启动项（autostart + 内存上限，应挂起）')
  const cfg = await call('POST', '/containers/' + NODE + '/' + NAME + '/config', {
    autostart: true,
    memoryMax: '268435456',
  })
  check('启动项改动进待确认', cfg.body?.data?.status === 'pending', String(cfg.body?.data?.status ?? JSON.stringify(cfg.body)))
  const cfgSummary = String(cfg.body?.data?.summary ?? '')
  check('摘要写了自启与内存', /开机自启 开/.test(cfgSummary) && /内存上限/.test(cfgSummary), cfgSummary)

  const cfgBefore = await rootRead(configPath)
  check('确认前配置没被改', !String(cfgBefore).includes('lxc.start.auto'), '')

  const cfgDone = await call('POST', '/actions/confirm', { token: cfg.body?.data?.token })
  check('确认后写入成功', cfgDone.body?.data?.status === 'done', 'HTTP ' + cfgDone.status + ' ' + String(cfgDone.body?.data?.status ?? JSON.stringify(cfgDone.body)))

  const cfgAfter = await rootRead(configPath)
  check('配置里出现 lxc.start.auto = 1', String(cfgAfter).includes('lxc.start.auto = 1'), '')
  check('配置里出现内存上限', String(cfgAfter).includes('lxc.cgroup2.memory.max = 268435456'), '')
  check('其余行没丢', String(cfgAfter).includes('lxc.net.0.type') || String(cfgAfter).includes('lxc.include'), '')
  const cfgBackups = (await rootList('/var/lib/lxc/' + NAME)).filter(file => file.startsWith('config.cm-bak-'))
  check('改启动项也留了备份', cfgBackups.length >= 2, cfgBackups.length + ' 个备份')

  const detailCfg = await call('GET', '/containers/' + NODE + '/' + NAME)
  check('详情带回了 settings', detailCfg.body?.data?.settings?.autostart === true, JSON.stringify(detailCfg.body?.data?.settings))

  console.log('\n[8] 停止')
  const stopped = await call('POST', '/actions', { node: NODE, ref: NAME, action: 'stop' })
  check('stop 直接执行', stopped.body?.data?.status === 'done', String(stopped.body?.data?.status))
  await new Promise(resolve => setTimeout(resolve, 1200))
  check('容器变成 stopped', (await stateOf()) === 'stopped', String(await stateOf()))

  console.log('\n[9] 删除（LXC 的 delete 应翻成 destroy 并挂起）')
  const del = await call('POST', '/actions', { node: NODE, ref: NAME, action: 'delete' })
  check('delete 进待确认', del.body?.data?.status === 'pending', String(del.body?.data?.status ?? JSON.stringify(del.body)))
  check('摘要写的是删除容器', String(del.body?.data?.summary ?? '').includes('删除容器'), String(del.body?.data?.summary ?? ''))

  const delDone = await call('POST', '/actions/confirm', { token: del.body?.data?.token })
  check('确认后删除成功', delDone.body?.data?.status === 'done', 'HTTP ' + delDone.status)
  created = true
  await new Promise(resolve => setTimeout(resolve, 800))
  check('/var/lib/lxc 下已无残留', !(await rootExists('/var/lib/lxc/' + NAME)), '')
} finally {
  if (!created) {
    console.log('\n[清理] 中途失败，尝试用 sudo lxc-destroy 收尾…')
    try {
      await run('sudo', ['-n', 'lxc-stop', '-n', NAME, '-k'], { timeoutMs: 30000 })
    } catch { /* 没在跑就算了 */ }
    try {
      await run('sudo', ['-n', 'lxc-destroy', '-n', NAME], { timeoutMs: 60000 })
      console.log('  已清理。')
    } catch (error) {
      console.log('  清理失败（可能需要手动处理）：' + String(error?.stderr ?? error?.message ?? error))
    }
  }
  server.close()
}

console.log('')
if (failures.length > 0) {
  console.error('失败 ' + failures.length + ' 项：' + failures.join(' / '))
  process.exit(1)
}
console.log('LXC 冒烟测试全部通过。')
