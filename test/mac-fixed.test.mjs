import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeLxcCreate } from '../lib/create-spec.js'
import { assertMac, randomLxcMac } from '../lib/util.js'

/**
 * 容器网卡要固定 MAC：
 * - 后端：create-spec 缺省就生成一个并写死，给了就校验后用
 * - helper：render 输出 lxc.net.N.hwaddr，parse 读得回来，写入前查冲突
 * - 前端：新建表单和容器网络表单都得有这一栏 + 一个「随机换一个」
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')
const NET_CONFIG = readFileSync(join(ROOT, 'helper/net-config.mjs'), 'utf8')
const HELPER = readFileSync(join(ROOT, 'helper/dsh-lxcd.mjs'), 'utf8')

test('randomLxcMac 用 LXC 的 OUI，且每次都不同', () => {
  const list = Array.from({ length: 50 }, () => randomLxcMac())
  for (const mac of list) {
    assert.match(mac, /^00:16:3e:([0-9a-f]{2}:){2}[0-9a-f]{2}$/, 'MAC 格式不对：' + mac)
  }
  assert.ok(new Set(list).size > 45, '50 次里重复太多，随机性有问题')
})

test('assertMac 收合法值并转小写，拒绝残缺格式', () => {
  assert.equal(assertMac('00:16:3E:8A:1C:44'), '00:16:3e:8a:1c:44')
  for (const bad of ['00:16:3e:8a:1c', '00:16:3e:8a:1c:44:55', '00-16-3e-8a-1c-44', 'zz:16:3e:8a:1c:44', '']) {
    assert.throws(() => assertMac(bad), /MAC 地址 不合法/, '应该拒绝：' + bad)
  }
})

test('helper 既能渲染也能解析 hwaddr', () => {
  assert.ok(NET_CONFIG.includes('if (nic.hwaddr) lines.push'), '渲染里没写 hwaddr')
  assert.ok(NET_CONFIG.includes("else if (key === 'hwaddr') nic.hwaddr = value"), '解析里没读 hwaddr')
})

test('helper 写入前会查 MAC 冲突', () => {
  assert.ok(HELPER.includes('function macOwners(self)'), '没有冲突检查函数')
  assert.ok(HELPER.includes('已经被 ' + String.fromCharCode(36) + '{owner} 占用'), '缺冲突提示文案')
  assert.ok(HELPER.includes('settleMacs(nics, container)'), '保存网卡时没调冲突检查')
  assert.ok(HELPER.includes('if (/MAC .* 已经被|连试 8 次都撞车/.test'), '创建时 MAC 冲突被静默吞掉了')
})

test('自动生成 / 随机的 MAC 撞了就自己换，最多试 8 次', () => {
  assert.ok(HELPER.includes('function settleMacs(nics, self)'), '没有自动避让函数')
  assert.ok(HELPER.includes('for (let attempt = 0; attempt < 8 && clash; attempt += 1)'), '重试次数不对')
  assert.ok(HELPER.includes('swaps.push({ from, to: hit, owner })'), '换掉的 MAC 没记下来')
  assert.ok(HELPER.includes('function randomMac()'), 'helper 里没有 randomMac')
})

test('人手填的 MAC 撞车要拦住，不能悄悄换掉', () => {
  assert.ok(HELPER.includes('if (!nic.hwaddrAuto) {'), '手填的没有单独分支')
  assert.ok(HELPER.includes('想让它自己避让，点旁边的「随机」'), '报错里缺引导')
  assert.ok(NET_CONFIG.includes('if (raw.hwaddrAuto === true) nic.hwaddrAuto = true'), '标记没被保留')
})

test('新建表单有 MAC 一栏，且默认就预填一个', () => {
  assert.ok(CLIENT.includes('const [lxcMac, setLxcMac] = React.useState(d.lxcMac || randomMac())'), '进表单没预填 MAC')
  assert.ok(CLIENT.includes("fieldWide('MAC 地址'"), '缺 MAC 一栏')
  assert.ok(CLIENT.includes('随机换一个'), '缺重新生成按钮')
  assert.ok(CLIENT.includes('hwaddr: lxcMac.trim() || undefined'), '提交时没带 hwaddr')
})

test('容器网络表单也能改 MAC', () => {
  assert.ok(CLIENT.includes("const [nicMac, setNicMac] = React.useState('')"))
  assert.ok(CLIENT.includes("setNicMac(nic.hwaddr || '')"), '读网卡时没反解 hwaddr')
  assert.ok(CLIENT.includes('if (nicMac.trim()) {'), '保存时没带 hwaddr')
  assert.ok(CLIENT.includes('nic.hwaddr = nicMac.trim()'), '保存时没带 hwaddr')
  assert.ok(CLIENT.includes('这台建的时候没写 hwaddr'), '缺「没固定」的提示')
})

test('create-spec 传 hwaddrAuto，默认按自动算', () => {
  const auto = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0' } })
  assert.equal(auto.network.hwaddrAuto, true, '没表态应当按自动处理')
  const manual = normalizeLxcCreate({ name: 'a', network: { type: 'veth', link: 'lxcbr0', hwaddrAuto: false } })
  assert.equal(manual.network.hwaddrAuto, false, '明确 false 要保留')
})

test('前端两个表单都带 auto 标记，点「随机」会把它设回 true', () => {
  assert.ok(CLIENT.includes('const [lxcMacAuto, setLxcMacAuto] = React.useState(!d.lxcMac)'), '新建表单缺标记')
  assert.ok(CLIENT.includes('hwaddrAuto: lxcMacAuto'), '新建提交没带标记')
  assert.ok(CLIENT.includes('setLxcMac(randomMac()); setLxcMacAuto(true)'), '新建的「随机」没恢复自动')
  assert.ok(CLIENT.includes('setLxcMac(e.target.value); setLxcMacAuto(false)'), '手改没取消自动')
  assert.ok(CLIENT.includes('const [nicMacAuto, setNicMacAuto] = React.useState(false)'), '容器网卡表单缺标记')
  assert.ok(CLIENT.includes('if (nicMacAuto) nic.hwaddrAuto = true'), '容器网卡表单没传标记')
  assert.ok(CLIENT.includes('setNicMac(randomMac()); setNicMacAuto(true)'), '容器网卡的「随机」没恢复自动')
})

test('换过 MAC 会在 toast 里说清楚', () => {
  assert.ok(CLIENT.includes('function macSwapText(swaps)'), '缺提示函数')
  assert.ok(CLIENT.includes('MAC 撞车已自动避让'), '缺提示文案')
  assert.ok(CLIENT.includes('macSwapText(created.swaps)'), '创建成功没报')
})

test('概览里显示 MAC', () => {
  // 概览把网卡信息改成了分段拼接（原来是模板字符串一行到底），
  // 断言跟着实现走：只要 mac= 后面还挂着 hwaddr 和那句兜底提示就算数。
  assert.ok(CLIENT.includes("'mac=' + (nic.hwaddr || '（未固定，每次启动可能变）')"), '概览没显示 MAC')
  assert.ok(CLIENT.includes("nic.type + ' link=' + (nic.link || "), '概览没显示网卡链路')
})
