/**
 * compose 子系统单测（v0.3.0）
 *
 * 每个模块都不碰真实 podman：发现、解析、渲染、预检、状态、写回全是纯逻辑，
 * 端口预检用 mock 的 ss 输出，写回在临时目录里改真文件。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { COMPOSE_FILES, discoverProjects, sanitizeProjectName } from '../lib/compose/discover.js'
import { parseCompose } from '../lib/compose/parse.js'
import { normalizeEnvironment, normalizeService, parsePortEntry, parseVolumeEntry, buildProject } from '../lib/compose/model.js'
import { renderServiceArgs, containerNameOf } from '../lib/compose/render.js'
import { checkPortConflicts, hostPorts, parseSsListeners } from '../lib/compose/ports.js'
import { projectStatus } from '../lib/compose/status.js'
import { listBackups, updateServicePorts, writeComposeText } from '../lib/compose/yaml-write.js'
import { composeLayout, ensureLayout } from '../lib/compose/layout.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'cm-compose-test-'))
}

function writeCompose(dir, fileName, body) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(file, body)
  return file
}

const SAMPLE = [
  '# 顶部注释',
  'services:',
  '  web:',
  '    image: alpine',
  '    ports:',
  '      - "8080:80"',
  '    environment:',
  '      A: "1"',
  '  worker:',
  '    image: alpine',
  '    command: sleep 60',
  '',
].join('\n')

test('compose 文件名优先级：compose.yaml 先于 docker-compose.yml', () => {
  assert.deepEqual(COMPOSE_FILES, ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'])
})

test('sanitizeProjectName：大小写、点、空格、中文都能变成合法项目名', () => {
  assert.equal(sanitizeProjectName('Foo'), 'foo')
  assert.equal(sanitizeProjectName('my.app'), 'my-app')
  assert.equal(sanitizeProjectName('a b'), 'a-b')
  assert.equal(sanitizeProjectName('-leading'), 'leading')
  assert.equal(sanitizeProjectName('_x'), 'p-_x')
  assert.equal(sanitizeProjectName('中文'), 'p-')
})

test('discoverProjects：只认一级子目录，没有 compose 的目录不出现', () => {
  const root = tempRoot()
  writeCompose(join(root, 'alpha'), 'docker-compose.yml', SAMPLE)
  writeCompose(join(root, 'beta'), 'compose.yaml', SAMPLE)
  mkdirSync(join(root, 'empty'), { recursive: true })
  mkdirSync(join(root, '.hidden'), { recursive: true })
  writeCompose(join(root, '.hidden'), 'docker-compose.yml', SAMPLE)
  writeCompose(join(root, 'deep', 'inner'), 'docker-compose.yml', SAMPLE)

  const result = discoverProjects(root)
  assert.equal(result.problem, null)
  assert.deepEqual(result.projects.map(item => item.name), ['alpha', 'beta'])
  assert.equal(result.projects.find(item => item.name === 'beta').fileName, 'compose.yaml')
})

test('discoverProjects：软链到目录的项目也算（仍然只看一层）', () => {
  const root = tempRoot()
  const real = tempRoot()
  writeCompose(real, 'compose.yaml', SAMPLE)
  symlinkSync(real, join(root, 'linked'))
  const result = discoverProjects(root)
  assert.equal(result.problem, null)
  assert.deepEqual(result.projects.map(item => item.name), ['linked'])
  // 指向文件、指向不存在的位置都不算
  const plain = tempRoot()
  const fileRoot = tempRoot()
  writeCompose(fileRoot, 'compose.yaml', SAMPLE)
  symlinkSync(join(fileRoot, 'compose.yaml'), join(plain, 'notadir'))
  symlinkSync(join(root, 'nowhere'), join(plain, 'dangling'))
  assert.deepEqual(discoverProjects(plain).projects, [])
})

test('discoverProjects：根目录没配 / 不存在 分别给出明确 problem', () => {
  assert.equal(discoverProjects('').problem, 'ROOT_EMPTY')
  const missing = discoverProjects('/definitely/not/here/cm-test')
  assert.equal(missing.problem, 'ROOT_UNREADABLE')
  assert.ok(missing.detail)
})

test('discoverProjects：两个目录 sanitize 后撞名要报冲突而不是悄悄覆盖', () => {
  const root = tempRoot()
  writeCompose(join(root, 'Foo'), 'docker-compose.yml', SAMPLE)
  writeCompose(join(root, 'foo'), 'docker-compose.yml', SAMPLE)
  const result = discoverProjects(root)
  assert.equal(result.projects.length, 1)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].projectName, 'foo')
})

test('parseCompose：正常文件能拿到服务与原文', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', SAMPLE)
  const parsed = parseCompose(file)
  assert.deepEqual(parsed.serviceNames, ['web', 'worker'])
  assert.equal(parsed.unsupported.length, 0)
  assert.ok(parsed.text.includes('# 顶部注释'))
})

test('parseCompose：不支持的键被收集，不静默忽略', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', [
    'services:',
    '  web:',
    '    image: alpine',
    '    deploy:',
    '      replicas: 3',
    '    profiles: [dev]',
    '    mystery_key: 1',
  ].join('\n'))
  const parsed = parseCompose(file)
  const keys = parsed.unsupported.map(item => item.key).sort()
  assert.deepEqual(keys, ['deploy', 'mystery_key', 'profiles'])
  assert.ok(parsed.unsupported.every(item => item.why))
})

test('parseCompose：语法错要带行列，且是 BAD_ARGS', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', ['services:', '  web:', '   image: alpine', '  bad: [1,'].join('\n'))
  assert.throws(() => parseCompose(file), (error) => {
    assert.equal(error.code, 'BAD_ARGS')
    assert.match(error.message, /第 \d+ 行/)
    return true
  })
})

test('parseCompose：没有 services 直接拒绝', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', 'version: "3"\n')
  assert.throws(() => parseCompose(file), (error) => error.code === 'BAD_ARGS')
})

test('parsePortEntry：常见写法全覆盖，写错要给原因而不是瞎猜', () => {
  const cases = [
    { input: '8080:80', expect: { parsed: true, hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '' } },
    { input: '127.0.0.1:8080:80', expect: { parsed: true, hostIp: '127.0.0.1', hostPort: 8080 } },
    { input: '8080:80/udp', expect: { parsed: true, protocol: 'udp' } },
    { input: '80', expect: { parsed: true, hostPort: null, containerPort: 80 } },
    { input: '8000-8005:80-85', expect: { parsed: true, range: true, hostPort: 8000, hostPortEnd: 8005 } },
    { input: '[::1]:8080:80', expect: { parsed: true, hostIp: '::1' } },
  ]
  for (const item of cases) {
    const parsed = parsePortEntry(item.input)
    for (const [key, value] of Object.entries(item.expect)) {
      assert.equal(parsed[key], value, item.input + ' 的 ' + key)
    }
  }
  const bad = parsePortEntry('a:b:c:d')
  assert.equal(bad.parsed, false)
  assert.match(bad.reason, /IPv6/)
  assert.equal(parsePortEntry('8080:99999').parsed, false)
})

test('parsePortEntry：长语法对象也能读', () => {
  const parsed = parsePortEntry({ target: 80, published: 8080, protocol: 'udp', host_ip: '127.0.0.1' })
  assert.equal(parsed.hostPort, 8080)
  assert.equal(parsed.containerPort, 80)
  assert.equal(parsed.protocol, 'udp')
  assert.equal(parsed.hostIp, '127.0.0.1')
})

test('parseVolumeEntry：bind / named volume / ro 分得清', () => {
  assert.equal(parseVolumeEntry('./data:/data').type, 'bind')
  assert.equal(parseVolumeEntry('/abs:/data').type, 'bind')
  assert.equal(parseVolumeEntry('mydata:/data').type, 'volume')
  assert.equal(parseVolumeEntry('./cfg:/cfg:ro').readOnly, true)
  assert.equal(parseVolumeEntry('/tmp').type, 'tmpfs')
})

test('normalizeEnvironment：对象与数组两种写法归一到同一种形状', () => {
  assert.deepEqual(normalizeEnvironment({ A: '1', B: null }), [{ key: 'A', value: '1' }, { key: 'B', value: null }])
  assert.deepEqual(normalizeEnvironment(['A=1', 'B']), [{ key: 'A', value: '1' }, { key: 'B', value: null }])
})

test('renderServiceArgs：相对 bind 源与 env_file 都变成项目目录下的绝对路径', () => {
  const service = normalizeService('web', {
    image: 'alpine',
    ports: ['8080:80'],
    volumes: ['./data:/data:ro'],
    env_file: ['./web.env'],
    environment: { A: '1' },
  })
  const args = renderServiceArgs(service, 'demo', { projectDir: '/opt/dsh-container/podman/demo' })
  const joined = args.join(' ')
  assert.match(joined, /-v \/opt\/dsh-container\/podman\/demo\/data:\/data:ro/)
  assert.match(joined, /--env-file \/opt\/dsh-container\/podman\/demo\/web\.env/)
  assert.match(joined, /-p 8080:80/)
  assert.match(joined, /--label com.docker.compose.project=demo/)
})

test('containerNameOf：与 podman-compose 的命名保持一致', () => {
  assert.equal(containerNameOf({ name: 'web' }, 'demo'), 'demo_web_1')
  assert.equal(containerNameOf({ name: 'web', containerName: 'my-web' }, 'demo'), 'my-web')
})

test('parseSsListeners：能从 ss 输出里认出端口与占用进程', () => {
  const text = [
    'LISTEN 0 4096 0.0.0.0:18080 0.0.0.0:* users:(("python3",pid=888,fd=21))',
    'LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=700,fd=3))',
    'UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* ',
  ].join('\n')
  const listeners = parseSsListeners(text)
  assert.ok(listeners.has('18080/tcp'))
  assert.equal(listeners.get('18080/tcp')[0].pid, 888)
  assert.ok(listeners.has('22/tcp'))
  assert.ok(listeners.has('5353/udp'))
})

test('checkPortConflicts：占用的端口被点名，空闲的不报', async () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', [
    'services:',
    '  web:',
    '    image: alpine',
    '    ports:',
    '      - "18080:80"',
    '      - "18081:81"',
  ].join('\n'))
  const project = buildProject(parseCompose(file), { name: 'p', projectName: 'p', dir: join(root, 'p'), file, fileName: 'docker-compose.yml' })
  assert.deepEqual(hostPorts(project).map(item => item.port), [18080, 18081])
  const result = await checkPortConflicts(project, {
    exec: async () => parseSsListeners('LISTEN 0 4096 0.0.0.0:18080 0.0.0.0:* users:(("python3",pid=888,fd=21))'),
  })
  assert.equal(result.supported, true)
  assert.deepEqual(result.conflicts.map(item => item.port), [18080])
  assert.equal(result.conflicts[0].owner.name, 'python3')
})

test('checkPortConflicts：ss 不可用时如实说 supported=false，不假装没冲突', async () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', ['services:', '  web:', '    image: alpine', '    ports: ["8080:80"]'].join('\n'))
  const project = buildProject(parseCompose(file), { name: 'p', projectName: 'p', dir: join(root, 'p'), file, fileName: 'docker-compose.yml' })
  const result = await checkPortConflicts(project, { exec: async () => { throw new Error('no ss') } })
  assert.equal(result.supported, false)
  assert.equal(result.conflicts.length, 0)
  assert.match(result.detail, /ss 不可用/)
})

test('projectStatus：期望与实际的三种状态都对得上', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', [
    'services:',
    '  web:',
    '    image: alpine',
    '  api:',
    '    image: alpine',
    '  db:',
    '    image: alpine',
  ].join('\n'))
  const project = buildProject(parseCompose(file), { name: 'p', projectName: 'p', dir: join(root, 'p'), file, fileName: 'docker-compose.yml', mtimeMs: 1000 })
  const containers = [
    { id: 'a', name: 'p_web_1', state: 'running', running: true, created: '2026-11-21T00:00:00Z', labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'web' }, ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }] },
    { id: 'b', name: 'p_api_1', state: 'exited', running: false, created: '2026-11-21T00:00:00Z', labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'api' }, ports: [] },
    { id: 'c', name: 'p_ghost_1', state: 'running', running: true, created: '2026-11-21T00:00:00Z', labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'ghost' }, ports: [] },
  ]
  const status = projectStatus(project, containers)
  assert.deepEqual(status.counts, { total: 3, running: 1, exited: 1, created: 0, missing: 1 })
  assert.deepEqual(status.services.map(item => item.state), ['running', 'exited', 'missing'])
  assert.deepEqual(status.extra.map(item => item.service), ['ghost'])
})

test('yaml-write：改端口保留注释与其他服务，并留备份', () => {
  const root = tempRoot()
  const dir = join(root, 'p')
  const file = writeCompose(dir, 'docker-compose.yml', SAMPLE)
  const result = updateServicePorts(file, 'web', ['9090:80', '9443:443/udp'])
  const after = readFileSync(file, 'utf8')
  assert.ok(after.includes('# 顶部注释'))
  assert.ok(after.includes('- "9090:80"'))
  assert.ok(after.includes('9443:443/udp'))
  assert.ok(after.includes('worker:'))
  assert.ok(result.backup && existsSync(result.backup))
  const parsed = parseCompose(file)
  assert.deepEqual(parsed.services.web.ports, ['9090:80', '9443:443/udp'])
})

test('yaml-write：非法端口写法被拒，文件不动', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', SAMPLE)
  const before = readFileSync(file, 'utf8')
  assert.throws(() => updateServicePorts(file, 'web', ['这什么东西']), (error) => error.code === 'BAD_ARGS')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('yaml-write：整份替换前先校验，坏 YAML 不落盘', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', SAMPLE)
  const before = readFileSync(file, 'utf8')
  assert.throws(() => writeComposeText(file, 'services: [unclosed'), (error) => error.code === 'BAD_ARGS')
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.ok(listBackups(file).length === 0)
})

test('yaml-write：备份最多留 10 份', () => {
  const root = tempRoot()
  const file = writeCompose(join(root, 'p'), 'docker-compose.yml', SAMPLE)
  for (let index = 0; index < 13; index += 1) {
    updateServicePorts(file, 'web', ['90' + index + ':80'])
  }
  const backups = readdirSync(join(root, 'p')).filter(name => name.includes('.cm-bak-'))
  assert.equal(backups.length, 10)
})

test('layout：基础目录派生 podman 与 lxc 两个子目录，缺了会建', () => {
  const layout = composeLayout('/opt/dsh-container')
  assert.equal(layout.podmanRoot, '/opt/dsh-container/podman')
  assert.equal(layout.lxcRoot, '/opt/dsh-container/lxc')
  assert.equal(composeLayout('').configured, false)

  const root = tempRoot()
  const created = ensureLayout(root)
  assert.equal(created.problem, null)
  assert.equal(created.created.length, 2)
  assert.ok(existsSync(join(root, 'podman')))
  assert.ok(existsSync(join(root, 'lxc')))
  const again = ensureLayout(root)
  assert.equal(again.created.length, 0)
})
