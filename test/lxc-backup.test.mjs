import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createActions } from '../lib/actions.js'
import { createAudit } from '../lib/audit.js'
import { createPendingStore } from '../lib/pending.js'
import { createJobStore } from '../lib/jobs.js'

/**
 * LXC 导出 / 导入：
 *  - 导出与导入都要进任务队列（整份 rootfs，几分钟起步）
 *  - 删归档是删备份，照样走待确认
 *  - 归档目录与后缀在 helper 侧校验（这里验插件侧有没有把参数递对）
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = readFileSync(join(ROOT, 'lib/api.js'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const HELPER = readFileSync(join(ROOT, 'helper/dsh-lxcd.mjs'), 'utf8')

function temp(name) {
  return join(process.env.TMPDIR || '/tmp', 'cm-lxc-backup-' + process.pid + '-' + name)
}

function harness({ registry = {}, withJobs = false } = {}) {
  const calls = []
  const stubRegistry = {
    exportLxc: async (node, name, options) => {
      calls.push(['exportLxc', node, name, options])
      return { name, file: '/tmp/x.tar.gz', bytes: 1024 }
    },
    listLxcExports: async (node, options) => {
      calls.push(['listLxcExports', node, options])
      return { dir: '/tmp', files: [] }
    },
    deleteLxcExport: async (node, name, options) => {
      calls.push(['deleteLxcExport', node, name, options])
      return { name, dir: '/tmp' }
    },
    importLxc: async (node, file, name) => {
      calls.push(['importLxc', node, file, name])
      return { name, state: 'stopped' }
    },
    ...registry,
  }
  const pendings = createPendingStore({ file: temp('pending.json'), ttlSeconds: 600 })
  const audit = createAudit({ file: temp('audit.jsonl'), keepLines: 50 })
  const jobs = withJobs ? createJobStore({ file: temp('jobs.json') }) : null
  const actions = createActions({
    registry: stubRegistry,
    configStore: { get: () => ({ confirmRequired: true, nodes: [], authz: { aiRole: 'admin', deny: [] } }) },
    pendings,
    audit,
    jobs,
  })
  return { actions, calls, pendings, jobs }
}

test('导出进任务队列，参数原样递到 driver', async () => {
  const { actions, calls, jobs } = harness({ withJobs: true })
  const result = await actions.lxcExport({ node: 'local-lxc', name: 'demo', dir: '/srv/backups', instanceOnly: true })
  assert.equal(result.status, 'job')
  assert.ok(result.job.id, '应该拿到任务号')
  const listed = jobs.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].kind, 'lxc.export')
  assert.match(listed[0].label, /demo/)
  await jobs.get(result.job.id)
  // 等任务真的跑完，确认参数没被改过
  for (let i = 0; i < 50 && jobs.get(result.job.id).status !== 'done'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(jobs.get(result.job.id).status, 'done')
  assert.equal(calls[0][0], 'exportLxc')
  assert.equal(calls[0][1], 'local-lxc')
  assert.equal(calls[0][2], 'demo')
  assert.equal(calls[0][3].dir, '/srv/backups')
  assert.equal(calls[0][3].instanceOnly, true)
  assert.ok(calls[0][3].signal instanceof AbortSignal)
  jobs.dispose()
})

test('没有队列时同步执行，行为一致只是不排队', async () => {
  const { actions } = harness({})
  const result = await actions.lxcExport({ node: 'local-lxc', name: 'demo' })
  assert.equal(result.file, '/tmp/x.tar.gz')
  assert.equal(result.bytes, 1024)
})

test('导入也进队列，file 与 name 都不会丢', async () => {
  const { actions, jobs, calls } = harness({ withJobs: true })
  const pending = await actions.lxcImport({ node: 'local-lxc', file: '/tmp/x.tar.gz', name: 'restored' })
  assert.equal(pending.status, 'pending')
  const confirmed = await actions.confirm(pending.token, { principal: 'panel' })
  assert.equal(confirmed.result.status, 'job')
  for (let i = 0; i < 50 && jobs.get(confirmed.result.job.id).status !== 'done'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(calls[0], ['importLxc', 'local-lxc', '/tmp/x.tar.gz', 'restored'])
  jobs.dispose()
})

test('删归档走待确认，不直接删备份', async () => {
  const { actions, calls } = harness({})
  const result = await actions.deleteLxcExport({ node: 'local-lxc', name: 'demo-1.tar.gz' })
  assert.equal(result.status, 'pending')
  assert.match(result.summary, /删除导出归档 demo-1.tar.gz/)
  assert.equal(calls.length, 0, '人还没点，就不该动文件')
})

test('接口就位：GET /lxc/exports，POST /lxc/export、/lxc/import、/lxc/exports/delete', () => {
  for (const line of [
    "segments[1] === 'exports'",
    "segments[1] === 'export'",
    "segments[1] === 'import'",
    "segments[2] === 'delete'",
  ]) {
    assert.ok(API.includes(line), '缺少路由判断：' + line)
  }
  assert.ok(API.includes('actions.lxcExport({'), '导出要接 actions')
  assert.ok(API.includes('actions.lxcImport({'), '导入要接 actions')
})

test('helper 侧真的做了导出与导入，并且校验归档后缀', () => {
  assert.ok(HELPER.includes("'export', container, partial"), '缺少 lxc export 调用')
  assert.ok(HELPER.includes("renameSync(partial, target)"), '导出必须原子落盘')
  assert.ok(HELPER.includes("['import', file, name]"), '缺少 lxc import 调用')
  assert.ok(HELPER.includes('ARCHIVE_EXT'))
  assert.ok(HELPER.includes('\\.tar(\\.gz|\\.xz|\\.bz2|\\.zst|\\.lzma)?$'), '后缀白名单')
  assert.ok(HELPER.includes('--instance-only'))
  for (const route of ["'/lxc/export'", "'/lxc/export/list'", "'/lxc/export/delete'", "'/lxc/import'"]) {
    assert.ok(HELPER.includes(route), '缺少 helper 路由 ' + route)
  }
})

test('面板上有备份 tab，导入导出都接同一套任务提示', () => {
  assert.ok(CLIENT.includes("['backup', '备份']"))
  assert.ok(CLIENT.includes('function LxcBackupPane'))
  assert.ok(CLIENT.includes("jpost('/lxc/export'"))
  assert.ok(CLIENT.includes("jpost('/lxc/import'"))
  assert.ok(CLIENT.includes("jpost('/lxc/exports/delete'"))
  assert.ok(CLIENT.includes('noteJobResult(result)'), '导出导入的结果要落到任务抽屉')
})
