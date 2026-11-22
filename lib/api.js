/**
 * /api/container-manager —— 面板用的 REST。
 *
 * 认证：先过 Connection 的 Host/Origin 与浏览器凭证（ctx.connection.requestRejection）。
 * 没有 Connection 服务时退到「Host 头必须本机 + 拒绝跨站 Origin」。
 * 写请求额外要求 content-type: application/json 与 x-cm-request: 1（CSRF 双保险）。
 * 确认请求要求 x-cm-principal: panel —— 只有面板会加这个头。
 */

import { LXC_ARCHES, LXC_TEMPLATE_SUGGESTIONS } from './create-spec.js'
import { firewallSummary, hostNetwork, readConnection } from './net.js'
import { searchImages } from './registry-search.js'
import { serveStatic } from './static.js'
import { CmError, ERR, asCmError, clampInt, safeJson } from './util.js'

export const PREFIX = '/api/container-manager'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function fail(res, error) {
  const cm = asCmError(error)
  const status = cm.code === ERR.NOT_FOUND ? 404
    : cm.code === ERR.BAD_ARGS ? 400
      : cm.code === ERR.NODE_UNAVAILABLE || cm.code === ERR.HELPER_DOWN ? 409
        : cm.code === ERR.CONFIRM_REQUIRED ? 428
          : 500
  sendJson(res, status, { ok: false, error: { code: cm.code, message: cm.message, ...(cm.hint ? { hint: cm.hint } : {}) } })
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) req.destroy()
    })
    req.on('end', () => resolve(safeJson(raw, {})))
    req.on('error', () => resolve({}))
  })
}

