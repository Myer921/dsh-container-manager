# 容器台设计记录

写给三个月后的自己：为什么是现在这个形状，哪些地方是踩出来的，哪些是故意没做。

---

## 1. 分层

```
┌──────────────────────────────────────────────────────────┐
│ 浏览器  client.js（左侧主面板）                            │
│   4s 轮询 GET /state（页面隐藏时停），动作 → POST /actions   │
└───────────────┬──────────────────────────────────────────┘
                │  HTTP + cookie，Host/Origin 校验
┌───────────────▼──────────────────────────────────────────┐
│ DSH host  lib/index.js                                    │
│   ├─ tools.js    8 个 AI 工具                             │
│   ├─ api.js      /api/container-manager/*                 │
│   └─ actions.js  ★ 唯一的动作入口，决定直行还是挂起        │
│        ├─ pending.js  待确认状态机（file + TTL + 一次性）  │
│        ├─ audit.js    审计 JSONL                          │
│        └─ nodes.js    节点注册表 → drivers/                │
│              ├─ podman.js  本地 execFile / ssh            │
│              └─ lxc.js     unix socket → helper           │
└───────────────┬──────────────────────────────────────────┘
                │  /run/dsh-container-manager/lxcd.sock
┌───────────────▼──────────────────────────────────────────┐
│ helper  dsh-lxcd.service（root）                          │
│   白名单路由 + execFile，不拼 shell，不暴露通用命令执行     │
└──────────────────────────────────────────────────────────┘
```

面板和 AI 走**同一套** actions：`container_action` 工具和面板的启停按钮调用的是同一个
`actions.containerAction`。不存在「AI 一条路、人一条路」，所以也不存在「AI 绕过确认」的后门。

---

## 2. 确认通道为什么只能是人

原本想让 AI 自己发起、人点确认。关键问题是：**AI 不能有确认能力**，否则就等于没有确认。

落地方式：

- 危险动作 → 服务端 `pendings.begin()`，返回 `{status:"pending", token}`
- `/actions/confirm` 除了要求登录态，还要求请求头 `x-cm-principal: panel`
- 浏览器半发请求时带这个头；工具层（`lib/tools.js`）**根本不提供调 confirm 的函数**，
  `pending_operations` 只读

所以「AI 能确认」不是靠约定，而是**代码里没有那条路**。模型能做的只有：发起、查询、等。

`confirmRequired: false` 可以整体关掉。这个开关是给人调试用的，关掉等于把确认权交给调用方——
README 里写明了不建议。

### 待确认状态机

```
        begin()
          │
          ▼
       pending ──── 过期(TTL) ────► expired
          │                            （take 时判定，不用定时器）
          ├──── cancel(panel) ─────► cancelled
          │
          └──── take()  ──► executing ──┬──► done
                                        └──► failed
```

几个刻意的选择：

- **一次性**：`take()` 是原子的（读-改-写同步完成），第二次取会撞 `executing/done` 直接报错。
  重复确认返回 400 而不是「再执行一遍」。
- **参数摘要**：`argsDigest` 记下发起时的参数，防止「确认 A、执行 B」的漂移。
- **TTL 惰性判定**：不起定时器，`take()` 时比时间。进程重启也不会漏掉过期项。
- **保留最近 100 条已完成**：面板要能回看「刚才那条到底做了什么」。

---

## 3. 驱动抽象

驱动只做两件事：**把命令拼对**、**把结果翻成统一形状**。

统一形状（`normalize*`）是这一版最重要的约定：

- `normalizePsRow`：podman 4.x 的输出是 PascalCase（`Names`/`State`/`Ports`），新版有的字段是 snake_case，
  两个都认，缺的给 `null` 而不是 `undefined`
- `normalizeInspect`：**环境变量只给键名**（`envKeys`），值一律不出现在响应里。
  这不是洁癖：容器 env 里常年躺着 token，面板一屏 JSON 就够了。
