import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 层级回归：新建容器、宿主网络是「整台机器」的事，
 * 挂在单个容器的 tab 条里会让人以为是在这个容器里新建什么。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

function slice(from, to) {
  const start = CLIENT.indexOf(from)
  assert.ok(start >= 0, '找不到：' + from)
  const end = CLIENT.indexOf(to, start + from.length)
  assert.ok(end > start, '找不到结束标记：' + to)
  return CLIENT.slice(start, end)
}

test('容器级的 tab 里没有「新建」和「网络」', () => {
  // 只截到 nodeTabs 之前，否则会连节点级那行一起算进去
  const block = slice('const containerTabs = [', 'const nodeTabs')
  assert.ok(!block.includes("'create'"), '新建不该出现在容器 tab 里')
  assert.ok(!block.includes("'networks'"), '网络不该出现在容器 tab 里')
  // 容器自己的那几页要还在
  for (const name of ["'overview'", "'logs'", "'config'", "'terminal'"]) {
    assert.ok(block.includes(name), '容器 tab 少了 ' + name)
  }
  // 快照与挂载已不再占一级 tab，收进配置页的分段控件。｜此处断言它们不在一级 tab 里。
  assert.ok(!block.includes("'snapshots'") && !block.includes("'mounts'"), '快照与挂载不该再占一级 tab')
})

test('节点级的 tab 只有概览与新建', () => {
  assert.match(CLIENT, /const nodeTabs = \['overview', 'create'\]/)
})

test('tab 状态跨层切换时能安全回落', () => {
  // 从容器切回节点视图时旧 tab 可能不在新一层里，必须回落到第一个
  assert.match(CLIENT, /const activeTab = tabs\.includes\(tab\) \? tab : tabs\[0\]/)
  // 渲染与内容分发都得用 activeTab，不能还用原始 tab
  assert.match(CLIENT, /h\(PaneBoundary, \{ key: activeTab/)
  assert.match(CLIENT, /if \(activeTab === 'create'\) return createView\(\)/)
})

test('选中容器时有「回到节点视图」的入口', () => {
  assert.match(CLIENT, /'data-cm-back': ''/)
  assert.match(CLIENT, /'← 全部容器'/)
  assert.match(CLIENT, /onClick: \(\) => \{ setSelected\(null\); setTab\('overview'\) \}/)
})

test('顶部的「＋ 新建」按当前页落到对应容器子 tab', () => {
  assert.match(CLIENT, /onClick: startCreate/)
  assert.match(CLIENT, /function startCreate\(\)/)
  // 在 LXC 页就留在 LXC 页新建，否则回 Podman
  assert.match(CLIENT, /function startCreate\(\) \{[\s\S]{0,200}setLxcTab\('containers'\)/)
  assert.match(CLIENT, /function startCreate\(\) \{[\s\S]{0,400}setPodmanTab\('containers'\)/)
})

test('节点分组里的「网络」跳到那一页的网络子 tab', () => {
  assert.match(CLIENT, /onClick: \(\) => openNodeNetworks\(node\)/)
  assert.match(CLIENT, /function openNodeNetworks\(node\)/)
  assert.match(CLIENT, /setLxcTab\('networks'\)/)
  assert.match(CLIENT, /setPodmanTab\('networks'\)/)
})