export function createApi({ registry, configStore, pendings, actions, audit, verify, helperHint, compose = null, info = {} }) {
  function guard(req, res, { write = false } = {}) {
    const verdict = verify(req)
    if (!verdict.ok) {
      sendJson(res, verdict.status ?? 401, { ok: false, error: { code: 'UNAUTHORIZED', message: verdict.reason ?? '请求没通过认证。' } })
      return false
    }
    if (write) {
      const type = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!type.includes('application/json')) {
        sendJson(res, 415, { ok: false, error: { code: 'BAD_ARGS', message: '写请求必须是 application/json。' } })
        return false
      }
      if (String(req.headers['x-cm-request'] ?? '') !== '1') {
        sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '缺少 x-cm-request 头。' } })
        return false
      }
    }
    return true
  }

  function principalOf(req) {
    return String(req.headers['x-cm-principal'] ?? '') === 'panel' ? 'panel' : 'api'
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '不是容器台的接口。' } })
      return
    }
    const rest = url.pathname.slice(PREFIX.length)
    const segments = rest.split('/').filter(Boolean).map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET') return await handleGet(req, res, url, segments)
      if (method === 'POST') return await handlePost(req, res, url, segments)
      if (method === 'DELETE') return await handleDelete(req, res, segments)
      sendJson(res, 405, { ok: false, error: { code: 'BAD_ARGS', message: `不支持 ${method}` } })
    } catch (error) {
      fail(res, error)
    }
  }

  async function handleGet(req, res, url, segments) {
    if (!guard(req, res)) return
    const config = configStore.get()

    if (segments.length === 0 || segments[0] === 'state') {
      const [snapshot] = await Promise.all([registry.snapshot({ force: url.searchParams.get('refresh') === '1' })])
      return sendJson(res, 200, {
        ok: true,
        data: {
          ...snapshot,
          pending: pendings.list({ includeFinished: false }),
          config: publicConfig(config),
        },
      })
    }
    if (segments[0] === 'nodes' && segments.length === 1) {
      const nodes = await registry.probeAll()
      return sendJson(res, 200, { ok: true, data: nodes.map(entry => publicNode(entry)) })
    }
    if (segments[0] === 'nodes' && segments.length === 3 && segments[2] === 'host') {
      return sendJson(res, 200, { ok: true, data: await registry.hostInfo(segments[1]) })
    }
    // 宿主网络：接口 / 路由 / DNS / NM 连接 / 监听端口，全部只读。
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'host') {
      return sendJson(res, 200, { ok: true, data: await hostNetwork() })
    }
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'firewall') {
      return sendJson(res, 200, { ok: true, data: await firewallSummary() })
    }
    if (segments[0] === 'net' && segments.length === 4 && segments[1] === 'connections' && segments[3] === 'full') {
      return sendJson(res, 200, { ok: true, data: await actions.inspectNetworkConnection({ name: segments[2], principal: principalOf(req) }) })
    }
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'neighbors') {
      return sendJson(res, 200, { ok: true, data: await actions.listNetworkNeighbors({ principal: principalOf(req) }) })
    }
    if (segments[0] === 'net' && segments.length === 3 && segments[1] === 'connections') {
      return sendJson(res, 200, { ok: true, data: await readConnection(segments[2]) })
    }
    // 镜像搜索：用户点「搜」才打一次 Docker Hub，5 秒超时，不通就让他们直接填名字。
    if (segments[0] === 'images' && segments.length === 2 && segments[1] === 'search') {
      const keyword = String(url.searchParams.get('q') ?? '')
      return sendJson(res, 200, { ok: true, data: await searchImages(keyword) })
    }
    // 容器实时占用 + 宿主负载：单次 1~2 秒，和 /state 的 4 秒轮询分开走。
    if (segments[0] === 'stats' && segments.length === 1) {
      const nodeId = String(url.searchParams.get('node') ?? '')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, 'stats 需要一个 node 参数。', '先 GET /nodes 看看有哪些节点。')
      return sendJson(res, 200, {
        ok: true,
        data: await registry.stats(nodeId, { force: url.searchParams.get('refresh') === '1' }),
      })
    }
    if (segments[0] === 'static' && segments.length >= 2) {
      const asset = segments.slice(1).join('/')
      if (serveStatic(res, asset)) return
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个静态资源：' + asset } })
    }
    if (segments[0] === 'compose') {
      return await getCompose(req, res, url, segments)
    }
    if (segments[0] === 'containers') {
      return await getContainers(req, res, url, segments)
    }
    if (segments[0] === 'images' && segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.listImages(nodeId) })
    }
    if (segments[0] === 'volumes' && segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.listVolumes(nodeId) })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'storage') {
      const nodeId = url.searchParams.get('node')
      if (!nodeId) throw new CmError(ERR.BAD_ARGS, '需要 node 参数。')
      return sendJson(res, 200, { ok: true, data: await registry.lxcStorage(nodeId) })
    }
    if (segments[0] === 'lxc' && segments.length === 2 && segments[1] === 'templates') {
      return sendJson(res, 200, { ok: true, data: { suggestions: LXC_TEMPLATE_SUGGESTIONS, arches: LXC_ARCHES } })
    }
    if (segments[0] === 'networks') {
      const nodeId = url.searchParams.get('node')
      const snapshot = await registry.snapshot()
      const filtered = nodeId ? snapshot.networks.filter(network => network.nodeId === nodeId) : snapshot.networks
      return sendJson(res, 200, { ok: true, data: filtered })
    }
    if (segments[0] === 'pending') {
      return sendJson(res, 200, { ok: true, data: pendings.list({ includeFinished: true }) })
    }
    if (segments[0] === 'audit') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 2000, 100)
      return sendJson(res, 200, { ok: true, data: audit.read(limit) })
    }
    if (segments[0] === 'config') {
      return sendJson(res, 200, { ok: true, data: publicConfig(config) })
    }
    if (segments[0] === 'health') {
      return sendJson(res, 200, { ok: true, data: await health() })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：GET ${url.pathname}` } })
  }

  /** compose 的只读查询：项目列表、单项目详情、YAML 原文、日志、迁移预览、运行时状态。 */
  async function getCompose(req, res, url, segments) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    const rest = segments.slice(1)
    if (rest.length === 1 && rest[0] === 'runtime') {
      return sendJson(res, 200, { ok: true, data: await compose.runtime() })
    }
    if (rest[0] !== 'projects') {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：GET ' + url.pathname } })
      return
    }
    if (rest.length === 1) {
      return sendJson(res, 200, { ok: true, data: await compose.list() })
    }
    const name = String(rest[1] ?? '')
    const tail = rest.slice(2)
    if (tail.length === 0) return sendJson(res, 200, { ok: true, data: await compose.detail(name) })
    if (tail.length === 1 && tail[0] === 'yaml') return sendJson(res, 200, { ok: true, data: compose.yamlText(name) })
    if (tail.length === 1 && tail[0] === 'adopt') return sendJson(res, 200, { ok: true, data: await compose.adoptPreview(name) })
    if (tail.length === 1 && tail[0] === 'logs') {
      const service = url.searchParams.get('service') || ''
      const lines = clampInt(url.searchParams.get('tail'), 1, 2000, 200)
      return sendJson(res, 200, { ok: true, data: await compose.logs(name, { service, tail: lines }) })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：GET ' + url.pathname } })
  }

  async function getContainers(req, res, url, segments) {
    if (segments.length === 1) {
      const nodeId = url.searchParams.get('node')
      const snapshot = await registry.snapshot()
      const filtered = nodeId ? snapshot.containers.filter(container => container.nodeId === nodeId) : snapshot.containers
      return sendJson(res, 200, { ok: true, data: filtered })
    }
    const nodeId = segments[1]
    let rest = segments.slice(2)
    if (rest.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_ARGS', message: '缺少容器名。' } })
      return
    }
    if (rest[rest.length - 1] === 'logs') {
      const ref = rest.slice(0, -1).join('/')
      const config = configStore.get()
      const tail = clampInt(url.searchParams.get('tail'), 1, config.logTailMax, config.logTailDefault)
      const data = await registry.logs(nodeId, ref, tail)
      return sendJson(res, 200, { ok: true, data: { ref, tail, ...data } })
    }
    if (rest[rest.length - 1] === 'network') {
      const ref = rest.slice(0, -1).join('/')
      const data = await registry.lxcNetwork(nodeId, ref)
      return sendJson(res, 200, { ok: true, data })
    }
    if (rest[rest.length - 1] === 'snapshots') {
      const ref = rest.slice(0, -1).join('/')
      return sendJson(res, 200, { ok: true, data: await registry.listSnapshots(nodeId, ref) })
    }
    if (rest[rest.length - 1] === 'mounts') {
      const ref = rest.slice(0, -1).join('/')
      return sendJson(res, 200, { ok: true, data: await registry.readMounts(nodeId, ref) })
    }
    const ref = rest.join('/')
    return sendJson(res, 200, { ok: true, data: await registry.inspect(nodeId, ref) })
  }

  /** compose 的写操作。down / adopt 会删容器，交给 actions 挂待确认。 */
  async function postCompose(req, res, url, segments, body) {
    if (!compose) throw new CmError(ERR.INTERNAL, 'compose 子系统没接上。')
    if (!guard(req, res, { write: true })) return
    const principal = principalOf(req)
    const rest = segments.slice(1)
    if (rest.length === 2 && rest[0] === 'runtime' && rest[1] === 'install') {
      return sendJson(res, 200, { ok: true, data: await compose.install({ principal }) })
    }
    if (rest[0] !== 'projects') {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：POST ' + url.pathname } })
      return
    }
    const name = String(rest[1] ?? '')
    const tail = rest.slice(2)
    if (tail.length === 1 && tail[0] === 'yaml') {
      const text = String(body?.text ?? '')
      if (!text.trim()) throw new CmError(ERR.BAD_ARGS, '内容是空的，没写。')
      return sendJson(res, 200, { ok: true, data: compose.writeYaml(name, text, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'up') {
      return sendJson(res, 200, { ok: true, data: await compose.up(name, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'restart') {
      return sendJson(res, 200, { ok: true, data: await compose.restart(name, { principal }) })
    }
    if (tail.length === 1 && tail[0] === 'down') {
      return sendJson(res, 200, { ok: true, data: await actions.composeDown({ name, principal }) })
    }
    if (tail.length === 1 && tail[0] === 'adopt') {
      return sendJson(res, 200, { ok: true, data: await actions.composeAdopt({ name, principal }) })
    }
    if (tail.length === 3 && tail[0] === 'services' && tail[2] === 'ports') {
      const service = String(tail[1] ?? '')
      const ports = Array.isArray(body?.ports) ? body.ports.map(item => String(item)) : []
      const result = compose.setServicePorts(name, service, ports, { principal })
      // rebuild 只认显式 true：改端口和「立刻重建」是两件事，别偷偷重启人家服务。
      if (body?.rebuild === true) result.rebuild = await compose.up(name, { principal })
      return sendJson(res, 200, { ok: true, data: result })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口：POST ' + url.pathname } })
  }

  async function handlePost(req, res, url, segments) {
    const body = await readBody(req)

    // 连通性诊断：只读，但要 POST（带参数），照旧过写请求守卫。
    if (segments[0] === 'net' && segments.length === 2 && segments[1] === 'diagnose') {
      if (!guard(req, res, { write: true })) return
      const result = await actions.diagnoseNetwork({
        target: body?.target,
        count: body?.count,
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    // 新建宿主连接：要排在 /:name 之前，不然 create 会被当成连接名。
    if (segments[0] === 'net' && segments.length === 3 && segments[1] === 'connections' && segments[2] === 'create') {
      if (!guard(req, res, { write: true })) return
      return sendJson(res, 200, {
        ok: true,
        data: await actions.createNetworkConnection({ spec: body ?? {}, principal: principalOf(req) }),
      })
    }
    // 改宿主网络连接：一律走 pending，前端还得确认一次。
    if (segments[0] === 'net' && segments[1] === 'connections' && segments.length >= 3) {
      if (!guard(req, res, { write: true })) return
      const name = segments[2]
      const op = segments[3] ?? 'modify'
      if (op === 'state') {
        return sendJson(res, 200, {
          ok: true,
          data: await actions.setNetworkLink({ name, up: body?.up !== false, principal: principalOf(req) }),
        })
      }
      if (op === 'delete') {
        return sendJson(res, 200, {
          ok: true,
          data: await actions.deleteNetworkConnection({ name, principal: principalOf(req) }),
        })
      }
      return sendJson(res, 200, {
        ok: true,
        data: await actions.applyNetworkConnection({
          name,
          patch: body?.patch ?? body ?? {},
          principal: principalOf(req),
        }),
      })
    }

    if (segments[0] === 'nodes' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = configStore.addNode(body)
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: node })
    }
    if (segments[0] === 'nodes' && segments.length === 3 && segments[2] === 'modules') {
      if (!guard(req, res, { write: true })) return
      const name = String(body?.name ?? '')
      if (!/^[a-z0-9][a-z0-9_]{0,31}$/.test(name)) throw new CmError(ERR.BAD_ARGS, '模块名不合法。')
      return sendJson(res, 200, { ok: true, data: await registry.ensureModule(segments[1], name) })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'snapshots') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const op = String(body?.op ?? 'create')
      const result = await actions.lxcSnapshot({
        node,
        name,
        op,
        options: { snapshot: body?.snapshot, comment: body?.comment },
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'mounts') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const result = await actions.lxcSetMounts({
        node,
        name,
        mounts: Array.isArray(body?.mounts) ? body.mounts : [],
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'clone') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const result = await actions.lxcClone({
        node,
        name,
        newName: String(body?.newName ?? ''),
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'images') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const reference = String(body?.reference ?? '')
      if (!node || !reference) throw new CmError(ERR.BAD_ARGS, '需要 node / reference。')
      if (segments.length === 2 && segments[1] === 'pull') {
        return sendJson(res, 200, { ok: true, data: await actions.imagePull({ node, reference, principal: principalOf(req) }) })
      }
      if (segments.length === 2 && segments[1] === 'delete') {
        // 两边的「镜像」根本不是一回事：Podman 是 OCI 镜像库，LXC 是本地 rootfs 缓存目录。
        // 按节点类型分流，别硬塞进同一个删除流程。
        if (registry.kindOf(node) === 'lxc') {
          return sendJson(res, 200, { ok: true, data: await actions.lxcImageDelete({ node, name: reference || String(body?.name ?? ''), principal: principalOf(req) }) })
        }
        return sendJson(res, 200, { ok: true, data: await actions.imageDelete({ node, reference, principal: principalOf(req) }) })
      }
      throw new CmError(ERR.NOT_FOUND, '没有这个接口：POST ' + url.pathname)
    }
    if (segments[0] === 'volumes' && segments.length === 2 && segments[1] === 'delete') {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const name = String(body?.name ?? '')
      if (!node || !name) throw new CmError(ERR.BAD_ARGS, '需要 node / name。')
      return sendJson(res, 200, { ok: true, data: await actions.volumeDelete({ node, name, principal: principalOf(req) }) })
    }
    if (segments[0] === 'compose') {
      return await postCompose(req, res, url, segments, body)
    }
    if (segments[0] === 'actions') {
      if (!guard(req, res, { write: true })) return
      if (segments.length === 2 && segments[1] === 'confirm') {
        if (principalOf(req) !== 'panel') {
          sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '确认只能在面板里点。' } })
          return
        }
        const token = String(body?.token ?? '')
        if (!token) throw new CmError(ERR.BAD_ARGS, '缺少 token。')
        return sendJson(res, 200, { ok: true, data: await actions.confirm(token, { principal: 'panel' }) })
      }
      if (segments.length === 2 && segments[1] === 'cancel') {
        if (principalOf(req) !== 'panel') {
          sendJson(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: '取消只能在面板里点。' } })
          return
        }
        const token = String(body?.token ?? '')
        if (!token) throw new CmError(ERR.BAD_ARGS, '缺少 token。')
        return sendJson(res, 200, { ok: true, data: { status: 'cancelled', record: actions.cancel(token, { principal: 'panel' }) } })
      }
      if (segments.length === 1) {
        const node = String(body?.node ?? '')
        const ref = String(body?.ref ?? body?.id ?? '')
        const action = String(body?.action ?? '')
        if (!node || !ref || !action) throw new CmError(ERR.BAD_ARGS, '需要 node / ref / action。')
        const result = await actions.containerAction({ node, ref, action, principal: principalOf(req) })
        return sendJson(res, 200, { ok: true, data: result })
      }
    }
    if (segments[0] === 'networks' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      const op = String(body?.op ?? '')
      if (!node || !op) throw new CmError(ERR.BAD_ARGS, '需要 node / op。')
      const result = await actions.networkOperation({ node, op: { ...body, node, op }, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      const node = String(body?.node ?? '')
      if (!node) throw new CmError(ERR.BAD_ARGS, '需要 node。')
      // spec 归一化在 actions 层做（按 node.kind 分派），这里只把 body 交下去。
      const result = await actions.createContainer({ node, spec: body, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'rename') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      const result = await actions.renameContainer({ node, ref, name: body?.name, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'commit') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      if (!node || !ref) throw new CmError(ERR.BAD_ARGS, '需要 node / ref。')
      const result = await actions.commitContainer({ node, ref, image: body?.image ?? body?.target, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'limits') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      const result = await actions.updatePodmanCgroup({
        node,
        ref,
        limits: {
          ...(body?.memory !== undefined ? { memory: body.memory } : {}),
          ...(body?.cpus !== undefined ? { cpus: body.cpus } : {}),
          ...(body?.cpuShares !== undefined ? { cpuShares: body.cpuShares } : {}),
          ...(body?.cpusetCpus !== undefined ? { cpusetCpus: body.cpusetCpus } : {}),
          ...(body?.restart !== undefined ? { restart: body.restart } : {}),
        },
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'config') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const patch = {}
      if (body && 'autostart' in body) patch.autostart = body.autostart === true
      if (body && 'memoryMax' in body) patch.memoryMax = body.memoryMax === null ? '' : String(body.memoryMax ?? '')
      if (Object.keys(patch).length === 0) throw new CmError(ERR.BAD_ARGS, '没有要改的项（autostart / memoryMax）。')
      const result = await actions.setLxcConfig({ node, name, patch, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'resources') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const name = segments.slice(2, -1).join('/')
      const patch = pickResourcePatch(body)
      if (Object.keys(patch).length === 0) {
        throw new CmError(ERR.BAD_ARGS, '没有要改的项。可改：cores / cpuQuota / cpuWeight / memory / memoryHigh / swap / oomGroup / pids / ioWeight / hostname / autostart / startOrder / startDelay / initCmd / capDrop。')
      }
      const result = await actions.setLxcResources({ node, name, patch, principal: principalOf(req) })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'containers' && segments.length >= 4 && segments[segments.length - 1] === 'network') {
      if (!guard(req, res, { write: true })) return
      const node = segments[1]
      const ref = segments.slice(2, -1).join('/')
      const nics = Array.isArray(body?.nics) ? body.nics : []
      if (nics.length === 0) throw new CmError(ERR.BAD_ARGS, '至少要留一块网卡。')
      const result = await actions.setLxcNetwork({
        node,
        name: ref,
        nics,
        restart: body?.restart !== false,
        principal: principalOf(req),
      })
      return sendJson(res, 200, { ok: true, data: result })
    }
    if (segments[0] === 'config' && segments.length === 1) {
      if (!guard(req, res, { write: true })) return
      // 只带 compose 的请求走增量：别为了改个根目录把节点和其余设置一起冲掉。
      const patch = body?.compose
      const keys = body && typeof body === 'object' ? Object.keys(body) : []
      if (patch && typeof patch === 'object' && keys.length === 1) {
        const next = {}
        if (patch.root !== undefined) next.root = String(patch.root)
        if (patch.binary !== undefined) next.binary = String(patch.binary)
        if (Object.keys(next).length > 0) configStore.updateCompose(next)
        let layout = null
        if (compose) {
          try { layout = compose.layout() } catch { layout = null }
        }
        return sendJson(res, 200, { ok: true, data: { ...publicConfig(configStore.get()), layout } })
      }
      const next = configStore.replace(body)
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: publicConfig(next) })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：POST ${url.pathname}` } })
  }

  async function handleDelete(req, res, segments) {
    if (!guard(req, res, { write: true })) return
    if (segments[0] === 'nodes' && segments.length === 2) {
      const removed = configStore.removeNode(segments[1])
      registry.clearProbe()
      return sendJson(res, 200, { ok: true, data: { removed } })
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口。' } })
  }

  async function health() {
    const config = configStore.get()
    const nodes = await registry.probeAll({ force: true })
    return {
      ok: true,
      plugin: info.name ?? 'dsh-container-manager',
      version: info.version ?? null,
      nodes: nodes.map(entry => publicNode(entry)),
      helperHint: helperHint(),
      config: {
        confirmRequired: config.confirmRequired,
        confirmTtlSeconds: config.confirmTtlSeconds,
        allowLogs: config.allowLogs,
        dataDir: configStore.file.replace(/\/config\.json$/, ''),
      },
      pending: pendings.list({ includeFinished: false }).length,
      at: new Date().toISOString(),
    }
  }

  return { handle }
}

