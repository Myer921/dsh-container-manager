/**
 * compose 编排层（v0.3.0）
 *
 * 把 discover / parse / model / status / ports / runner / runtime / yaml-write 串起来，
 * 对上层（REST 与 AI 工具）只暴露「项目」这个概念的动词。
 *
 * 一条原则：**能验证的都验证**。up 之前查端口，改了配置重新算状态，
 * podman-compose 报错就把 stderr 原文带出去，不把它翻译成一句「失败了」。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { CmError, ERR, asCmError } from '../util.js'
import { discoverProjects } from './discover.js'
import { parseCompose } from './parse.js'
import { buildProject } from './model.js'
import { projectStatus } from './status.js'
import { checkPortConflicts, describeConflict } from './ports.js'
import { runCompose, summarizeFailure } from './runner.js'
import { installRuntime, runtimeStatus } from './runtime.js'
import { listBackups, updateServiceImage, updateServicePorts, writeComposeText } from './yaml-write.js'
import { ensureLayout } from './layout.js'
import { containerNameOf, renderServiceArgs } from './render.js'

const require = createRequire(import.meta.url)
const YAML = require('../../vendor/yaml/dist/index.js')
const SECRET_KEY = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|DSN)/i

function redactComposeValue(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redactComposeValue(item, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactComposeValue(child, childKey)]))
  }
  if (SECRET_KEY.test(key) && value !== null && value !== undefined && value !== '') return '<redacted>'
  return value
}

function redactComposeText(text) {
  try {
    const data = YAML.parse(String(text))
    if (!data || typeof data !== 'object') return String(text)
    if (data.services && typeof data.services === 'object') {
      for (const service of Object.values(data.services)) {
        if (!service || typeof service !== 'object') continue
        if (service.environment && typeof service.environment === 'object') {
          if (Array.isArray(service.environment)) {
            service.environment = service.environment.map(line => {
              const at = String(line).indexOf('=')
              return at > 0 ? String(line).slice(0, at + 1) + '<redacted>' : String(line)
            })
          } else {
            service.environment = Object.fromEntries(Object.keys(service.environment).map(key => [key, '<redacted>']))
          }
        }
      }
    }
    return YAML.stringify(redactComposeValue(data))
  } catch {
    return '[compose YAML 脱敏失败，请从面板查看原文]'
  }
}

export function createComposeService({ configStore, registry, audit }) {
  function settings() {
    return configStore.get().compose ?? {}
  }

  /** 根目录 + 两个子目录；没配或建不了都给出可直接照做的下一步。 */
  function layoutOrThrow() {
    const ensured = ensureLayout(settings().root)
    if (!ensured.configured) {
      throw new CmError(
        ERR.BAD_ARGS,
        '还没配置容器根目录。',
        '面板「项目」页填一个基础目录（例如 /opt/dsh-container），插件会在它下面建 podman/ 与 lxc/。',
      )
    }
    if (ensured.problem) {
      throw new CmError(ERR.INTERNAL, '根目录不可用：' + ensured.problem.detail, ensured.problem.hint)
    }
    return ensured
  }

  function findProject(name) {
    const layout = layoutOrThrow()
    const found = discoverProjects(layout.podmanRoot)
    if (found.problem === 'ROOT_UNREADABLE') {
      throw new CmError(ERR.INTERNAL, '读不到项目目录：' + (found.detail || layout.podmanRoot))
    }
    const meta = found.projects.find(item => item.name === name || item.projectName === name)
    if (!meta) throw new CmError(ERR.NOT_FOUND, '没有这个项目：' + name, '先看 GET /compose/projects 有哪些。')
    const parsed = parseCompose(meta.file)
    return { layout, meta, parsed, project: buildProject(parsed, meta) }
  }

  async function containers() {
    const bundle = await registry.containersOfKind('podman')
    return bundle.containers
  }

  function log(entry) {
    if (!audit || typeof audit.append !== 'function') return
    try { audit.append(entry) } catch { /* 审计失败不影响主流程 */ }
  }

  function projectNameOf(item) {
    const labels = item && item.labels ? item.labels : {}
    return labels['com.docker.compose.project'] || labels['io.podman.compose.project'] || ''
  }

  function orphanContainers(all, projectNames) {
    const known = new Set(projectNames)
    return (all || [])
      .filter(item => {
        const project = projectNameOf(item)
        return !project || !known.has(project)
      })
      .map(item => ({
        name: item.name,
        id: item.id,
        state: item.state,
        image: item.image,
        running: Boolean(item.running),
        project: projectNameOf(item),
      }))
  }

  /** 项目列表 + 每个项目的状态摘要。项目少，直接全量算，不做缓存。 */
  async function list() {
    const layout = layoutOrThrow()
    const found = discoverProjects(layout.podmanRoot)
    if (found.problem === 'ROOT_UNREADABLE') {
      throw new CmError(ERR.INTERNAL, '读不到项目目录：' + (found.detail || layout.podmanRoot))
    }
    const all = await containers()
    const projects = found.projects.map(meta => {
      let project
      try {
        project = buildProject(parseCompose(meta.file), meta)
      } catch (error) {
        return {
          name: meta.name,
          projectName: meta.projectName,
          dir: meta.dir,
          file: meta.file,
          broken: true,
          problem: String(error && error.message || error),
          counts: { total: 0, running: 0, exited: 0, created: 0, missing: 0 },
          services: [],
        }
      }
      return { ...projectStatus(project, all), broken: false }
    })
    return {
      layout: { root: layout.root, podmanRoot: layout.podmanRoot, lxcRoot: layout.lxcRoot },
      projects,
      conflicts: found.conflicts,
      orphans: orphanContainers(all, found.projects.map(meta => meta.projectName)),
    }
  }

  async function detail(name) {
    const { project, layout } = findProject(name)
    const all = await containers()
    const runtimeInfo = await runtimeStatus(settings())
    return {
      ...projectStatus(project, all),
      layout: { root: layout.root, podmanRoot: layout.podmanRoot, lxcRoot: layout.lxcRoot },
      runtime: runtimeInfo,
      backups: listBackups(project.file).slice(0, 10),
      rollbacks: settings().rollbacks || {},
    }
  }

  function yamlText(name) {
    const { project } = findProject(name)
    return {
      name: project.name,
      file: project.file,
      fileName: project.fileName,
      text: readFileSync(project.file, 'utf8'),
      backups: listBackups(project.file),
    }
  }

  function redactedYamlText(name) {
    const value = yamlText(name)
    return { ...value, text: redactComposeText(value.text) }
  }

  function writeYaml(name, text, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const result = writeComposeText(project.file, text)
    log({
      at: new Date().toISOString(),
      principal,
      node: 'compose',
      action: 'yaml.write',
      target: project.name,
      detail: { bytes: result.bytes, backup: result.backup },
    })
    return { ...result, name: project.name }
  }

  /** 表单改端口：写回 compose，并把重新解析后的端口还回去，方便 UI 立即显示。 */
  function setServicePorts(name, serviceName, ports, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const service = project.services.find(item => item.name === serviceName)
    if (!service) throw new CmError(ERR.NOT_FOUND, '这个项目里没有服务：' + serviceName)
    const result = updateServicePorts(project.file, serviceName, ports)
    const next = buildProject(parseCompose(project.file), project)
    const updated = next.services.find(item => item.name === serviceName)
    log({
      at: new Date().toISOString(),
      principal,
      node: 'compose',
      action: 'compose.ports',
      target: project.name + '/' + serviceName,
      detail: { ports },
    })
    return {
      name: project.name,
      service: serviceName,
      ports,
      backup: result.backup,
      parsedPorts: updated ? updated.ports : [],
    }
  }

  async function up(name, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const runtimeInfo = await runtimeStatus(settings())
    if (!runtimeInfo.ready) {
      return { ok: false, stage: 'runtime', message: 'podman-compose 不可用，先装。', hint: runtimeInfo.hint, runtime: runtimeInfo }
    }
    const all = await containers()
    const own = all.filter(item => projectNameOf(item) === project.projectName)
    const check = await checkPortConflicts(project, { containers: own })
    if (check.conflicts.length > 0) {
      return {
        ok: false,
        stage: 'ports',
        message: check.conflicts.map(describeConflict).join(' '),
        hint: '换一个宿主端口，或者先把占用的进程停掉。',
        conflicts: check.conflicts,
      }
    }
    const result = await runCompose({ binary: runtimeInfo.binary, project, action: 'up' })
    log({
      at: new Date().toISOString(),
      principal,
      node: 'compose',
      action: 'compose.up',
      target: project.name,
      detail: { ok: result.ok, code: result.code },
    })
    return {
      ok: result.ok,
      stage: result.ok ? 'done' : 'compose',
      message: result.ok ? '已启动。' : '启动失败：' + summarizeFailure(result),
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      portsCheck: { supported: check.supported, detail: check.detail ?? null },
      status: await detail(name),
    }
  }

  async function restart(name, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const runtimeInfo = await runtimeStatus(settings())
    if (!runtimeInfo.ready) return { ok: false, stage: 'runtime', message: 'podman-compose 不可用，先装。', hint: runtimeInfo.hint }
    const result = await runCompose({ binary: runtimeInfo.binary, project, action: 'restart' })
    log({ at: new Date().toISOString(), principal, node: 'compose', action: 'compose.restart', target: project.name, detail: { ok: result.ok } })
    return {
      ok: result.ok,
      stage: result.ok ? 'done' : 'compose',
      message: result.ok ? '已重启。' : '重启失败：' + summarizeFailure(result),
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      status: await detail(name),
    }
  }

  /**
   * 单个服务滚动：先 pull 这一个服务的镜像，再只重建它（--no-deps）。
   *
   * 为什么不做整项目 up：那会把所有服务一起重启。这里只动一个，
   * 别的服务连 recreate 都不进（--no-deps），出问题也只影响这一个。
   */
  async function recreateService(name, serviceName, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const service = String(serviceName ?? '')
    const detailBefore = await detail(name)
    const serviceNames = (detailBefore.services || []).map(item => item.name)
    if (!serviceNames.includes(service)) {
      return {
        ok: false,
        stage: 'args',
        message: '这个项目里没有服务 ' + service + '（有：' + serviceNames.join(', ') + '）',
      }
    }
    const runtimeInfo = await runtimeStatus(settings())
    if (!runtimeInfo.ready) {
      return { ok: false, stage: 'runtime', message: 'podman-compose 不可用，先装。', hint: runtimeInfo.hint }
    }
    const before = await podmanImageId(project, service)
    if (before) {
      const rollbacks = { ...(settings().rollbacks || {}) }
      rollbacks[project.name + '/' + service] = { image: before, imageId: before, at: new Date().toISOString() }
      configStore.updateCompose({ rollbacks })
    }
    const pull = await runCompose({ binary: runtimeInfo.binary, project, action: 'pull', extra: [service], timeoutMs: 300_000 })
    const up = await runCompose({
      binary: runtimeInfo.binary,
      project,
      action: 'up',
      extra: ['-d', '--force-recreate', '--no-deps', service],
      timeoutMs: 300_000,
    })
    const after = await podmanImageId(project, service)
    log({
      at: new Date().toISOString(),
      principal,
      node: 'compose',
      action: 'compose.recreate-service',
      target: project.name + '/' + service,
      detail: { pullOk: pull.ok, upOk: up.ok, imageChanged: Boolean(before && after && before !== after) },
    })
    return {
      ok: up.ok,
      stage: up.ok ? 'done' : 'compose',
      message: up.ok
        ? '已重建 ' + service + (pull.ok ? '' : '（pull 失败，用的还是本地旧镜像）')
        : '重建 ' + service + ' 失败：' + summarizeFailure(up),
      pull: { ok: pull.ok, message: pull.ok ? '镜像已拉取。' : '拉取失败：' + summarizeFailure(pull) },
      imageChanged: Boolean(before && after && before !== after),
      rollbackImage: before || null,
      command: up.command,
      stdout: up.stdout,
      stderr: up.stderr,
      status: await detail(name),
    }
  }

  async function rollbackService(name, serviceName, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const rollback = (settings().rollbacks || {})[project.name + '/' + serviceName]
    if (!rollback || !rollback.image) return { ok: false, stage: 'args', message: '这个服务没有可回滚的旧镜像记录。' }
    updateServiceImage(project.file, serviceName, rollback.image)
    const result = await up(project.name, { principal })
    return { ...result, rolledBackTo: rollback.image, service: serviceName }
  }

  /** 某个服务的容器现在跑的是哪个 image id（拿不到就 null）。 */
  async function podmanImageId(project, service) {
    const listed = await detail(project.name)
    const item = (listed.services || []).find(entry => entry.name === service)
    if (!item) return null
    const containers = listed.containers || []
    const target = containers.find(container => container.service === service || container.name === item.container)
    return target ? (target.imageId || null) : null
  }

  /** down 会停服务，调用方必须先走待确认；这里只负责执行。 */
  async function runDown(name, { principal = 'panel' } = {}) {
    const { project } = findProject(name)
    const runtimeInfo = await runtimeStatus(settings())
    if (!runtimeInfo.ready) return { ok: false, stage: 'runtime', message: 'podman-compose 不可用。', hint: runtimeInfo.hint }
    const result = await runCompose({ binary: runtimeInfo.binary, project, action: 'down' })
    log({ at: new Date().toISOString(), principal, node: 'compose', action: 'compose.down', target: project.name, detail: { ok: result.ok } })
    return {
      ok: result.ok,
      stage: result.ok ? 'done' : 'compose',
      message: result.ok ? '已停止并移除。' : '停止失败：' + summarizeFailure(result),
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  /**
   * 日志直连容器，不绕 podman-compose：
   * 1.6.0 的 `logs` 不带服务名时什么都不输出，而按容器读永远有结果。
   */
  async function logs(name, { service = '', tail = 200 } = {}) {
    const { project } = findProject(name)
    const limit = Math.max(1, Math.min(2000, Number(tail) || 200))
    const all = await containers()
    const status = projectStatus(project, all)
    const targets = status.services
      .filter(item => item.hasContainer && item.container && (!service || item.name === service))
      .map(item => ({ service: item.name, container: item.container.name || item.container.id }))
    if (targets.length === 0) {
      return {
        ok: true,
        service: service || null,
        text: service ? '（服务 ' + service + ' 还没有容器，先启动一次）' : '（这个项目还没有容器，先启动一次）',
        targets: [],
      }
    }
    const node = registry.firstOfKind('podman')
    if (!node) return { ok: false, message: '找不到本机 Podman 节点。', text: '' }
    const chunks = []
    for (const target of targets) {
      try {
        const result = await registry.logs(node.id, target.container, limit)
        const text = (result && result.text) || ''
        chunks.push((targets.length > 1 ? '=== ' + target.service + ' ===\n' : '') + (text || '（没有输出）'))
      } catch (error) {
        chunks.push('=== ' + target.service + ' ===\n读日志失败：' + asCmError(error).message)
      }
    }
    return { ok: true, service: service || null, text: chunks.join('\n'), targets: targets.map(item => item.service) }
  }

  async function runtime() {
    const status = await runtimeStatus(settings())
    return {
      ...status,
      configuredRoot: settings().root || '',
      layout: ensureLayout(settings().root),
    }
  }

  async function install({ principal = 'panel' } = {}) {
    const result = await installRuntime({ version: settings().version })
    if (result.ok) {
      configStore.updateCompose({ binary: result.binary, installedAt: new Date().toISOString() })
    }
    log({ at: new Date().toISOString(), principal, node: 'compose', action: 'runtime.install', target: 'venv', detail: { ok: result.ok, version: result.version } })
    return result
  }

  /** 迁移预览：把 compose 服务渲染成等价 podman create，并指出会撞上哪些现有容器。 */
  async function adoptPreview(name) {
    const { project } = findProject(name)
    const all = await containers()
    const previews = project.services.map(service => {
      const containerName = containerNameOf(service, project.projectName)
      const existing = all.find(item => item.name === containerName) || null
      return {
        service: service.name,
        containerName,
        command: ['podman', 'create', ...renderServiceArgs(service, project.projectName, { projectDir: project.dir })],
        existing: existing
          ? {
            id: existing.id,
            state: existing.state,
            running: Boolean(existing.running),
            project: projectNameOf(existing),
          }
          : null,
      }
    })
    const touched = previews.filter(item => item.existing)
    return {
      name: project.name,
      projectName: project.projectName,
      dir: project.dir,
      file: project.file,
      previews,
      willStop: touched.map(item => ({ service: item.service, container: item.containerName, state: item.existing.state })),
      notes: [
        '迁移会停止并删除上面列出的现有容器，然后用 compose 重新创建。',
        'bind mount 的数据在宿主目录里，不受影响；匿名卷会跟着旧容器一起删。',
      ],
    }
  }

  /**
   * 迁移执行：先把旧的同名容器删掉（它已经在 compose 文件里被描述过了），
   * 再让 compose 按新谱子重建。删不掉就如实列出来，不硬着头皮继续。
   */
  async function runAdopt(name, { principal = 'panel' } = {}) {
    const preview = await adoptPreview(name)
    const node = registry.firstOfKind('podman')
    const removed = []
    for (const item of preview.previews) {
      if (!item.existing) continue
      if (!node) {
        removed.push({ container: item.containerName, ok: false, error: '找不到本机 Podman 节点。' })
        continue
      }
      try {
        await registry.act(node.id, item.containerName, 'delete')
        removed.push({ container: item.containerName, ok: true })
      } catch (error) {
        removed.push({ container: item.containerName, ok: false, error: asCmError(error).message })
      }
    }
    const failed = removed.filter(item => !item.ok)
    const upResult = failed.length > 0
      ? { ok: false, stage: 'adopt', message: '旧容器没删干净，先处理上面那几条再重建。' }
      : await up(name, { principal })
    log({
      at: new Date().toISOString(),
      principal,
      node: 'compose',
      action: 'compose.adopt',
      target: preview.name,
      detail: { removed: removed.length, failed: failed.length, ok: Boolean(upResult.ok) },
    })
    return {
      ok: Boolean(upResult.ok) && failed.length === 0,
      name: preview.name,
      removed,
      failed,
      up: upResult,
      notes: preview.notes,
    }
  }

  return {
    settings,
    layout: layoutOrThrow,
    list,
    detail,
    yamlText,
    redactedYamlText,
    writeYaml,
    setServicePorts,
    up,
    restart,
    recreateService,
    rollbackService,
    runDown,
    logs,
    runtime,
    install,
    adoptPreview,
    runAdopt,
    findProject,
  }
}
