import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertContainerPath,
  assertFileName,
  createFileService,
  FILE_LIMIT_BYTES,
  looksLikeText,
  splitContainerPath,
} from '../lib/files.js'
import { createApi } from '../lib/api.js'
import { createActions } from '../lib/actions.js'
import { createConfigStore } from '../lib/config.js'
import { createPendingStore } from '../lib/pending.js'
import { createPodmanDriver } from '../lib/drivers/podman.js'
import { createLxcDriver } from '../lib/drivers/lxc.js'
import { packFile, unpackSingleFile } from '../lib/tar.js'
import { CmError } from '../lib/util.js'

/* ───────────── 路径校验：越界只有这三条能挡 ───────────── */

test('容器内路径必须绝对、不许 ..、不许 NUL', () => {
  assert.equal(assertContainerPath('/etc/nginx//nginx.conf'), '/etc/nginx/nginx.conf')
  assert.equal(assertContainerPath('/'), '/')
  assert.equal(assertContainerPath('/./a/./b'), '/a/b')
  assert.equal(assertContainerPath('/a/'), '/a')
  for (const bad of ['', '   ', 'etc/passwd', '/a/../../etc/passwd', '/a\u0000b', 'x'.repeat(5000)]) {
    assert.throws(() => assertContainerPath(bad), CmError, '应当拒绝：' + JSON.stringify(bad))
  }
})

test('文件名是单段：不许斜杠、不许 . 与 ..、不许超 100 字节', () => {
  assert.equal(assertFileName('nginx.conf'), 'nginx.conf')
  assert.equal(assertFileName('中文 名字.txt'), '中文 名字.txt')
  for (const bad of ['', '.', '..', 'a/b', 'x'.repeat(101)]) {
    assert.throws(() => assertFileName(bad), CmError)
  }
})

test('splitContainerPath 拆出父目录与名字，目录路径直接拒', () => {
  assert.deepEqual(splitContainerPath('/etc/nginx.conf'), { dir: '/etc', name: 'nginx.conf' })
  assert.deepEqual(splitContainerPath('/x'), { dir: '/', name: 'x' })
  assert.throws(() => splitContainerPath('/etc/'), CmError)
})

test('文本 / 二进制靠有没有 NUL 判断', () => {
  assert.equal(looksLikeText(Buffer.from('hello 世界', 'utf8')), true)
  assert.equal(looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false)
})

/* ───────────── tar：podman cp 的读写全靠它 ───────────── */

test('packFile → unpackSingleFile 往返，二进制也不走样', () => {
  const body = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00, 0x7f])
  const archive = packFile('blob.bin', body)
  const parsed = unpackSingleFile(archive)
  assert.equal(parsed.name, 'blob.bin')
  assert.equal(parsed.size, body.length)
  assert.deepEqual(Buffer.from(parsed.data), body)
})

test('空文件也能往返（0 字节不能变成「没有条目」）', () => {
  const parsed = unpackSingleFile(packFile('empty.txt', ''))
  assert.equal(parsed.size, 0)
  assert.equal(parsed.data.length, 0)
})

test('tar 里没有普通文件时明确报错，不给一个假的空文件', () => {
  const notTar = Buffer.alloc(1024, 0x41)
  assert.throws(() => unpackSingleFile(notTar), /ustar/)
})

/* ───────────── 文件服务：校验在服务层做一次 ───────────── */

