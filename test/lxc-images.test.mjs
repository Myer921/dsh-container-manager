import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * LXC 系统镜像缓存。
 *
 * 系统镜像以前散在 /var/cache/lxc/download 里，插件看不到、也管不了。
 * 现在统一落到 /opt/dsh-container/lxc/image，helper 能列能删能算占用。
 * 这里钉住目录布局与「只删扫得到的」这条安全边界。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = readFileSync(join(ROOT, 'helper/dsh-lxcd.mjs'), 'utf8')
const DRIVER = readFileSync(join(ROOT, 'lib/drivers/lxc.js'), 'utf8')
const NODES = readFileSync(join(ROOT, 'lib/nodes.js'), 'utf8')

test('目录布局：<root>/download/<distro>/<release>/<arch>/<variant>/rootfs.tar.xz', () => {
  assert.match(HELPER, /const IMAGE_DOWNLOAD = join\(IMAGE_ROOT, 'download'\)/)
  assert.match(HELPER, /'rootfs\.tar\.xz'/)
  // 扫描要按四层走
  assert.match(HELPER, /function scanImageCache\(\)/)
})

test('扫描只认可带 rootfs.tar.xz 的目录', () => {
  assert.match(HELPER, /if \(!existsSync\(rootfs\)\) continue/,
    '没镜像的目录要跳过')
})

test('名字去掉 default 变体，跟界面上看到的一致', () => {
  assert.match(HELPER, /variant === 'default'/)
})

test('过期信息从模板写的 expiry 文件读', () => {
  assert.match(HELPER, /'expiry'/)
  assert.match(HELPER, /expired/)
})

test('删除只接受扫得到的名字或路径', () => {
  assert.match(HELPER, /async function deleteImageCache\(target\)/)
  // 先扫一遍，再在结果里找；找不到就报错，不 rm 任意路径
  assert.match(HELPER, /scanImageCache\(\)\.find\(item => item\.name === wanted \|\| item\.path === wanted\)/)
  assert.match(HELPER, /if \(!hit\) throw new HelperError\('NOT_FOUND'/)
})

test('删镜像会记审计', () => {
  assert.match(HELPER, /action: 'lxc\.image\.delete'/)
})

test('删完顺手剪掉空的父目录', () => {
  assert.match(HELPER, /readdirSync\(dir\)\.length === 0/)
  assert.match(HELPER, /rmSync\(dir, \{ recursive: true, force: true \}\)/)
})

test('存储页要的几样东西都在：缓存、容器磁盘、分区', () => {
  assert.match(HELPER, /function storageInfo\(\)/)
  assert.match(HELPER, /function diskUsage\(path\)/)
  assert.match(HELPER, /statfsSync/)
  assert.match(HELPER, /images:/)
  assert.match(HELPER, /containers:/)
  assert.match(HELPER, /containersTotal/)
})

test('驱动把三个新接口接上了', () => {
  assert.match(DRIVER, /listImages\(\)/)
  assert.match(DRIVER, /deleteImage\(name\)/)
  assert.match(DRIVER, /storage\(\)/)
  assert.match(DRIVER, /call\('\/lxc\/images'/)
  assert.match(DRIVER, /call\('\/lxc\/images\/delete'/)
  assert.match(DRIVER, /call\('\/lxc\/storage'/)
})

test('registry 按 kind 分流：Podman 走镜像库，LXC 走缓存', () => {
  assert.match(NODES, /function kindOf\(nodeId\)/)
  assert.match(NODES, /function deleteLxcImage\(nodeId, name\)/)
  assert.match(NODES, /function lxcStorage\(nodeId\)/)
  assert.match(NODES, /kindOf,/)
  assert.match(NODES, /deleteLxcImage,/)
  assert.match(NODES, /lxcStorage,/)
})