- `normalizeNetwork`：把 `subnets[0]` 摊平成 `subnet/gateway`，把 `containers` 摊平成数组

`execFile` 全程不经过 shell：容器名、镜像名、网络名都过校验器（`util.js`），
命令参数是一个数组。`--ip`、`-e`、`-v` 这些逐个 push，不做字符串拼接。

ssh 传输是预留的：`transport: "ssh"` 时命令变成
`ssh -o BatchMode=yes -o ConnectTimeout=8 -p <port> -i <key> user@host podman ...`。
**BatchMode=yes 是硬要求**——不能让 ssh 停下来问密码，那会把整个 node 的事件循环卡住。

---

## 4. helper 协议

unix socket 上的 HTTP，JSON in / JSON out，全部 POST，只有 `/health` 是 GET。

| 路由 | 说明 |
| --- | --- |
| `GET /health` | 版本、lxc 是否装、是否有 root |
| `POST /lxc/list` `/lxc/info` `/lxc/logs` `/lxc/action` `/lxc/create` | 容器 |
| `POST /lxc/net/get` `/lxc/net/set` | 读/改 `lxc.net.N.*` |
| `POST /net/list` `/net/host` `/net/bridge` `/net/module` | 宿主机网络与网桥 |

### 为什么不是「通用命令执行」

一个能跑任意命令的 root socket 等于把 root 递出去。所以：

- 路由是枚举的，没有 `/exec`
- `action` 走 `ACTION_ALLOW` 白名单（start/stop/restart/freeze/unfreeze/destroy）
- `module` 走 `MODULE_ALLOW` 白名单（macvlan/ipvlan/veth/bridge/8021q/br_netfilter）
- `execFile` + 参数数组，不拼 shell
- 网桥只认 `lxcbr0`，别的名字直接拒绝

### 改网卡配置的姿势

`lxc.net.*` 是「一坨行」，不是结构化数据。改法：

1. `parseConfigNet` 读成对象数组
2. `normalizeNic` 逐块校验（类型、link 必填、CIDR、MAC、MTU、macvlan.mode）
3. 备份 `config.cm-bak-<时间戳>`
4. `replaceNetSection` 只替换 `lxc.net.*` 段，**其它行原样保留**（include、cgroup、device 规则）
5. 需要时 `stop → start`（不是 restart：lxc 的 restart 在某些版本上不重新读网卡）

解析逻辑单独放 `helper/net-config.mjs`，因为它可以脱离 root 单测——
这是唯一一块「改错了会断网」的代码，必须能测。

---

## 5. 安全边界：故意不做的事

| 不做 | 原因 |
| --- | --- |
| 自动把物理网卡加进网桥 | 那是把自己的 SSH 断掉。用户要这么干，让他自己 `brctl`/`ip link` |
| 给 AI sudo | 提权只给白名单 helper，且 helper 自己也不知道「用户的意图」 |
| 让 AI 确认自己的操作 | 见第 2 节 |
| 在 inspect 里给 env 值 | token 泄漏面 |
| 面板一键 `podman system prune` | 不可逆、影响面不可预测，不该是按钮 |
| 自动 `modprobe` | 驱动通常已在内核里（实测能直接建卡），不需要 modprobe；helper 白名单只是兜底 |

macvlan 是唯一「不打断宿主」的接法：容器拿自己的 MAC 直接挂在物理网卡上，
宿主的 IP 不受影响。代价是容器和宿主之间可能互相 ping 不通（macvlan 的已知行为），
所以它只在用户明确要的时候启用，不设默认。

**2026-11-20 实测修正**：早先这里写「本机没有 macvlan 模块、DSH 不能 modprobe」，是错的。
真正的现象是 `modprobe -n macvlan` 报 `Module macvlan not found`，但那是 `/lib/modules` 权限 `d---------`
加上 `/usr/lib/modules` 被空 tmpfs 遮蔽，modprobe 根本读不到目录。而在 userns+netns 里：