function makeRegistry(overrides = {}) {
  const calls = []
  const driver = {
    async filesList(ref, path) {
      calls.push({ op: 'list', ref, path })
      return {
        path,
        entries: [
          { name: 'etc', type: 'dir', size: 4096, mtime: '2026-01-01T00:00:00.000Z' },
          { name: 'nginx.conf', type: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z' },
        ],
      }
    },
    async filesRead(ref, path, options) {
      calls.push({ op: 'read', ref, path, options })
      if (path === '/bin.dat') return { path, data: Buffer.from([0x00, 0x01, 0x02]), truncated: false }
      if (path === '/big.txt') return { path, data: Buffer.alloc(FILE_LIMIT_BYTES + 1, 0x61), truncated: false }
      return { path, data: Buffer.from('worker_processes 4;', 'utf8'), truncated: false }
    },
    async filesWrite(ref, path, data) {
      calls.push({ op: 'write', ref, path, bytes: data.length, sample: data.toString('utf8').slice(0, 8) })
      return { written: true, bytes: data.length }
    },
    async filesMkdir(ref, path) {
      calls.push({ op: 'mkdir', ref, path })
      return { created: true }
    },
    async filesRemove(ref, path) {
      calls.push({ op: 'remove', ref, path })
      return { removed: true }
    },
    ...overrides,
  }
  return {
    calls,
    registry: {
      find: id => (id === 'local-podman' ? { id, kind: 'podman' } : null),
      driverFor: () => driver,
    },
  }
}

test('list 给出父目录与截断标记，路径先被规整', async () => {
  const { registry, calls } = makeRegistry()
  const files = createFileService({ registry })
  const listed = await files.list({ node: 'local-podman', ref: 'demo', path: '//etc//nginx/' })
  assert.equal(listed.path, '/etc/nginx')
  assert.equal(listed.parent, '/etc')
  assert.equal(listed.entries.length, 2)
  assert.equal(listed.truncated, false)
  assert.deepEqual(calls[0], { op: 'list', ref: 'demo', path: '/etc/nginx' })
})

test('read 文本给 text、二进制给 base64，两者不会同时出现', async () => {
  const { registry } = makeRegistry()
  const files = createFileService({ registry })
  const text = await files.read({ node: 'local-podman', ref: 'demo', path: '/etc/nginx.conf' })
  assert.equal(text.binary, false)
  assert.equal(text.text, 'worker_processes 4;')
  assert.equal(text.base64, null)
  assert.equal(text.name, 'nginx.conf')

  const binary = await files.read({ node: 'local-podman', ref: 'demo', path: '/bin.dat' })
  assert.equal(binary.binary, true)
  assert.equal(binary.text, null)
  assert.equal(Buffer.from(binary.base64, 'base64').length, 3)
})

test('超过上限的文件不进浏览器，报错里说清怎么办', async () => {
  const { registry } = makeRegistry()
  const files = createFileService({ registry })
  await assert.rejects(
    () => files.read({ node: 'local-podman', ref: 'demo', path: '/big.txt' }),
    error => error instanceof CmError && /超过/.test(error.message) && /终端/.test(error.hint ?? ''),
  )
})

test('write 文本按 utf8、base64 按原字节；两者都记字节数', async () => {
  const { registry, calls } = makeRegistry()
  const files = createFileService({ registry })
  const wrote = await files.write({ node: 'local-podman', ref: 'demo', path: '/a.conf', text: '中文' })
  assert.equal(wrote.bytes, 6)
  assert.equal(calls.find(call => call.op === 'write').bytes, 6)

  await files.write({ node: 'local-podman', ref: 'demo', path: '/b.bin', base64: Buffer.from([0x00, 0xff]).toString('base64') })
  const last = calls.filter(call => call.op === 'write').pop()
  assert.equal(last.bytes, 2)
})

test('remove 不许删根目录；节点不存在时给出可读错误', async () => {
  const { registry } = makeRegistry()
  const files = createFileService({ registry })
  await assert.rejects(() => files.remove({ node: 'local-podman', ref: 'demo', path: '/' }), /不能删根目录/)
  await assert.rejects(() => files.list({ node: 'nope', ref: 'demo', path: '/' }), /没有这个节点/)
})

test('驱动缺文件方法时说清楚，而不是 TypeError', async () => {
  const { registry } = makeRegistry({ filesList: undefined, filesRead: undefined, filesWrite: undefined, filesMkdir: undefined, filesRemove: undefined })
  const files = createFileService({ registry })
  await assert.rejects(() => files.list({ node: 'local-podman', ref: 'demo', path: '/' }), /还不支持文件操作/)
})

/* ───────────── 两个驱动都真的挂了文件方法 ───────────── */

test('Podman 与 LXC 驱动都提供 files* 五个方法', () => {
  const podman = createPodmanDriver({ id: 'local-podman', kind: 'podman', transport: 'local' })
  for (const method of ['filesList', 'filesRead', 'filesWrite', 'filesMkdir', 'filesRemove']) {
    assert.equal(typeof podman[method], 'function', 'Podman 缺 ' + method)
  }
  const lxc = createLxcDriver({ id: 'local-lxc', kind: 'lxc', transport: 'local', socket: '/run/dsh-lxcd.sock' })
  for (const method of ['filesList', 'filesRead', 'filesWrite', 'filesMkdir', 'filesRemove']) {
    assert.equal(typeof lxc[method], 'function', 'LXC 缺 ' + method)
  }
})

test('Podman 走 ssh 时文件操作直接说不支持（不假装传得过去）', async () => {
  const remote = createPodmanDriver({ id: 'remote', kind: 'podman', transport: 'ssh', host: 'example.org', user: 'ops' })
  await assert.rejects(() => remote.filesList('demo', '/'), /只支持本机/)
})

/* ───────────── REST：读能开，写只给面板 ───────────── */

function makeResponse() {
  const state = { statusCode: 0, headers: {}, body: '' }
  const res = {
    state,
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value },
    end(body) { state.body = String(body ?? '') },
    json() { return JSON.parse(state.body) },
  }
  Object.defineProperty(res, 'statusCode', { get: () => state.statusCode, set: value => { state.statusCode = value } })
  return res
}

