import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeInspect, normalizePsRow, parseHealth } from '../lib/drivers/podman.js'

/**
 * 健康检查回归：
 *  - 从 ps 的 Status 文本里读健康（不为一个徽章多跑一次 inspect）
 *  - 读不到就是 null，绝不把「没有健康检查」写成「健康」
 *  - inspect 里带连续失败次数与最近输出，面板据此画卡
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('健康状态从 Status 文本里读得出来', () => {
  assert.equal(parseHealth('Up 2 minutes (healthy)'), 'healthy')
  assert.equal(parseHealth('Up 2 minutes (unhealthy)'), 'unhealthy')
  assert.equal(parseHealth('Up 3 seconds (starting)'), 'starting')
  assert.equal(parseHealth('Up 3 seconds (health: starting)'), 'starting')
})

test('没有健康检查的容器是 null，不是 healthy', () => {
  assert.equal(parseHealth('Up 2 minutes'), null)
  assert.equal(parseHealth('Exited (0) 2 minutes ago'), null)
  assert.equal(parseHealth(undefined), null)
  assert.equal(parseHealth(''), null)
})

test('ps 行带上 health 字段', () => {
  const row = normalizePsRow({ Id: 'abc', Names: ['demo'], Image: 'nginx', State: 'running', Status: 'Up 5m (unhealthy)' })
  assert.equal(row.health, 'unhealthy')
  const healthy = normalizePsRow({ Id: 'abd', Names: ['demo2'], Image: 'nginx', State: 'running', Status: 'Up 5m' })
  assert.equal(healthy.health, null)
})

test('inspect 里带失败次数与最近输出，长日志只留尾部 20 条', () => {
  const log = Array.from({ length: 30 }, (_, index) => ({
    Start: '2026-11-24T0' + (index % 10) + ':00:00Z',
    ExitCode: index === 29 ? 1 : 0,
    Output: 'probe ' + index,
  }))
  const detail = normalizeInspect({
    Id: 'abc123def456',
    Name: '/demo',
    State: { Status: 'running', Running: true, Health: { Status: 'unhealthy', FailingStreak: 7, Log: log } },
    Config: { Image: 'nginx', Env: [] },
    HostConfig: {},
    NetworkSettings: {},
    Mounts: [],
  })
  assert.equal(detail.health.status, 'unhealthy')
  assert.equal(detail.health.failingStreak, 7)
  assert.equal(detail.health.log.length, 20)
  assert.equal(detail.health.log[19].output, 'probe 29')
  assert.equal(detail.health.log[19].exitCode, 1)
})

test('没有健康检查的 inspect 是 health: null', () => {
  const detail = normalizeInspect({
    Id: 'abc', Name: '/demo',
    State: { Status: 'running', Running: true },
    Config: { Env: [] }, HostConfig: {}, NetworkSettings: {}, Mounts: [],
  })
  assert.equal(detail.health, null)
})

test('列表只在「失败 / 检查中」挂字，健康时不打扰', () => {
  assert.ok(CLIENT.includes("container.health && container.health !== 'healthy'"), '健康时不画徽章')
  assert.ok(CLIENT.includes("container.health === 'unhealthy' ? ' 健康检查失败' : ' 健康检查中'"))
})

test('详情页有健康卡，带连续失败次数与最近输出', () => {
  assert.ok(CLIENT.includes("'健康检查'"), '缺少健康检查卡标题')
  assert.ok(CLIENT.includes("'连续失败 ' + health.failingStreak + ' 次'"), '缺少连续失败次数')
  assert.ok(CLIENT.includes("'data-cm-healthlog': ''"), '缺少输出列表')
  assert.ok(CLIENT.includes("Number(entry.exitCode) === 0 ? 'ok' : 'bad'"), '退出码要分色调')
})

test('健康徽章三种状态各有色调，未读到时是「未知」', () => {
  const css = CLIENT.slice(CLIENT.indexOf("[data-cm-health]"), CLIENT.indexOf('[data-cm-healthlog]'))
  for (const tone of ["data-tone='healthy'", "data-tone='unhealthy'", "data-tone='starting'"]) {
    assert.ok(css.includes(tone), '缺少 ' + tone + ' 的样式')
  }
  assert.ok(CLIENT.includes(": '未知')"))
})
