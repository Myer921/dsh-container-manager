/**
 * 项目状态（v0.3.0）
 *
 * 期望来自 compose 文件，实际来自 podman 标签。两边对不上就说对不上，
 * 不要用「看起来正常」糊过去。
 */

const PROJECT_KEYS = ['com.docker.compose.project', 'io.podman.compose.project']
const SERVICE_KEYS = ['com.docker.compose.service', 'io.podman.compose.service']
const WORKDIR_KEYS = ['com.docker.compose.project.working_dir', 'io.podman.compose.workdir']

export function labelValue(labels, keys) {
  if (!labels || typeof labels !== 'object') return ''
  for (const key of keys) {
    const value = labels[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export function projectLabel(container) {
  return labelValue(container && container.labels, PROJECT_KEYS)
}

export function serviceLabel(container) {
  return labelValue(container && container.labels, SERVICE_KEYS)
}

/** 容器名反推服务名：<project>_<service>_1 / <project>-<service>-1。 */
function serviceFromName(name, projectName) {
  if (!name || !projectName) return ''
  for (const sep of ['_', '-']) {
    const prefix = projectName + sep
    if (!name.startsWith(prefix)) continue
    const rest = name.slice(prefix.length)
    const parts = rest.split(sep)
    if (parts.length >= 2) return parts.slice(0, parts.length - 1).join(sep)
  }
  return ''
}

function stateOf(container) {
  if (!container) return 'missing'
  const state = String(container.state || '').toLowerCase()
  if (container.running) return 'running'
  if (state === 'created') return 'created'
  if (state === 'paused') return 'paused'
  if (state === 'exited' || state === 'stopped') return 'exited'
  return state || 'unknown'
}

/**
 * @param {object} project buildProject 的结果
 * @param {Array} containers 该节点全部容器（mapContainer 的形状，含 labels）
 */
export function projectStatus(project, containers) {
  const mine = (Array.isArray(containers) ? containers : []).filter(item => {
    const label = projectLabel(item)
    if (label) return label === project.projectName
    return serviceFromName(item && item.name, project.projectName) !== ''
  })

  const byService = new Map()
  for (const container of mine) {
    const service = serviceLabel(container) || serviceFromName(container && container.name, project.projectName)
    if (service && !byService.has(service)) byService.set(service, container)
  }

  const services = project.services.map(service => {
    const container = byService.get(service.name) || null
    return {
      name: service.name,
      image: service.image || (service.build ? '(本地构建)' : ''),
      state: stateOf(container),
      hasContainer: Boolean(container),
      container: container
        ? {
          id: container.id,
          name: container.name,
          state: container.state,
          running: Boolean(container.running),
          startedAt: container.startedAt || null,
        }
        : null,
      publishedPorts: (container && container.ports ? container.ports : []).map(port => ({
        host: port.hostPort || port.host || '',
        container: port.containerPort || port.container || '',
        protocol: port.protocol || 'tcp',
        ip: port.hostIp || '',
      })),
      expectedPorts: service.ports.filter(port => port.parsed && port.hostPort !== null).map(port => ({
        host: port.hostPort,
        container: port.containerPort,
        protocol: port.protocol,
        ip: port.hostIp || '',
      })),
    }
  })

  const counts = { total: services.length, running: 0, exited: 0, created: 0, missing: 0 }
  for (const service of services) {
    if (service.state === 'running') counts.running += 1
    else if (service.state === 'missing') counts.missing += 1
    else if (service.state === 'created') counts.created += 1
    else counts.exited += 1
  }

  const extra = []
  for (const [service, container] of byService) {
    if (!project.services.some(item => item.name === service)) {
      extra.push({ service, container: container && container.name })
    }
  }

  // 「有没有未应用的变更」：算不出 compose 自己的 config-hash，只能拿文件 mtime 和容器创建时间比。
  // 所以这个结论标成 rough，UI 上要说清是粗略判断。
  const newestContainer = mine.reduce((latest, item) => {
    const created = item && item.created ? Date.parse(item.created) : NaN
    return Number.isFinite(created) && created > latest ? created : latest
  }, 0)
  const stale = mine.length > 0 && project.mtimeMs > newestContainer + 1000

  return {
    name: project.name,
    projectName: project.projectName,
    dir: project.dir,
    file: project.file,
    fileName: project.fileName,
    services,
    counts,
    extra,
    stale,
    staleCertainty: 'rough',
    unsupported: project.unsupported || [],
    warnings: project.warnings || [],
    dynamic: project.dynamic || [],
  }
}
