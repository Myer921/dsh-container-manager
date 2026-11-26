/**
 * 服务 → podman 参数（v0.3.0）
 *
 * 用途只有两个：给迁移/up 做「将会执行什么」的预览，以及给端口预检做校验。
 * 真正执行仍交给 podman-compose（混合方案的边界）。
 *
 * 一个必须做对的细节：compose 里的 `./config:/config` 是**相对 compose 文件所在目录**的，
 * 而 podman 只认绝对路径。所以 bind 源和 build context 都要基于 projectDir 解析，
 * 否则预览出来的命令直接把人坑了。
 */

import { isAbsolute, resolve } from 'node:path'

function absoluteFrom(projectDir, value) {
  if (!value) return value
  if (value.startsWith('~')) return value
  return isAbsolute(value) ? value : resolve(projectDir || '.', value)
}

/** 容器名规则与 podman-compose 1.6.0 实测一致：<project>_<service>_1。 */
export function containerNameOf(service, projectName) {
  if (service.containerName) return service.containerName
  return projectName + '_' + service.name + '_1'
}

function commandArgs(command) {
  if (command === null || command === undefined) return []
  if (Array.isArray(command)) return command.map(String)
  return ['/bin/sh', '-c', String(command)]
}

function entrypointArgs(entrypoint) {
  if (entrypoint === null || entrypoint === undefined) return []
  if (Array.isArray(entrypoint)) return entrypoint.map(String)
  return ['/bin/sh', '-c', String(entrypoint)]
}

function portArgs(port) {
  if (!port || !port.parsed || port.hostPort === null) return []
  const protocol = port.protocol && port.protocol !== 'tcp' ? '/' + port.protocol : ''
  if (port.range) {
    const args = []
    const hostCount = port.hostPortEnd - port.hostPort
    const containerCount = port.containerPortEnd - port.containerPort
    const count = Math.max(hostCount, containerCount)
    for (let index = 0; index <= count; index += 1) {
      const host = port.hostPort + index
      const container = port.containerPort + (containerCount === 0 ? 0 : index)
      if (host > port.hostPortEnd) break
      const hostPart = port.hostIp ? port.hostIp + ':' : ''
      args.push('-p', hostPart + host + ':' + container + protocol)
    }
    return args
  }
  const hostPart = port.hostIp ? port.hostIp + ':' : ''
  return ['-p', hostPart + port.hostPort + ':' + port.containerPort + protocol]
}

function volumeArg(volume, projectDir) {
  if (!volume) return null
  if (volume.type === 'tmpfs') return volume.raw
  const source = volume.type === 'bind' ? absoluteFrom(projectDir, volume.source) : volume.source
  const base = source ? source + ':' + volume.target : volume.target
  return volume.readOnly ? base + ':ro' : base
}

function healthArgs(healthcheck) {
  if (!healthcheck || healthcheck.disabled) return []
  const test = healthcheck.test
  if (!test || test.length === 0) return []
  const first = test[0]
  let command = ''
  if (first === 'CMD' || first === 'CMD-SHELL') command = test.slice(1).join(' ')
  else if (first === 'NONE') return []
  else command = test.join(' ')
  if (!command) return []
  const args = ['--health-cmd', command]
  if (healthcheck.interval) args.push('--health-interval', healthcheck.interval)
  if (healthcheck.timeout) args.push('--health-timeout', healthcheck.timeout)
  if (healthcheck.retries !== null && healthcheck.retries !== undefined) args.push('--health-retries', String(healthcheck.retries))
  if (healthcheck.startPeriod) args.push('--health-start-period', healthcheck.startPeriod)
  return args
}

/**
 * 一个服务 → podman create 的参数（不含可执行文件名）。
 * 注意：这里生成的是「等价于 compose 声明」的命令，用来给人看与做预检；
 * podman-compose 自己生成的命令在某些键上可能不同（healthcheck 的 bug 已知）。
 */
export function renderServiceArgs(service, projectName, { includeName = true, projectDir = '' } = {}) {
  const args = []
  if (includeName) args.push('--name', containerNameOf(service, projectName))

  const projectLabels = [
    ['com.docker.compose.project', projectName],
    ['com.docker.compose.service', service.name],
    ['com.docker.compose.container-number', '1'],
    ['io.podman.compose.project', projectName],
    ['io.podman.compose.version', '1.6.0'],
  ]
  for (const [key, value] of projectLabels) args.push('--label', key + '=' + value)
  for (const label of service.labels || []) args.push('--label', label.value === '' ? label.key : label.key + '=' + label.value)

  if (service.hostname) args.push('--hostname', service.hostname)
  if (service.user) args.push('--user', service.user)
  if (service.workingDir) args.push('--workdir', service.workingDir)
  if (service.privileged) args.push('--privileged')
  if (service.readOnly) args.push('--read-only')
  if (service.tty) args.push('--tty')
  if (service.init) args.push('--init')
  if (service.restart) args.push('--restart', service.restart)
  if (service.memLimit) args.push('--memory', service.memLimit)
  if (service.cpus) args.push('--cpus', service.cpus)
  if (service.shmSize) args.push('--shm-size', service.shmSize)
  if (service.pid) args.push('--pid', service.pid)
  if (service.networkMode) args.push('--network', service.networkMode)
  if (service.stopGracePeriod) args.push('--stop-timeout', service.stopGracePeriod)

  for (const cap of service.capAdd || []) args.push('--cap-add', cap)
  for (const cap of service.capDrop || []) args.push('--cap-drop', cap)
  for (const device of service.devices || []) args.push('--device', device)
  for (const server of service.dns || []) args.push('--dns', server)
  for (const domain of service.dnsSearch || []) args.push('--dns-search', domain)
  for (const host of service.extraHosts || []) args.push('--add-host', host)
  for (const mount of service.tmpfs || []) args.push('--tmpfs', mount)
  for (const [key, value] of Object.entries(service.sysctls || {})) args.push('--sysctl', key + '=' + String(value))

  for (const item of service.environment || []) {
    args.push('-e', item.value === null ? item.key : item.key + '=' + item.value)
  }
  for (const file of service.envFiles || []) args.push('--env-file', absoluteFrom(projectDir, file))

  for (const port of service.ports || []) args.push(...portArgs(port))
  for (const volume of service.volumes || []) {
    const rendered = volumeArg(volume, projectDir)
    if (rendered) args.push('-v', rendered)
  }

  if (!service.networkMode) {
    for (const network of service.networks || []) {
      const alias = network.aliases && network.aliases.length > 0 ? ':' + network.aliases.join(',') : ''
      args.push('--network', network.name + alias)
    }
  }

  args.push(...healthArgs(service.healthcheck))

  const entrypoint = entrypointArgs(service.entrypoint)
  if (entrypoint.length > 0) args.push('--entrypoint', JSON.stringify(entrypoint))

  if (service.build) args.push(service.image || projectName + '_' + service.name)
  else args.push(service.image || 'scratch')
  args.push(...commandArgs(service.command))
  return args
}

/** 给人看的完整命令（含 podman 前缀）。 */
export function renderCommand(service, projectName, options = {}) {
  return ['podman', 'create', ...renderServiceArgs(service, projectName, options)]
}