```
ip link add d0 type dummy && ip link add mv0 link d0 type macvlan mode bridge   → 成功
ip link add iv0 link d1 type ipvlan mode l2                                     → 成功
ip link add x0 type nosuchdriver                                                → Error: Unknown device type.
```

驱动在内核里（`CONFIG_MACVLAN=m`，且已被 podman 加载过）。所以 macvlan 的关键前提不是「先 modprobe」，
而是**调用方有没有 CAP_NET_ADMIN**。

---

## 6. 踩过的坑

1. **`crun: sethostname: Operation not permitted`**
   这台 arm64 机器上 rootless 容器建不了独立 UTS namespace。
   手动 `podman run` 也一样失败，不是插件写错。
   **2026-11-20 找到真凶**：不是 crun 也不是 rootless 限制，是宿主 systemd 给 dsh-next 装的 seccomp
   filter 挡住了 `sethostname`。证据：在 user namespace 里已经是 uid=0（有 CAP_SYS_ADMIN），
   调 `socket.sethostname()` 仍 `PermissionError: [Errno 1]`，而同环境 `mount -t tmpfs` 成功。
   关掉宿主 unit 里的 `ProtectHostname`（以及 `ProtectSystem`，见第 7 节）后就不需要降级了。
   → `create` 遇到这个 stderr 时清理半成品、自动用 `--uts=host` 重试，并把原因放进 `warnings`。
   半成品清理是必须的：crun 失败时容器已经进了 storage（`created` 状态），不清掉重试会撞名。
   清理前先 `podman container exists` 确认，避免误删用户的同名容器。

2. **`RuntimeDirectory=` 把 socket 目录变成 root:root 0750**
   那样 普通用户连不上。→ 不用 `RuntimeDirectory`，helper 自己 `mkdir 0770` + `chown root:<gid>`。

3. **`ProtectSystem=full` 导致写不了 `/etc/default/lxc-net`**
   → 改 `ProtectSystem=yes`（`/usr` 只读，`/etc` 可写），`ProtectHome=read-only` 保留。

4. **ESM 文件装到 `/usr/local/lib` 没有 package.json**
   `.js` 会被当 CommonJS。→ 改名 `.mjs`，install 脚本与 service 同步。


---

## 7. 权限模型（2026-11-20 实测记录）

这一节是为了下次不用重查。所有结论都来自 `/proc/<pid>/status`、`systemctl show` 与对照实验。

### 主 unit 本身没有任何限制

`/etc/systemd/system/dsh-next.service` 里 `NoNewPrivileges=no`、`CapabilityBoundingSet` 全开、
`PrivateTmp=no`、`ProtectHome=no`，唯一写死的只有 `User=<你的运行用户>`。所以「加 capability」不是方向。

### 真正卡住的是 drop-in 里的 `Protect*`

`10-harden.conf` 原来写了 `ProtectSystem=strict` + `ProtectKernelModules` + `ProtectHostname`
+ `ProtectClock` + `ProtectControlGroups` + `ProtectKernelTunables` + `RestrictRealtime`。
这些项让 systemd 给进程装 **9 个 seccomp filter**，而 systemd 装了 seccomp filter 就会
**隐式设置 `NoNewPrivileges=yes`**（即使 unit 里写着 `NoNewPrivileges=no`）。
NNP 一旦设置**不可逆**，进程内没有任何办法清除 —— 只能从 unit 层解决。

于是 `sudo` 直接报 `The "no new privileges" flag is set`，这才是提权不起来的根因，
跟 sudoers 权限无关。

### 二分结论：`ProtectSystem` 是最后一个来源

删掉那四项之后 `Seccomp_filters` 从 9 降到 1，但 `NoNewPrivs` 仍是 1。对照实验：

```
老实例 dsh      : ProtectSystem=no    → NoNewPrivs: 0   Seccomp_filters: 0
新实例 dsh-next : ProtectSystem=full  → NoNewPrivs: 1   Seccomp_filters: 1
```