// helper 认哪些资源字段，这里就只转发哪些。
// 拼错一个键不会被悄悄忽略，而是直接挡在路由外面。
const RESOURCE_FIELDS = [
  'cores', 'cpuQuota', 'cpuWeight',
  'memory', 'memoryHigh', 'swap', 'oomGroup',
  'pids', 'ioWeight',
  'hostname', 'autostart', 'startOrder', 'startDelay', 'initCmd', 'capDrop',
]

function pickResourcePatch(body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const field of RESOURCE_FIELDS) {
    if (!(field in body)) continue
    const raw = body[field]
    if (field === 'autostart' || field === 'oomGroup') patch[field] = Boolean(raw)
    else patch[field] = raw === null ? '' : String(raw)
  }
  return patch
}

function publicNode(entry) {
  return {
    id: entry.node.id,
    label: entry.node.label,
    kind: entry.node.kind,
    transport: entry.node.transport,
    available: entry.available,
    code: entry.code,
    reason: entry.reason,
    hint: entry.hint,
    hintText: entry.hintText ?? null,
    detail: entry.detail ?? null,
  }
}

function publicConfig(config) {
  return {
    version: config.version,
    nodes: config.nodes,
    confirmRequired: config.confirmRequired,
    confirmTtlSeconds: config.confirmTtlSeconds,
    allowLogs: config.allowLogs,
    logTailDefault: config.logTailDefault,
    logTailMax: config.logTailMax,
    compose: config.compose ?? null,
  }
}
