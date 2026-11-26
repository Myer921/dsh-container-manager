import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 回归：网络模块的每一块都得真渲染一次。
 *
 * 上一轮终端就是这样——签名改了、函数体没改，点进去整页消失。
 * 这里把六个视图从 client.js 里抠出来，用真 React 渲染，
 * 渲染期任何未定义变量、坏 prop 都会当场炸。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROFILE_ROOT = process.env.CM_PROFILE_ROOT || '/home/icecat/.dsh-next/profiles/web'
const CLIENT = readFileSync(join(ROOT, 'client.js'), 'utf8')

const selfRequire = createRequire(import.meta.url)
let React
let renderToStaticMarkup
try {
  React = selfRequire('react')
  ;({ renderToStaticMarkup } = selfRequire('react-dom/server'))
} catch {
  const fallback = createRequire(join(PROFILE_ROOT, 'package.json'))
  React = fallback('react')
  ;({ renderToStaticMarkup } = fallback('react-dom/server'))
}

/** 把一段顶层函数源码连同它依赖的同文件函数一起装进沙箱。 */
function build(names, extra) {
  const source = names.map((name) => {
    const marker = '    function ' + name + '('
    const start = CLIENT.indexOf(marker)
    assert.ok(start >= 0, 'client.js 里找不到函数 ' + name)
    const next = CLIENT.indexOf('\n    function ', start + marker.length)
    assert.ok(next > start, name + ' 后面没有别的函数，抽不出来')
    return CLIENT.slice(start, next)
  }).join('\n')
  const keys = Object.keys(extra)
  const factory = new Function('React', 'h', ...keys, source + '\nreturn { ' + names.join(', ') + ' }')
  return factory(React, React.createElement, ...keys.map((key) => extra[key]))
}

const Dot = ({ tone }) => React.createElement('span', { 'data-tone': tone ?? '' })
const sizeText = (bytes) => (bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : String(bytes) + ' B')
const downloadText = () => {}
const jget = async () => ({ ok: true, tables: [], raw: '' })
const jpost = async () => ({})

const hostNet = {
  problem: null,
  data: {
    ok: true,
    interfaces: [
      {
        name: 'enp125s0f0',
        type: 'ethernet',
        state: 'up',
        mtu: 1500,
        speed: 1000,
        driver: 'hns3',
        mac: 'a0:d8:07:75:8a:6c',
        addresses: [
          { family: 'inet', address: '192.0.2.10', prefix: 24, scope: 'global' },
          { family: 'inet6', address: 'fe80::1', prefix: 64, scope: 'link' },
        ],
        stats: { rxBytes: 2048, txBytes: 4096 },
      },
      {
        name: 'wgjump',
        type: 'wireguard',
        state: 'unknown',
        mtu: 1420,
        mac: '',
        addresses: [{ family: 'inet', address: '198.51.100.2', prefix: 24, scope: 'global' }],
        stats: { rxBytes: 512, txBytes: 256 },
      },
    ],
    routes: [
      { destination: 'default', gateway: '192.0.2.1', device: 'enp125s0f0', protocol: 'dhcp', metric: 100 },
      { destination: '10.0.3.0/24', gateway: '', device: 'lxcbr0', protocol: 'kernel', metric: 0 },
    ],
    dns: ['203.0.113.53'],
    connections: [
      { name: 'Ethernet connection 1', device: 'enp125s0f0', type: '802-3-ethernet', state: 'activated' },
      { name: 'Wired connection 1', device: '', type: '802-3-ethernet', state: '' },
    ],
    listeners: [{ address: '0.0.0.0', port: 22 }],
  },
}

test('HostInterfacesView：网卡、地址、流量都渲染出来', () => {
  const { HostInterfacesView } = build(['HostInterfacesView'], { Dot, sizeText, jpost })
  const html = renderToStaticMarkup(React.createElement(HostInterfacesView, {
    hostNet,
    busy: false,
    run: () => {},
  }))
  assert.match(html, /enp125s0f0/)
  assert.match(html, /192\.0\.2\.10\/24/)
  assert.match(html, /data-cm-netrow/)
  assert.match(html, /wireguard/)
  assert.match(html, /Ethernet connection 1/)
  // 没有设备的连接不给启停按钮
  assert.match(html, /Wired connection 1/)
})

test('HostInterfacesView：读不到时给原因，不空白', () => {
  const { HostInterfacesView } = build(['HostInterfacesView'], { Dot, sizeText, jpost })
  const html = renderToStaticMarkup(React.createElement(HostInterfacesView, {
    hostNet: { data: null, problem: 'ECONNREFUSED' },
    busy: false,
    run: () => {},
  }))
  assert.match(html, /ECONNREFUSED/)
})

test('HostRoutesView：路由表的五列都在', () => {
  const { HostRoutesView } = build(['HostRoutesView'], {})
  const html = renderToStaticMarkup(React.createElement(HostRoutesView, { hostNet }))
  assert.match(html, /default/)
  assert.match(html, /192\.0\.2\.1/)
  assert.match(html, /lxcbr0/)
  assert.match(html, /data-cm-table/)
  assert.match(html, /路由表（2）/)
})

