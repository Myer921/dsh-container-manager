import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQuadletList,
  isQuadletFile,
  parseQuadlet,
  parseSystemctlShow,
  pickEntry,
  quadletUnit,
} from '../lib/quadlet.js'

const SAMPLE = `# 一个最小的 rootless quadlet
[Unit]
Description=demo container

[Container]
Image=docker.io/library/alpine:3.22
PublishPort=8080:80
PublishPort=8443:443
Volume=demo-data.volume:/data
Exec=sh -c 'sleep infinity'   ; 行内分号不是注释，别乱切
`

test('解析出段与键，注释跳过，行内分号不当注释', () => {
  const { groups, problems } = parseQuadlet(SAMPLE)
  assert.deepEqual(problems, [])
  assert.deepEqual(groups.map(group => group.name), ['Unit', 'Container'])
  assert.equal(pickEntry(groups, 'Unit', 'Description'), 'demo container')
  assert.equal(pickEntry(groups, 'Container', 'Image'), 'docker.io/library/alpine:3.22')
  assert.match(pickEntry(groups, 'Container', 'Exec'), /; 行内分号/)
})

test('续行会被拼起来', () => {
  const { groups } = parseQuadlet('[Container]\nImage=alpine\nExec=sh -c \\\n  "echo hi"\n')
  assert.equal(pickEntry(groups, 'Container', 'Exec'), 'sh -c "echo hi"')
})

test('坏文件给出问题清单，不抛异常', () => {
  const { problems } = parseQuadlet('这不是ini\n[Container]\nImage=x\n')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /key=value/)
})

test('文件名 → unit 名，非 quadlet 返回 null', () => {
  assert.equal(quadletUnit('demo.container'), 'demo.service')
  assert.equal(quadletUnit('demo.pod'), 'demo.service')
  assert.equal(quadletUnit('data.volume'), 'data.volume')
  assert.equal(quadletUnit('net.network'), 'net.network')
  assert.equal(quadletUnit('demo.service'), null)
  assert.equal(quadletUnit('.container'), null)
})

test('临时文件（点开头）不算 quadlet', () => {
  assert.equal(isQuadletFile('demo.container'), true)
  assert.equal(isQuadletFile('.demo.container.swp'), false)
  assert.equal(isQuadletFile('demo.service'), false)
})

test('清单里带镜像、端口、pod、目录，且按文件名排序', () => {
  const { items, problems } = buildQuadletList([
    {
      dir: '/home/u/.config/containers/systemd',
      files: [
        { name: 'b.container', text: '[Container]\nImage=alpine\n' },
        { name: 'a.container', text: '[Unit]\nDescription=A\n[Container]\nImage=busybox\nPublishPort=9000:9000\nPod=x.pod\n[Install]\nWantedBy=default.target\n' },
        { name: 'not-a-quadlet.txt', text: 'x' },
      ],
    },
  ])
  assert.deepEqual(items.map(item => item.file), ['a.container', 'b.container'])
  assert.equal(items[0].unit, 'a.service')
  assert.equal(items[0].image, 'busybox')
  assert.deepEqual(items[0].publish, ['9000:9000'])
  assert.equal(items[0].pod, 'x.pod')
  assert.equal(items[0].wantedBy, 'default.target')
  assert.equal(items[0].path, '/home/u/.config/containers/systemd/a.container')
  assert.deepEqual(problems, [])
})

test('systemctl show 的多 unit 输出按空行切开', () => {
  const text = [
    'Id=demo.service',
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    '',
    'Id=other.service',
    'LoadState=not-found',
    'ActiveState=inactive',
    'SubState=dead',
    '',
  ].join('\n')
  const states = parseSystemctlShow(text)
  assert.equal(states.size, 2)
  assert.equal(states.get('demo.service').activeState, 'active')
  assert.equal(states.get('other.service').loadState, 'not-found')
})