两边其余属性完全一致，唯一差别就是 `ProtectSystem`。要 `sudo` 可用，这一项也必须去掉。

顺带纠正一个常见误解：**`ProtectSystem=full` 也会把 `/etc` 设为只读**（`yes` 只读 `/usr`、
`/boot`、`/efi`；`full` 再加上 `/etc`；`strict` 是整个根）。所以「`/etc` 写不进」不是没生效，
是它本来就这样。

### 两条给 LXC 用的路

| 路线 | 怎么做 | 代价 |
| --- | --- | --- |
| **helper（默认，推荐）** | root 服务 `dsh-lxcd` + unix socket 0770 + 固定 10 个操作 | 需要用户手动装一次；能力被白名单圈住 |
| **sudo** | 去掉 `ProtectSystem` + `/etc/sudoers.d` 配 NOPASSWD | 等于把整台机器交给「任何能被我读到的内容」 |

插件本身对两条路都不假设：它只调 helper；helper 不在就返回 `HELPER_DOWN` + 安装命令，
不会假装能管 LXC。

### 最终落地的配置（2026-11-20）

两条路最后都开了，drop-in 收敛成四行：

```ini
[Service]
ProtectSystem=no
PrivateTmp=no
ProtectHome=no
NoNewPrivileges=no
```

实测结果：

| 项 | 值 |
| --- | --- |
| 进程 `NoNewPrivs` | `0` |
| `Seccomp_filters` | `0` |
| `sudo -n id` | `uid=0(root)` |
| 写 `/etc` | 可以（普通用户仍需 sudo，因为目录权限 755） |
| `sethostname` | 恢复：`podman run ... hostname` 返回容器短 ID，`--uts=private --hostname x` 返回 `x` |

也就是说，之前那个 `crun: sethostname: Operation not permitted` **确实是「宿主 systemd 的
`ProtectHostname`」而不是 rootless Podman 的限制** —— 这条被实测坐实了，不是推测。

### 装 helper 时踩到的四个坑

1. **root 的 PATH 里没有 node**：`install-helper.sh` 用 `command -v node` 找解释器，sudo 之后
   PATH 不含 nvm，直接报「找不到 node」。已改成 `command -v` 失败后再按
   `/home/<user>/.nvm/versions/node/*/bin/node`、`/usr/local/bin/node`、`/usr/bin/node` 找一遍。
2. **`systemctl enable --now` 不会替换已运行的服务**：重装 helper 后 PID 没变、跑的还是旧代码，
   表现为「明明改了却没效果」。已改成 `enable` + `restart`。
3. **漏 import 被 catch 吞成「静默空列表」**：把 `parseConfigNet` 等纯函数抽到 `net-config.mjs` 时，
   helper 里还留着 `NAME_RE.test(...)`，但 `NAME_RE` 没进 import 列表 → `listContainers` 抛
   `TypeError` → 外层 `catch { return [] }` 把它变成「有容器但列表是空」。
   修法是两头一起改：补 import，并且**让读目录失败直接抛 `HelperError`**，不再假装没有容器。
4. **手工前台跑 `dsh-lxcd.mjs` 会抢 socket**：它会 unlink 服务正在用的 socket 文件再自己 listen，
   退出后服务进程还活着但没人能连上。排障时不要用「手工跑一下看看」这招，用 `journalctl`。

---

## 8. 没做的（以及为什么先不做）

- **面板创建容器**：AI 工具已经能做；面板加表单要多一套端口/挂载/环境变量校验 UI，
  收益不如先把「日常开关 + 网络」打磨好。
- **LXC 创建**：`lxc-create -t download` 要联网拉 rootfs、要选发行版/版本/架构，
  失败模式比 Podman 多一个量级。helper 里留了 `/lxc/create` 路由，面板没接。