function makeRequest({ method = 'GET', url, headers = {}, body = null } = {}) {
  const listeners = {}
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3085', ...headers },
    setEncoding() {},
    on(event, handler) { listeners[event] = handler; return this },
    destroy() {},
    start() {
      if (body !== null && listeners.data) listeners.data(JSON.stringify(body))
      if (listeners.end) listeners.end()
    },
  }
}

function setupApi(principal = { kind: 'owner' }) {
  process.env.DSH_CM_DIR = mkdtempSync(join(tmpdir(), 'cm-files-'))
  const configStore = createConfigStore({})
  const pendings = createPendingStore({ file: join(process.env.DSH_CM_DIR, 'pending.json'), ttlSeconds: 600 })
  const { registry, calls } = makeRegistry()
  const audit = { append() {}, read() { return [] } }
  const files = createFileService({ registry })
  const actions = createActions({ registry, configStore, pendings, audit, files })
  const api = createApi({ registry, configStore, pendings, actions, audit, files, verify: () => ({ ok: true, principal }) })
  return { api, files, calls, registry, configStore, pendings }
}

async function call(api, request) {
  const req = makeRequest(request)
  const res = makeResponse()
  const pendingCall = api.handle(req, res)
  req.start()
  await pendingCall
  return { status: res.statusCode, body: res.json() }
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-cm-request': '1', 'x-cm-principal': 'panel' }

test('GET /files 与 /files/read 面板能直接用', async () => {
  const { api } = setupApi()
  const listed = await call(api, { url: '/api/container-manager/files?node=local-podman&ref=demo&path=%2Fetc' })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data.path, '/etc')
  assert.equal(listed.body.data.entries.length, 2)

  const read = await call(api, { url: '/api/container-manager/files/read?node=local-podman&ref=demo&path=%2Fetc%2Fnginx.conf' })
  assert.equal(read.status, 200)
  assert.equal(read.body.data.text, 'worker_processes 4;')
})

test('缺参数时 400，别把 undefined 当路径传下去', async () => {
  const { api } = setupApi()
  const bad = await call(api, { url: '/api/container-manager/files?node=local-podman' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error.message, /ref/)
})

test('POST /files/write 没有面板标记就 403，并指路 AI 工具', async () => {
  const { api, calls } = setupApi({ kind: 'remote' })
  // 非 owner Peer 即使伪造 panel 头也会被写守卫拒绝
  const denied = await call(api, {
    method: 'POST',
    url: '/api/container-manager/files/write',
    headers: { 'content-type': 'application/json', 'x-cm-request': '1' },
    body: { node: 'local-podman', ref: 'demo', path: '/a.conf', text: 'x' },
  })
  assert.equal(denied.status, 403)
  assert.match(denied.body.error.hint, /container_files/)
  assert.equal(calls.filter(item => item.op === 'write').length, 0, '被拒时不能真的写')

  const { api: ownerApi, calls: ownerCalls } = setupApi()
  const allowed = await call(ownerApi, {
    method: 'POST',
    url: '/api/container-manager/files/write',
    headers: WRITE_HEADERS,
    body: { node: 'local-podman', ref: 'demo', path: '/a.conf', text: 'x' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(ownerCalls.filter(item => item.op === 'write').length, 1)
})

test('POST /files/remove 走面板，删掉的是规整后的路径', async () => {
  const { api, calls } = setupApi()
  const removed = await call(api, {
    method: 'POST',
    url: '/api/container-manager/files/remove',
    headers: WRITE_HEADERS,
    body: { node: 'local-podman', ref: 'demo', path: '/tmp//junk.log' },
  })
  assert.equal(removed.status, 200)
  assert.equal(calls.find(item => item.op === 'remove').path, '/tmp/junk.log')
})
