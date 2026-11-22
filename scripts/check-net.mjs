import { registerTools } from '../lib/tools.js'

// 只验证 net 模块在真实宿主上跑通（不启动插件、不碰 HTTP）。
import { hostNetwork, firewallSummary, diagnose } from '../lib/net.js'

const host = await hostNetwork()
console.log('接口数', host.interfaces.length)
console.log('  样例', host.interfaces.map(i => i.name + ':' + i.type + ':' + i.state).join(' '))
console.log('路由数', host.routes.length, '| DNS', host.dns.join(','), '| 连接数', host.connections.length, '| 监听端口', host.listeners.length)
const fw = await firewallSummary()
console.log('防火墙 ok=' + fw.ok, fw.tables.map(t => t.family + '/' + t.name + '(' + t.chains + '链)').join(' '))
// 网关从真实路由里取，别写死一个地址 —— 这台机器的网段只有它自己知道。
const gateway = (host.routes.find(row => row.destination === 'default' || row.dst === 'default') || {}).gateway
if (gateway) {
  const ping = await diagnose(gateway, { count: 2 })
  console.log('ping 网关 ' + gateway + ' ok=' + ping.ok, ping.rtt ? 'avg ' + ping.rtt.avg + 'ms' : ping.reason)
} else {
  console.log('找不到默认网关，跳过 ping')
}
await import('../lib/tools.js').then(() => console.log('tools.js 可加载'))