- **LXC 的 `direct` 传输**（用 `sudo lxc-*` 直连，绕过 helper）：helper 已经覆盖同一批能力，
  再写一套 `lxc-ls`/`lxc-info` 输出解析等于把已经踩过的坑重踩一遍，而且没有额外收益。
  真要做得先把「helper 挂了但 sudo 还在」当成真实场景再说 —— 现在不是。
- **容器内 exec**：`allowExec` 配置项和工具位都留了，但「在别人容器里跑命令」的权限模型
  值得单独一轮设计，不该顺手做掉。
- **多节点并发探测**：现在 `snapshot` 是串行 `Promise.all`，节点多了会慢。
  三个节点以内够用，再加再说。
---

## 9. 创建与配置的数据流（2026-11-21）

### 一份 spec，两套运行时

创建请求有两个入口：面板的 `POST /containers` 与 AI 的 `container_create`。两边都走
`lib/create-spec.js` 的 `normalizeCreate(kind, input)`，再交给 `actions.createContainer`：

```
面板 / AI  →  actions.createContainer({ node, spec })
                   ├─ nodeKind(node) 决定 podman 还是 lxc
                   ├─ normalizeCreate(kind, spec)   ← 唯一一处校验
                   └─ registry.createContainer(node, normalized)
                          ├─ podman: podman run -d [--restart] [--memory] [--cpus] ...
                          └─ lxc:    helper /lxc/create → lxc-create -t download
                                     → 写 lxc.start.auto / cgroup2.memory.max
                                     → lxc-start（可选）
```

为什么单独一个文件：如果 REST 与 tool 各写一套校验，迟早出现「AI 能建、面板建不了」。
`create-spec.js` 不碰进程也不碰磁盘，所以能脱离宿主机单测（17 项）。

### 创建不挂起，改配置挂起

| 操作 | 处理 | 理由 |
| --- | --- | --- |
| 创建容器 | 直接执行 | 不删数据，参数在面板上看得见 |
| 改 Podman 内存/CPU | 直接执行 | 可逆，改错再改回来 |
| 删除容器 | 挂起 | 不可撤销，数据卷不自动清 |
| 改网络拓扑 | 挂起 | 断网/换 IP 会打断服务 |
| 改 LXC 网卡 / 启动项 | 挂起 | 动的是 `/var/lib/lxc/<n>/config` 这个 root 文件 |

### 这一轮最值钱的发现：rootless 的假成功

`podman update --memory 256m` 在 rootless podman 4.3.1 上**返回 0，但什么都没改**：

```
$ podman update --memory 256m cm-limit-probe   # exit 0，无输出
$ podman inspect cm-limit-probe --format "{{.HostConfig.Memory}}"
536870912                                      # 还是原来的值
$ cat /sys/fs/cgroup/.../memory.max
max                                            # cgroup 根本没限制
```

`podman run --memory 512m` 也一样：`HostConfig.Memory` 记下了，`memory.max` 仍是 `max`。
原因不是没委派（`user@1001.service` 的 `DelegateControllers` 里有 `cpu memory pids`），
而是 podman 4.3.1 的 rootless cgroup v2 支持不完整。

**所以 `updateCgroup` 现在会读回来核对**：拿 `detail.limits.memory` 和目标字节数比，
不一致就抛 `PODMAN_ERROR` 并说明原因，而不是把 exit code 0 当成功。创建时带 `--memory`
同样只进配置不进 cgroup，会在 `warnings` 里写明。

这条是「不编数字」的具体落点：**命令返回成功 ≠ 事情做成了**，能验证就一定验证。

### 新增的路由

| 方法 | 路径 | 挂起? |
| --- | --- | --- |
| `POST` | `/containers` | 否 |
| `POST` | `/containers/:node/:ref/limits` | 否（假成功会报错） |
| `POST` | `/containers/:node/:ref/config` | 是 |
| `GET` | `/images?node=` | — |
| `GET` | `/lxc/templates` | — |

### 没做同名原地重建

