import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 新建 LXC 容器的发行版 / 版本要能真的点开选。
 *
 * 以前是 input + datalist：浏览器点输入框不会展开全部选项（只在输入时按前缀过滤提示），
 * 所以看起来就是「下拉打不开，只显示 alpine」。同一排的架构 / 网桥 / IPv4 用的是 select，都正常。
 * 现在换成 select，另留「其他（手填）」保住手填能力。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const SPEC = readFileSync(join(ROOT, 'lib/create-spec.js'), 'utf8')

test('datalist 那套已经拆掉', () => {
  assert.ok(!/cm-distro-list/.test(CLIENT), 'datalist id 还在')
  assert.ok(!/cm-release-list/.test(CLIENT), 'datalist id 还在')
  assert.ok(!/list: 'cm-distro-list'/.test(CLIENT), 'input 还挂着 datalist')
})

test('发行版与版本都用原生 select', () => {
  assert.match(CLIENT, /field\('发行版'/)
  assert.match(CLIENT, /field\('版本'/)
  // 两个字段各有一个 data-cm-select 的 select
  const selects = CLIENT.match(/field\('(?:发行版|版本)'/g) || []
  assert.equal(selects.length, 2, '应该正好两个字段')
  assert.match(CLIENT, /field\('发行版'[\s\S]{0,400}'data-cm-select'/)
  assert.match(CLIENT, /field\('版本'[\s\S]{0,400}'data-cm-select'/)
})

test('候选 + 当前值去重：手填的值也要出现在选项里', () => {
  assert.match(CLIENT, /const optionsWith = \(current, list\) =>/)
  assert.match(CLIENT, /if \(current && !all\.includes\(current\)\) all\.unshift\(current\)/)
  // 两个字段都走它
  assert.match(CLIENT, /optionsWith\(distro, suggestions\.map/)
  assert.match(CLIENT, /optionsWith\(release, releasesFor\(distro\)\)/)
})

test('留了「其他（手填）」的口子', () => {
  assert.match(CLIENT, /'其他（手填）'/)
  assert.match(CLIENT, /const \[manualDistro, setManualDistro\] = React\.useState\(false\)/)
  assert.match(CLIENT, /const \[manualRelease, setManualRelease\] = React\.useState\(false\)/)
  // 手填模式下能退回候选
  assert.match(CLIENT, /onClick: back \}, '候选'/)
})

test('候选来自后端 /lxc/templates，不是前端硬编码', () => {
  assert.match(CLIENT, /jget\('\/lxc\/templates'\)/)
  assert.match(SPEC, /export const LXC_TEMPLATE_SUGGESTIONS = \[/)
  // 八个发行版一个不少
  for (const distro of ['debian', 'ubuntu', 'alpine', 'archlinux', 'fedora', 'centos', 'rocky', 'opensuse']) {
    assert.match(SPEC, new RegExp("distro: '" + distro + "'"))
  }
})

test('候选不是白名单：后端仍按正则校验', () => {
  // 白名单在 helper/net-config.mjs，create-spec 只是 import 进来用
  assert.match(SPEC, /import \{ ARCHES, DISTROS, RELEASES \} from '\.\.\/helper\/net-config\.mjs'/)
  assert.match(SPEC, /if \(!DISTROS\.test\(distro\)\)/)
  assert.match(SPEC, /if \(!RELEASES\.test\(release\)\)/)
})

test('/images 两种节点返回形状都能接住', () => {
  // Podman 数组 / LXC 对象，不能用 Array.isArray 一刀切
  assert.match(CLIENT, /setImages\(Array\.isArray\(data\) \? data : \(data && Array\.isArray\(data\.images\) \? data\.images : \[\]\)\)/)
})
