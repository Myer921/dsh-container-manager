import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Podman 与 LXC 彻底分页。
 *
 * 以前两套运行时都塞在「容器」一页里，靠节点 kind 在同一个列表里混着渲染，
 * 镜像也只有一个（Podman 的）。现在顶部四段：Podman / LXC / 宿主网络 / 活动，
 * 每段有自己的子 tab；两个「镜像」页也是各自的。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const HELPER = readFileSync(join(ROOT, 'helper/dsh-lxcd.mjs'), 'utf8')
const API = readFileSync(join(ROOT, 'lib/api.js'), 'utf8')
const ACTIONS = readFileSync(join(ROOT, 'lib/actions.js'), 'utf8')
const TOOLS = readFileSync(join(ROOT, 'lib/tools.js'), 'utf8')
const INSTALL = readFileSync(join(ROOT, 'helper/install-helper.sh'), 'utf8')

test('顶部四段：Podman / LXC / 宿主网络 / 活动', () => {
  const views = [...CLIENT.matchAll(/\['(\w+)', '([^']+)'\]/g)].map(m => m[1])
  for (const key of ['podman', 'lxc', 'host', 'activity']) {
    assert.ok(views.includes(key), '顶部缺：' + key)
  }
  // 「项目」不再是顶级导航，它成了 Podman 页的子 tab —— 只检查 VIEWS 自己那一块，
  // 别用固定长度的窗口去盯（挪动代码后窗口会吃到下面的 PODMAN_TABS）
  const viewsBlock = CLIENT.match(/const VIEWS = \[([\s\S]*?)\n    \]/)
  assert.ok(viewsBlock, '找不到 VIEWS 数组')
  assert.ok(!viewsBlock[1].includes("'projects'"), '「项目」不该是顶级导航')
  assert.ok(viewsBlock[1].includes("'podman'") && viewsBlock[1].includes("'lxc'"), 'VIEWS 里该有 podman/lxc')
})

test('每页有自己的子 tab，而且分开存', () => {
  assert.match(CLIENT, /const PODMAN_TABS = \[/)
  assert.match(CLIENT, /const LXC_TABS = \[/)
  assert.match(CLIENT, /const HOST_TABS = \[/)
  // 三份 state 分开，切页不会丢位置
  assert.match(CLIENT, /const \[podmanTab, setPodmanTab\] = React\.useState\('containers'\)/)
  assert.match(CLIENT, /const \[lxcTab, setLxcTab\] = React\.useState\('containers'\)/)
  assert.match(CLIENT, /const \[hostTab, setHostTab\] = React\.useState\('interfaces'\)/)
})

test('LXC 页有自己的镜像页，Podman 那格还是原来的', () => {
  assert.match(CLIENT, /function LxcImagesPane\(/)
  assert.match(CLIENT, /h\(LxcImagesPane, \{ nodeId: lxcNodeId/)
  assert.match(CLIENT, /h\(ImagesPane, \{ nodeId: podmanNodeId/)
})

test('LXC 页有存储页', () => {
  assert.match(CLIENT, /function LxcStoragePane\(/)
  assert.match(CLIENT, /h\(LxcStoragePane, \{ nodeId: lxcNodeId/)
  assert.match(CLIENT, /jget\('\/lxc\/storage\?node='/)
})

test('容器列表只遍历当前页那一类节点', () => {
  assert.match(CLIENT, /const activeKind = view === 'lxc' \? 'lxc' : 'podman'/)
  assert.match(CLIENT, /nodes\.filter\(node => node\.kind === activeKind\)/)
  // 节点 chip 也按页过滤
  assert.match(CLIENT, /nodes\.filter\(node => node\.kind === \(view === 'lxc' \? 'lxc' : 'podman'\)\)/)
})

test('helper 把镜像缓存写到 /opt/dsh-container/lxc/image', () => {
  assert.match(HELPER, /const IMAGE_ROOT = process\.env\.LXCD_IMAGE_ROOT \|\| '\/opt\/dsh-container\/lxc\/image'/)
  assert.match(HELPER, /LXC_CACHE_PATH: IMAGE_ROOT/, '靠模板自己的 LXC_CACHE_PATH 生效')
  assert.match(HELPER, /case '\/lxc\/images':/)
  assert.match(HELPER, /case '\/lxc\/images\/delete':/)
  assert.match(HELPER, /case '\/lxc\/storage':/)
})

test('装 helper 时会把老缓存搬过去', () => {
  assert.match(INSTALL, /\/var\/cache\/lxc\/download/)
  assert.match(INSTALL, /IMAGE_ROOT/)
})

test('删 LXC 镜像走待确认', () => {
  assert.match(ACTIONS, /kind: 'lxc\.image\.delete'/)
  assert.match(ACTIONS, /record\.kind === 'lxc\.image\.delete'/)
  assert.match(ACTIONS, /registry\.deleteLxcImage\(/)
  assert.match(API, /registry\.kindOf\(node\) === 'lxc'/)
})

test('AI 有镜像的读写工具，两套运行时共用一个名字', () => {
  assert.match(TOOLS, /name: 'container_image_list'/)
  assert.match(TOOLS, /name: 'container_image_delete'/)
  // 删的时候按 kind 分流，不能拿 Podman 的删法去删 LXC 缓存
  assert.match(TOOLS, /registry\.kindOf\(node\) === 'lxc'/)
})