「换重启策略 / 换端口」在这个 podman 上只能重建容器。面板给的是「以此配置新建」：
把旧容器的参数填进创建表单，建好、确认新容器正常之后，由用户自己删旧的。
不做「先删后建」的自动化 —— 那会在失败时把人家的容器删掉且没有退路。

---

## 10. v0.3.0：改成 compose 编排 + Cockpit 风格前端（2026-11-22）

### 为什么推翻「以此配置新建」

v0.2.0 改端口 / 重启策略只能「以此配置新建」—— 因为 rootless podman 4.3.1 的
`podman update` 不支持 `--restart`，端口更是完全改不了（`podman update` 没有 `--publish`）。
Cockpit 的 `cockpit-podman` 也一样：端口只能在创建时定，改就是重建。

用户明确要求「底层改为基于 podman-compose 设计，支持基于目录结构和对应目录下的
docker-compose.yml 的容器分组管理」。所以 v0.3.0 把容器分组整个交给 compose，
端口回到它本来该在的地方 —— YAML 里的一行文本。

### 目录约定是硬约束

```
<root>/podman/<项目>/compose.yaml   ← 一级子目录 = 一个项目
<root>/lxc/                          ← LXC 的约定目录
```

- **只认一级**，不往下钻。深层目录（`ukulele/src/compose.yaml`）不算项目，
  迁移时得把整个目录搬到 `podman/` 下 —— 这是有意的：一旦允许递归，
  「同名项目」和「意外扫到别人的 compose」就都来了。
- **compose 文件必须直接躺在子目录里**，理由同上。
- **项目显示名 = 子目录名**，同时用作 `-p` 的 project name。

### 混合执行器（自己读状态，compose 管生命周期）

`podman-compose` 只负责 up / down / restart，**状态一律自己算**：

- 列出所有 podman 容器（`registry.containersOfKind('podman')`）
- 按 label `com.docker.compose.project` / `io.podman.compose.project` 归到项目
- 服务的「应该存在」来自 YAML，「实际存在」来自容器，两者对比得出
  `missing` / `stale` / `running` / `exited`

不直接解析 `podman-compose ps` 的原因有两个：它的输出格式不稳（1.6.0 还是表格文本），
而且「YAML 里写了但容器没起」这种状态它不一定报出来。

### 永远 `--in-pod=false`

`podman-compose` 默认建 pod，1.6.0 在 rootless + cgroup v2 上建 pod 会多一层网络命名，
端口 publish 也会落在 pod 的 infra 容器上，和面板「一个容器一个名」的模型对不上。
所以 `runner.js` 里把 `--in-pod=false` 写死，不给开关。

### 端口预检：up 之前先看谁在占

`ports.js` 读 `/proc/net/tcp(6)` 加 `ss -ltnu`，把宿主上已经在监听的端口列出来，
和 YAML 里要 publish 的宿主端口比。冲突就在 `up` 之前返回，附带「被谁占着」。

为什么不在 up 之后再报错：`podman-compose up` 遇到端口冲突会起一半再失败，
留下半个项目和几个 exited 容器。预检能避开这个中间态。

踩过的坑：一开始读 `ss` 的 `fields[4]`（peer 地址），结果永远找不到冲突 ——
本地地址是 `fields[3]`。

### 改端口写回 YAML 要保留注释

`yaml-write.js` 用 `yaml` 的 Document API（`parseDocument` + `setIn` + `String(doc)`），
不是 `parse` → 改对象 → `stringify`。后者会把注释、空行、键顺序全洗掉 ——
用户手里的 compose 文件是他们自己写的，不该被我们重排。

每次写之前留 `<file>.bak-<时间戳>`。

### 终端：为什么必须包一层 `script`

`podman exec -it <ref> sh` 直接在管道里跑会报 `not a tty` —— `-t` 要一个真 pty。
`script -qfec "<cmd>" /dev/null`（util-linux 2.38.1）会先开一个 pty 再 exec，
于是容器里看到 `/dev/pts/0`，交互式 shell 正常。