test('HostDnsView：resolv.conf 与改 DNS 表单', () => {
  const { HostDnsView } = build(['HostDnsView', 'ConnectionDnsForm'], {})
  const html = renderToStaticMarkup(React.createElement(HostDnsView, {
    hostNet,
    busy: false,
    run: () => {},
  }))
  assert.match(html, /203\.0\.113\.53/)
  assert.match(html, /改 DNS/)
  assert.match(html, /data-cm-formrow/)
  assert.match(html, /Ethernet connection 1/)
})

test('FirewallPane：加载态能渲染，不炸', () => {
  const { FirewallPane } = build(['FirewallPane'], { jget, downloadText })
  const html = renderToStaticMarkup(React.createElement(FirewallPane, {}))
  assert.match(html, /读 nft 规则中/)
})

test('DiagnosePane：表单与提示都在', () => {
  const { DiagnosePane } = build(['DiagnosePane'], { Dot, jpost })
  const html = renderToStaticMarkup(React.createElement(DiagnosePane, {}))
  assert.match(html, /连通性诊断/)
  assert.match(html, /data-cm-formrow/)
  assert.match(html, /ping/)
})

test('网络分家：容器网络跟页面走，宿主那几个在「宿主网络」页', () => {
  const tabs = [...CLIENT.matchAll(/\['(\w+)', '([^']+)'\]/g)].map((m) => m[1])
  // 宿主网络页的五个 tab
  for (const key of ['interfaces', 'routes', 'dns', 'firewall', 'diagnose']) {
    assert.ok(tabs.includes(key), '缺 tab：' + key)
  }
  // 容器网络按页取，不再混在宿主那排里
  assert.match(CLIENT, /containerNetworksView\('podman'\)/)
  assert.match(CLIENT, /containerNetworksView\('lxc'\)/)
  assert.ok(!/netTab ===/.test(CLIENT), 'netTab 那套混排已经拆掉了')
  assert.match(CLIENT, /h\(HostInterfacesView, \{ hostNet, busy, run, editing: netEditing, onEdit: setNetEditing \}\)/)
})

test('HostInterfacesView：连接行带编辑按钮，网卡行能点开', () => {
  const { HostInterfacesView } = build(['HostInterfacesView'], { Dot, sizeText, jpost })
  const html = renderToStaticMarkup(React.createElement(HostInterfacesView, {
    hostNet,
    busy: false,
    run: () => {},
    editing: '',
    onEdit: () => {},
  }))
  assert.match(html, /编辑/)
  assert.match(html, /NetworkManager 连接/)
  assert.match(html, /Mb\/s/, '有速率的网卡要显示速率')
})

test('HostInterfacesView：邻居表跟着网卡展开', () => {
  const { HostInterfacesView } = build(['HostInterfacesView'], { Dot, sizeText, jpost })
  const withNeighbors = {
    problem: null,
    data: Object.assign({}, hostNet.data, {
      neighbors: [
        { address: '192.0.2.1', device: 'enp125s0f0', mac: '04:25:c5:00:00:01', state: 'REACHABLE' },
      ],
    }),
  }
  const html = renderToStaticMarkup(React.createElement(HostInterfacesView, {
    hostNet: withNeighbors,
    busy: false,
    run: () => {},
    editing: '',
    onEdit: () => {},
  }))
  // 默认收起，展开后才有邻居地址
  assert.ok(!/REACHABLE/.test(html), '默认不该直接铺开邻居')
  assert.match(html, /\+/, '网卡行要有展开标记')
})

const { field } = build(['field'], {})
const CONNECTION_TYPE_CHOICES = [
  ['bridge', '网桥'], ['bond', '链路聚合'], ['vlan', 'VLAN'],
  ['wireguard', 'WireGuard'], ['ethernet', '以太网'], ['macvlan', 'macvlan'],
  ['dummy', '虚拟接口（dummy）'],
]

test('ConnectionEditor：没数据时是加载态，不炸', () => {
  const { ConnectionEditor } = build(['ConnectionEditor'], { jget, jpost, sizeText, field })
  const html = renderToStaticMarkup(React.createElement(ConnectionEditor, {
    name: 'Ethernet connection 1',
    busy: false,
    run: () => {},
    onClose: () => {},
  }))
  assert.match(html, /读连接配置中/)
})

test('ConnectionCreateForm：类型选择与必填校验都在', () => {
  const { ConnectionCreateForm } = build(['ConnectionCreateForm'], { jpost, field, CONNECTION_TYPE_CHOICES })
  const html = renderToStaticMarkup(React.createElement(ConnectionCreateForm, {
    busy: false,
    run: () => {},
    onClose: () => {},
  }))
  assert.match(html, /新建连接/)
  assert.match(html, /网桥/)
  assert.match(html, /VLAN/)
  assert.match(html, /WireGuard/)
  assert.match(html, /创建（会挂起）/)
})