**代价**：`script` 不支持把 `TIOCSWINSZ` 转进去，所以窗口拖大拖小不会传到容器里。
xterm.js 的 `addon-fit` 只在本端量尺寸。这是已知限制，写在 README 里，不做假装。

### WebSocket 不引 `ws`

`ctx.webServer.registerUpgrade` 给的是裸 `net.Socket`，自己实现 RFC 6455 的握手和
帧解析只有 ~150 行（`lib/ws.js`），比多一个依赖干净。只支持文本帧加 ping/pong/close，
不支持分片（xterm 的输入都是小包，够用）。

认证复用 REST 那一套 `makeVerify`：升级请求带不上自定义头，所以看 `Host` 加 `Origin`
再加 Connection 的 cookie，限制在 `ALLOWED_HOSTS`（127.0.0.1 / localhost / ::1）内。

### LXC 按 PVE 对齐：加了什么，没加什么

**加了**：快照（`lxc-snapshot -L/-c/-r/-d`）、克隆（`lxc-copy -n -N`）、
挂载点（`lxc.mount.entry` 的读写）、创建时的内存上限、终端（`lxc-attach`）。

**没加**（PVE 有但我们先不做）：

- **迁移**：`lxc-copy` 跨机器要 rsync 加改网络配置，失败一半的状态很难收尾
- **checkpoint / CRIU**：这台没装 `criu`，装了也经常在 arm64 上崩
- **在线缩小 rootfs**：ext4 不支持在线缩容，扩可以缩不行 —— 只做扩会让人以为能缩

### ext4 上的快照不是 CoW

`lxc-snapshot` 在 ext4 上是**整份复制 rootfs**。界面上明说了这一点：
建快照的按钮下面常驻一行提示，回滚确认框再提醒一次。
btrfs / zfs 才能真 CoW，这台没有 —— 不假装有。

### 新增的路由

| 方法 | 路径 | 挂起 |
| --- | --- | --- |
| GET | `/compose/projects` | — |
| GET | `/compose/projects/:name` | — |
| GET | `/compose/projects/:name/yaml` | — |
| GET | `/compose/projects/:name/adopt` | — |
| GET | `/compose/projects/:name/logs` | — |
| GET | `/compose/runtime` | — |
| POST | `/compose/projects/:name/yaml` | 否（写前校验） |
| POST | `/compose/projects/:name/up` | 否（预检端口） |
| POST | `/compose/projects/:name/restart` | 否 |
| POST | `/compose/projects/:name/services/:svc/ports` | 否（写 YAML） |
| POST | `/compose/projects/:name/down` | 是 |
| POST | `/compose/projects/:name/adopt` | 是（会删旧容器） |
| POST | `/compose/runtime/install` | 否（要联网，慢） |
| GET | `/containers/:node/:ref/snapshots` | — |
| GET | `/containers/:node/:ref/mounts` | — |
| POST | `/containers/:node/:ref/snapshots` | 是 |
| POST | `/containers/:node/:ref/mounts` | 是 |
| POST | `/containers/:node/:ref/clone` | 否 |
| GET | `/volumes?node=` | — |
| POST | `/images/pull` | 否 |
| POST | `/images/delete` | 是 |
| POST | `/volumes/delete` | 是 |
| GET | `/static/:name` | —（只服务 vendor/） |

### 前端为什么不用 JSX

浏览器半走 `window.__ModuleLoader__.load({ id, factory })`，拿到的只有
`React.createElement`。DSH 的客户端构建不经过 Babel，写 `<div/>` 就是语法错误。
所以 `client.js` 里全是 `h('div', {...}, ...)` —— 长，但没有构建期依赖。

代价是可读性。缓解手段是把每个视图拆成一个 `function XxxView()`，
列表渲染统一用 `h(Component, props)`，不用内联三元堆嵌套。
