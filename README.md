# dsh-container-manager

在 DSH 里管容器：左边一个「容器」主面板，模型侧一套 AI 工具，管**本机 rootless Podman** 和
**本机 LXC**，能看状态、读日志、开关容器、改网络，**也能直接改容器端口**。

形状照着 Cockpit 的 `cockpit-podman` 抄：项目 / 容器 / 镜像 / 卷 / 网络五段导航，
终端用 vendored xterm.js 接进容器里。但底下不照抄 —— Cockpit 改不了端口（它只能重建），
这里改成 **podman-compose 编排**：`<根目录>/podman/<项目>/` 下放一份 compose 文件，
容器按目录分组，端口就是 YAML 里的一行，改完 `up` 就生效。

它不是 PVE 的替代品——没有虚拟机、没有开箱即用的模板市场。它做的是「手边这几台容器的日常」：
谁在跑、日志什么味、把谁接进哪个网络、改完 LXC 网卡别把自己网断掉。

---

## 两块，一个包

| 半边 | 位置 | 干什么 |
| --- | --- | --- |
| 浏览器 | `client.js` | 左侧主面板「容器」：项目 / 容器 / 镜像 / 卷 / 网络五段 + 内嵌终端 + 待确认抽屉 |
| 主机 | `lib/` | 35 个 AI 工具 + 一段系统提示词 + `/api/container-manager` REST + WebSocket 终端 |
| compose | `lib/compose/` | 发现项目、解析 YAML、算状态、改端口、调 podman-compose |
| 提权小助手 | `helper/` | `dsh-lxcd` root 服务，LXC 的全部真实操作由它执行 |
| 前端依赖 | `vendor/` | xterm.js 5.5.0 / addon-fit 0.10.0 / yaml 2.9.1，全部 vendored，不联网 |

LXC 为什么需要单独一个 root 服务：DSH 进程本身是 `CapEff=0` + `NoNewPrivs=1`，
跑不动 `lxc-start`，也 `modprobe` 不了。提权只能交给一个**白名单的** systemd 服务，
而不是把 sudo 递给模型。

---

## 安装

### 1. 接进 profile

```bash
cd ~/.dsh-next/profiles/web
pnpm add "link:/path/to/dsh-container-manager"
# 然后把 "dsh-container-manager" 加进 package.json 的 dsh.profile.bundles
sudo systemctl restart dsh-next
```

重启后左侧面板列表里会出现「容器」。`restart` 必须由你手动执行——DSH 重启会把自己一起杀掉。

### 2. LXC 那半边（可选）

只装插件不会动 LXC：没有 helper 时，`local-lxc` 节点会显示 `HELPER_DOWN`，
工具返回一条安装命令，面板上明确写「没装」。

```bash
sudo bash helper/install-helper.sh --dry-run   # 先看它要做什么
sudo bash helper/install-helper.sh             # 装 lxc + helper 并启动
```

它会：

1. `apt-get install -y lxc lxc-templates`（`--no-lxc` 可跳过）
2. 把 `dsh-lxcd.mjs` 与 `net-config.mjs` 装到 `/usr/local/lib/dsh-container-manager/`
3. 装 `dsh-lxcd.service`，`systemctl enable` + `restart`（重装靠 restart 换新代码，`enable --now` 对已在跑的服务不生效）
4. helper 自己建 `/run/dsh-container-manager/lxcd.sock`（`0770 root:<你的组>`）

**本机已经装过（2026-11-20）**，现状可以直接引用：

| 项 | 值 |
| --- | --- |
| lxc | `5.0.2`（lxc-templates `3.0.4.48`）|
| 服务 | `dsh-lxcd.service` active + enabled |
| socket | `/run/dsh-container-manager/lxcd.sock`，`srw-rw---- root:dsh` |
| 网桥 | `lxcbr0 10.0.3.1/24`（Debian 包默认 `USE_LXC_BRIDGE="true"`，装完自动就有，不是插件建的）|

> ⚠️ 别手工在前台跑 `dsh-lxcd.mjs` 来「试一下」。它会 unlink 掉服务正在用的 socket 文件再自己 listen，
> 被 Ctrl-C 之后服务进程还活着但已经没人能连上 —— 表现为接口全超时。真发生了就
> `sudo systemctl restart dsh-lxcd`。

卸载：`sudo bash helper/install-helper.sh --uninstall`（会先停服务、再删 unit 与文件；lxc 本体与容器不动）。

---

### 3. compose 那半边（推荐）

装完插件先**填一次根目录**：面板「项目」页第一张卡会要一个基础目录。
填 `/opt/dsh-container` 这种，插件自己在下面建两个子目录：

```
/opt/dsh-container/
  podman/                  ← 每个一级子目录 = 一个 compose 项目
    smokeping/
      compose.yaml         ← compose.yaml / docker-compose.yml / docker-compose.yaml 都认
  lxc/                     ← LXC 容器的约定目录（挂载点往这儿放）
```

约定有三条，都是硬的：

1. **只认一级子目录**，不往下钻。`podman/ukulele/src/compose.yaml` 不算项目，得把整个 `ukulele` 搬到 `podman/` 下。
2. **compose 文件必须直接躺在子目录里**，不能藏在 `deploy/` 之类的下一层。
3. **项目显示名 = 子目录名**。目录名同时被当作 compose project name（`-p`），所以会被规整成小写 + 只留 `[a-z0-9_-]`。

podman-compose 不用你自己装：第一次 `up` 时插件检查运行时，没有就在数据目录下建一个 venv
（`pip install podman-compose==1.6.0`，要联网）。装不上会降级成**只读** —— 能看项目和 YAML，
不能 up。面板上会写清楚卡在哪一步，不会假装成功。

也可以手动指定：`compose.binary` 指向已有的 `podman-compose`，`compose.version` 改 pin 的版本。
升级版本前记得跑一遍 `scripts/smoke-compose.mjs`。

---

## 面板能干什么

顶部五段导航：**Podman** / **LXC** / **宿主网络** / **体检** / **活动**。两套运行时各占一页，互不混排 ——
在 Podman 页只看得见 Podman 的节点和容器，LXC 页同理，两页的「镜像」也是各自的东西。
每页有自己的子 tab，切页回来位置还在。默认落在 Podman 页的「容器」。

「体检」是独立一页：它探的是**这台机能不能做某件事**（subuid / uidmap / 存储驱动 / cgroup /
linger / pasta / skopeo / LXC 后端），跟哪个运行时归属无关，挂在某一页底下会让人以为只管那一边。
每条检查都给原因和一条可复制的修复命令；探不出来就写 `unknown`，不猜。

### Podman 页

子 tab：项目 / 容器 / 镜像 / 卷 / 网络 / 密钥 / Quadlet。

#### 项目（compose）

- **根目录**：没配时整页只有一张「先填根目录」的卡。填 `/opt/dsh-container` 这种基础目录，
  插件自己在下面建 `podman/` 与 `lxc/`；建不了会直接给 `mkdir -p` + `chown` 那条命令，不静默失败
- **项目卡片**：每个一级子目录一个项目，显示服务数 / 运行数 / 端口；坏掉的 compose 文件标红并给出行列号
- **服务表**：服务名、镜像、容器、状态、publish 端口。只重建改过的服务，不是整项目重建
- **单服务拉新重建**：服务行上的「拉新重建」= 先 pull 这个服务的镜像，再 `up -d --force-recreate --no-deps <服务>`，
  别的服务连 recreate 都不进 —— 滚动更新只动一格，出问题也只影响那一格
- **改端口**：图形化编辑 `宿主:容器[/udp]`，写回 YAML 时**保留注释**、自动留 `.bak` 备份，改完点「应用」才 `up`
- **YAML 原文**：直接编辑整份 compose 文件，写前校验（解析不过就 400，不落盘）
- **日志**：直连容器读，不绕 `podman-compose logs`（1.6.0 不带服务名时什么都不输出）
- **迁移**：把手工 `podman run` 起的容器换成 compose 管 —— 先预览「会删哪个容器、重建哪个」，确认后才动

#### 迁移已经手工跑起来的容器

面板能接管 `podman run` 起的容器，但得先让它「变成项目」。以本机的 smokeping 为例：

```bash
# 1. 把目录放进项目根（软链也行，插件认软链到目录的项目）
ln -sfn /srv/smokeping /opt/dsh-container/podman/smokeping
#    或者真搬过去：mv /srv/smokeping /opt/dsh-container/podman/smokeping
```

2. 面板「项目」页刷新 —— 会出现 `smokeping` 卡片，服务状态是 `missing`（因为容器是手工起的，
   身上没有 compose 标签），下面「游离容器」里能看到 `catstar-next-smokeping`。这是对的，不是坏了。
3. 点项目卡上的「迁移」→ 先看预览：它会列出「会删掉哪个容器、按什么参数重建」。
   预览里 `willStop` 是空的就说明没有要替换的东西（纯新建）。确认无误再点确认。
4. 迁移 = 删旧容器 + `podman-compose up`。**bind mount 的宿主数据不受影响**，
   匿名卷会跟着旧容器一起消失 —— 预览里会写清楚。

smokeping 这份 compose 有两个容易踩的点，都验证过了：

- `network_mode: host`：podman-compose 1.6.0 加 `--in-pod=false` 时能正确落到 `--network host`，
  容器直接监听宿主 8088（rootless 的 rootlessport 在本机起不来，所以当初才用 host 网络）
- `container_name: catstar-next-smokeping`：compose 认这个名字，所以重建后名字不变，
  别的东西按名字找它也还找得到

#### 容器 / 镜像 / 卷 / 网络

- **节点条**：每个运行时一枚 chip，绿的可用、灰的不可用（hover 看原因），点一下切到那个节点
- **容器列表**：名字 / 状态 / 镜像，行内启停；点击看详情
- **概览**：状态、镜像、端口、挂载、网络（含 IP/MAC）、环境变量**键名**
- **新建容器**：Podman 填镜像/端口/环境变量/挂载/命令/重启策略/内存/CPU；
  LXC 填发行版/版本/架构/网桥/IP 模式/内存上限，可选创建后启动与开机自启
- **资源限制**（Podman）：概览里的内存 / CPU 输入框，走 `podman update`，保存后会读回来核对是否真的生效
- **以此配置新建**：把现有容器的镜像、端口、挂载、命令、网络、重启策略预填进创建表单（环境变量只回填键名）
- **配置**（LXC）：直接编辑 `lxc.net.N.*`；另有「启动项」区块改开机自启与内存上限。两者都写前备份 `config.cm-bak-<时间戳>`
- **快照 / 挂载 / 克隆**（LXC，只在 LXC 容器上出现）：建快照、回滚、删；`lxc.mount.entry` 一行一条编辑；整份克隆
- **终端**（Podman 与 LXC 都有）：WebSocket 接进来，Podman 走 `podman exec -it`，LXC 走 `lxc-attach`
- **镜像**：列表、拉取、删除（删除挂起）
- **查更新**：比本地镜像的 digest 和仓库里 tag 现在指向的 digest，三态 ——
  「当前」/「有新版」/「比不了」。**「比不了」不等于「已是最新」**：自建镜像本来没有 digest，
  没装 skopeo 时 podman 4.3 也给不出可比的远端摘要（`podman manifest inspect` 给的是各平台条目，
  拿它比会把所有镜像误判成有新版 —— 这个坑是真踩过的）。没装会直说，并给 `apt install skopeo` 那条命令
- **密钥**（Podman secret）：只列名字 / 驱动 / 时间，**值永远读不回来**（podman 本身不给回读）。
  新建只从面板走：AI 侧 `container_secret` 新建一律被拒，密钥不该经过模型
- **Quadlet**：列 systemd 目录里的 unit，看展开后的 `podman run` 参数、启停单元。
  4.3.1 没有 Quadlet 生成器时会如实报不支持并给出版本，不假装能用
- **卷**：列表、删除（删除挂起，会先看有没有容器在用）
- **网络**：列出网络与成员；建 bridge 网络；把容器接入/移出
- **删除**：先点一次内联确认条，再挂进待确认 —— 两次都是人手，AI 碰不到
- **待确认抽屉**：AI 发起的危险操作挂在这里，点「确认」才真的执行，点「取消」就丢掉
- **影响预览**：危险操作挂起之前先算一遍「会动到谁」—— 被依赖的容器、被占的端口、要删的归档。
  拿不准的写「没能确认」，不编
- **健康**：有 healthcheck 的容器显示状态与连续失败次数（没有就是 `null`，不假装健康）
- **任务抽屉**：克隆 / 快照 / 导出 / 导入 / 提交这些长任务在页面底部排队，能看到运行到哪一步、可以取消
- **宿主历史**：宿主负载与内存的历史曲线（1h / 6h / 24h），数据是 30 秒一个点、留 3 天的 NDJSON；
  面板自己那 20 个点的环只有 3 分钟，那是心跳不是历史

### LXC 页

子 tab：容器 / 镜像 / 网络 / 存储 / 备份。LXC 没有 compose 那一套，也没有卷和 OCI 镜像的概念，
所以这一页比 Podman 页少几格、多「存储」和「备份」。

#### 容器

容器列表与详情跟 Podman 页同构，但详情里的东西是 LXC 的：

- **概览 / 日志 / 文件 / 诊断 / 配置 / 终端**，快照与挂载在配置页里
- **文件**：列目录、读（文本直接显示，二进制给大小）、写（≤8MB）、建目录、删。
  loop 后端的容器走 `lxc-attach`，dir 后端直接读宿主上的 rootfs —— 两条路都在 helper 里做了真实路径校验，
  不许穿出容器根。AI 侧的写 / 删一律挂起（单次 ≤256KB），面板自己点就行
- **诊断**：容器里跑 7 步网络排查（网卡 / 路由 / resolv.conf / hosts / 解析 / ping / TCP 连端口）。
  结果按「正常 / 有问题 / 没探出来」分档，每档都说依据；BusyBox 的 `ip` 没有 `-brief`，所以用 `ip addr` 解析 `<FLAGS>`，
  连 `nc` 也不支持 `-z`（这套判断是被真机打过脸的）
- **配置**：15 个字段全在面板上 —— 主机名、开机自启、启动顺序与延迟、init 命令、capabilities 丢弃、
  绑核、CPU 配额、CPU 权重、内存上限、内存软限、swap、OOM 分组、PID 上限、IO 权重。
  资源类的立刻生效（同时写 config 与 cgroup），`capDrop` / `initCmd` / `startOrder` / `startDelay`
  只写 config，返回值里 `restartRequired` 会点名，面板也会说出来
- **快照 / 挂载 / 克隆**：建快照、回滚、删；`lxc.mount.entry` 一行一条；整份克隆（源必须先停）
- **终端**：走 `lxc-attach`

#### 镜像（系统镜像缓存）

**这一格跟 Podman 的「镜像」不是一回事**，别混。LXC 建容器是从共用的 rootfs 压缩包里解出来的，
所以这里的「镜像」是**系统镜像缓存**：

- **放哪**：`/opt/dsh-container/lxc/image/download/<发行版>/<版本>/<架构>/<变体>/rootfs.tar.xz`。
  根目录可以用 `LXCD_IMAGE_ROOT` 环境变量换掉，不写死
- **怎么来的**：建容器时插件把 `LXC_CACHE_PATH` 传给 `lxc-download` 模板，模板自己往这个根下面写，
  不碰 `/var/cache/lxc`。装 helper 时会把老的 `/var/cache/lxc/download/*` 合并搬过来，再删空目录
- **什么时候下载**：第一次建某个发行版才下。同一个发行版再建就是秒级 —— 直接解包缓存
- **过期**：模板给每份缓存写了 `expiry` 文件，到期后建容器会重新下载。面板上标「已过期」
- **删除**：走待确认。删了下次建这个发行版要重新下一遍

面板这一格显示缓存根目录、总占用、每份的发行版/版本/架构/大小/下载时间/过期状态。

#### 网络

只看 LXC 的网络（`lxcbr0` 这类网桥与容器接入关系）。宿主那套网卡/路由/DNS/防火墙不在这一页，
在顶部的「宿主网络」。

#### 存储

三块：

- **镜像缓存**：几份、一共多少
- **容器磁盘**：每个容器的 loop 虚拟盘（`<名字>-0.img`）实际占多少
- **分区余量**：缓存和虚盘所在分区的总量 / 已用 / 剩余 / 百分比

LXC 用 `-B loop` 后备存储，每个容器一个稀疏 `.img` 文件，面板按实际占用的块算大小，不是按「申请了多少」。

#### 备份

- **导出 / 导入**：`lxc export` 整份打包（默认只导实例、不带快照），导入后容器是停止状态。
  两者都进任务队列，不在 HTTP 请求里干等
- **自动备份**：开关 + 勾选要备的容器 + 每几小时一次 + 留几份 / 留几天。
  到点自动导出，然后按保留策略删旧归档（导出走任务队列，一次只跑一个，不并发拷 rootfs）
- **只做 LXC**：Podman 那边备份的正解是 compose 文件 + 具名卷 + 镜像 digest，
  把 rootfs 打包下来既重又难恢复 —— 不假装能做，面板上也直说
- **状态如实**：目标里混进非 LXC 容器会点名跳过；导出失败会记事件继续走，不整轮崩掉；
  还没配出口时提示「告警只会留在面板里」

### 宿主网络

子 tab：网卡 / 路由 / DNS / 防火墙 / 诊断。全是宿主自己的网络配置，
**跟容器网络彻底分开** —— 容器网络在 Podman 页和 LXC 页各自的「网络」格里。

- **网卡**：物理口与连接列表、收发流量，能改 NetworkManager 连接的 DNS / 静态 IP / 启停
- **路由**：路由表、邻居表
- **DNS**：系统 DNS 与 per-link 的配置
- **防火墙**：nftables 表链骨架（这台机是纯 nftables，没有 ufw/firewalld）
- **诊断**：ping 指定目标

改宿主网络会挂起，并提示会断一下网。

### 活动

审计流：谁在什么时候对哪个节点做了什么，成功的写结果，失败的写错误。

「说明」那一列是**可解释执行**：AI 每次工具调用都留一句人话 + 撤回性 ——
「重启 demo · 可撤回」、「删镜像 foo:1 · 不可撤回」、「改宿主网络 dns eth0 · 要你在面板确认」。
同一个工具换个动作，撤回性跟着变（`container_action restart` 可撤回，`delete` 不可撤回）。
说明只写参数里能确定的东西：没给名字就写「未指定」，不替模型补意图。

### 体检

独立一页，两块：

- **能力**：10 条检查（podman 版本 / subuid / uidmap / 存储驱动 / netns / cgroup / linger / pasta / skopeo / LXC 后端），
  每条给「可用 / 受限 / 缺失 / 没探出来」+ 原因 + 可复制的修复命令。**探不出来就写 unknown**，不猜
- **AI 权限**：三档角色（readonly / operator / admin）与 deny 黑名单，改了立刻生效。
  只有面板能改 —— AI 不能给自己提权
- **告警**：规则开关（不健康 / 反复重启 / 盘占用 / 危险操作等人确认太久）、出口（json / ntfy / bark）、
  「发一条测试」。同一件事在去重窗口内只发一次；出口 URL 只显示掩码，token 不打到面板上

## 新建容器的字段

| 字段 | Podman | LXC | 说明 |
| --- | --- | --- | --- |
| 镜像 / 发行版 | `image` 必填 | `distro` + `release` + `arch` | LXC 从 images.linuxcontainers.org 拉 rootfs |
| 名字 | 可选（留空随机） | **必填** | 只允许字母数字与 `_ . -` |
| 网络 | 选已有网络，默认 `podman` | `lxcbr0` / 已有网桥 / 「不接网络」 | 下拉里同时列宿主上已有的桥，`lxcbr0` 排第一 |
| IPv4 | — | `DHCP` 或 `静态` | 静态时填地址（必须带前缀，如 `10.0.3.200/24`）与网关（可留空） |
| IPv6 | — | `关闭` / `DHCPv6` / `静态` | 默认关闭。静态时填 `2408:8207::5/64` + 网关（可留空）；`DHCPv6` 不写死配置，靠宿主 RA 或 DHCPv6 服务 |
| MAC 地址 | — | 自动生成，可改 | 进表单就预填一个 `00:16:3e:…`，点「随机换一个」重新抽。**写死进 `lxc.net.0.hwaddr`**，容器里 `ip link` 看到的永远是这一个；不填则内核每次启动随机，DHCP 保留与按 MAC 的防火墙规则都会失效 |
| 端口 | `8080:80`、`8443:443/udp` 一行一条 | — | rootless 绑不了 1024 以下 |
| 环境变量 | `KEY=VALUE` 一行一条 | — | 详情里只回键名，不回值 |
| 挂载 | `/宿主:/容器[:ro]` 一行一条 | — | 拒绝 `..`，目标必须绝对路径 |
| 资源 | 内存 / CPU / 重启策略 | 内存上限 | 见下面「rootless 的假成功」 |

**创建不挂起，改配置挂起**：创建不删数据、参数在面板上看得见，所以直接执行；删除、改网卡、改启动项
动的是不可撤销的东西（或 root 的配置文件），一律先进待确认。

### 网卡 MAC：一律写死

本插件创建的 LXC 容器**都会带一个固定 MAC**：不填就自动生成，写进 `lxc.net.0.hwaddr`。
前缀 `00:16:3e` 是 LXC / Xen 传统分给虚拟网卡的 OUI，不会和真实厂商网卡撞号。

为什么必须固定：不写 `hwaddr` 时 MAC 由内核随机生成，**容器每重启一次就可能变** ——
DHCP 保留地址、按 MAC 写的防火墙规则、以及需要识别同一块网卡的上层逻辑都会失效。

写入前会查一遍冲突：扫宿主网卡和其它容器的 config。撞了怎么处理，看这个 MAC 是谁定的：

| 来源 | 撞车时 |
| --- | --- |
| 插件自动生成 / 点了「随机」 | 自动换一个重试（最多 8 次），结果里会写 `00:16:3e:… 归 容器 X，换成 00:16:3e:…` |
| 自己填的 | 拦住报错，不会偷偷换掉 —— 有人就是要某个 MAC 去对 DHCP 保留 |

两个表单的 MAC 输入框下面会写清楚当前是哪种：随机出来的说「撞了会自动换一个」，手填的说「不会偷偷换掉」。

### 网桥与桥接：NAT 归插件管，桥接自己建

`lxcbr0`（`10.0.3.0/24`）是插件管的 NAT —— 能替你建、替你修，容器拿内网地址，出网由宿主转发。

想跟宿主同网段，得**你自己先在宿主上建桥**：「宿主网络 → 网卡 → ＋ 新建连接」里建一块
`bridge` 类型的连接。插件不会替你在宿主上建桥，也不会把物理网卡插进去 —— 那会断你自己的网。
桥建好之后，新建容器时的网桥下拉里就会出现它，选中即表示容器直接进那个网段（要 DHCP 才拿得到地址）。

---

## 35 个 AI 工具

| 工具 | 性质 | 说明 |
| --- | --- | --- |
| `container_nodes` | 只读 | 有哪些节点、谁可用、为什么不可用 |
| `container_list` | 只读 | 容器与网络一览，可按节点/运行时/状态过滤 |
| `container_inspect` | 只读 | 详情（环境变量只给键名，不给值） |
| `container_logs` | 只读 | 尾部日志，上限 2000 行 / 1MB |
| `container_stats` | 只读 | 实时 CPU / 内存 / PIDs + 宿主负载 |
| `container_action` | 危险看动作 | start/stop/restart/pause/unpause 直行；**delete 挂起** |
| `container_create` | 写 | Podman `podman run -d`（打 `dsh-cm=1` 标签）或 LXC `lxc-create -t download` + 启动 |
| `container_limits` | 写 | Podman 内存/CPU，走 `podman update`，**直接执行**；假成功会报错 |
| `container_rename` | 写 | Podman 改名（LXC 不支持） |
| `container_commit` | 危险 | 容器存成镜像，**挂起**（整层复制、占磁盘） |
| `container_config` | 危险 | LXC 开机自启 / 内存上限，**挂起** |
| `container_resources` | 写 | LXC 全套资源：绑核 / 配额 / 权重 / 内存 / swap / PIDs / IO / 主机名 / 启动项 / capabilities，**直接执行** |
| `container_image_list` | 只读 | Podman 是本地镜像库；**LXC 是系统镜像缓存**（`/opt/dsh-container/lxc/image`） |
| `container_image_delete` | 危险 | 删镜像。Podman 删 OCI 镜像、LXC 删系统缓存，都**挂起** |
| `container_image_update` | 只读 | 比 digest 查有没有新版：**current / stale / unknown 三态**，unknown 不当「已是最新」 |
| `network_manage` | 危险 | list/inspect 直读；create/remove/connect/disconnect **挂起** |
| `network_host` | 只读 | 宿主网卡 / 路由 / DNS / NM 连接 / nftables / ping 诊断 |
| `network_host_apply` | 危险 | 改宿主 DNS / 静态 IP / 启停连接，**挂起**（会断网一下） |
| `compose_projects` | 只读 | 项目列表：服务、容器状态、端口、游离容器 |
| `compose_inspect` | 只读 | 单项目详情 + compose 文件原文 |
| `compose_action` | 混合 | up / restart / logs 直行；**down / adopt 挂起**；install-runtime 装 venv；**recreate-service 只重建一个服务** |
| `compose_set_ports` | 写 | **改端口写回 YAML**（保留注释、自动备份），改完要 `up` 才生效 |
| `lxc_snapshot` | 危险 | list 直读；create / restore / delete **挂起** |
| `lxc_clone` | 写 | 整份克隆（源容器必须先停），直接执行 |
| `lxc_mounts` | 危险 | list 直读；**set 改宿主 config，挂起** |
| `pending_operations` | 只读 | 查待确认队列，**没有确认能力** |
| `container_files` | 混合 | list / read 直读；**write / mkdir / remove 挂起**（AI 写容器里的文件一律要人点头，单次写入上限 256KB） |
| `container_jobs` | 混合 | 长任务队列：list / get 直读，cancel 直接发信号 |
| `container_secret` | 混合 | Podman secret 只看名字；**新建一律拒绝**（明文不经过模型），删除挂起 |
| `container_diagnose` | 只读 | 容器里跑 7 步网络诊断（网卡 / 路由 / DNS / 解析 / ping / TCP） |
| `container_quadlet` | 混合 | Quadlet 单元：list / show 直读，reload / start / stop 直行；4.3.1 会如实报不支持 |
| `container_capabilities` | 只读 | rootless 体检：subuid / uidmap / 存储驱动 / cgroup / linger / pasta / skopeo / LXC 后端，每条带原因与修复命令 |
| `lxc_backup` | 混合 | list / policy 直读；export / import / run 返回 jobId；delete 挂起 |
| `container_alert` | 混合 | 告警看与试：list 直读，test 直接发 |
| `container_audit` | 只读 | 活动 / 审计记录，AI 每次调用的「人话说明」也在里面 |

容器启动/停止/重启不挂起——它们可逆、且是日常操作。创建也不挂起（不删数据、参数可见）。
删除、网络拓扑改动、LXC 网卡与启动项改动会挂起。

### AI 能发起什么：三道闸

1. **角色**（配置 `authz.aiRole`，面板「体检 → AI 权限」可改）：`readonly` 只读 /
   `operator` 读写但发起不了危险操作（默认）/ `admin` 全放开。
2. **黑名单**（`authz.deny`）：单独点掉几个工具，admin 也挡。
3. **人确认**：角色只决定 AI 能不能**发起**，危险操作永远要你在待确认里点一下。

被挡下的调用返回 `FORBIDDEN` 规范值（带「改哪个配置」的提示），不抛异常、不静默降级。
性质没登记的工具一律按 `danger` 算 —— 漏登记只会更严，不会更松。

### 可解释执行

AI 每调一次工具，审计里就多一条人话：「重启 demo · 可撤回」、
「删镜像 foo:1 · 不可撤回」、「改宿主网络 dns eth0 · 要你在面板确认」。
面板「活动」页多一列说明，模型自己也能用 `container_audit` 回看。
说明只写参数里能确定的东西 —— 没给名字就写「未指定」，不替模型补意图。

### 危险操作的真实流程

```
AI 发起 → 服务端写 pending（10 分钟 TTL）→ 工具返回 {status:"pending", token, message}
        → 你对 AI 说「去面板点一下」→ 人在面板点确认 → 服务端校验 x-cm-principal: panel
        → 执行 → 结果写审计，pending 变 done/failed
```

AI 没有任何确认通道：`/actions/confirm` 要求请求头 `x-cm-principal: panel`，
而工具层拿不到这个通道，也不提供「自己确认」的方法。token 一次性，重复确认 400，过期 409。

---

## 配置与数据

默认数据目录 `~/.dsh-next/container-manager/`（可用 `DSH_CM_DIR` 覆盖）：
```
config.json    节点列表与开关（0600）
pending.json   待确认队列（含每个危险操作的影响清单）
audit.jsonl    审计，按行保留 2000 条
jobs.json      长任务队列（重启后未完成的标成「已中断」，不假装还在跑）
metrics.ndjson 宿主负载历史（默认 30 秒一采，留 3 天，超过 8MB 只留后一半）
```

任务队列与指标都是**只追加**的：队列状态变更先改内存再落盘（1.5 秒去抖），
指标每天切一次文件、按天剪枝 —— 都不做「读全量再重写」，因为这两个文件会一直长。

LXC 的系统镜像缓存在别处，跟数据目录分开（2026-11-21 迁到新根）：

```
/opt/dsh-container/lxc/image/download/   系统镜像缓存（LXCD_IMAGE_ROOT 可换）
/opt/dsh-container/lxc/<名字>/<名字>-0.img   每个容器的 loop 虚拟盘
/var/lib/lxc/<名字>/config                LXC 自己的配置与 rootfs 指向
```

可配置项（`config.json` 顶层）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `confirmRequired` | `true` | 关掉后危险操作直接执行（不建议，等于把确认通道交给 AI） |
| `confirmTtlSeconds` | `600` | 待确认存活时间，钳在 30–3600 |
| `allowLogs` | `true` | 关掉后 `container_logs` 报错 |
| `allowExec` | `false` | 预留：容器内执行命令（终端走独立 WebSocket，不归它管） |
| `auditKeepLines` | `2000` | 审计保留行数 |
| `compose.root` | `''` | 容器根目录，留空 = 没配，面板会引导填 |
| `compose.binary` | `''` | podman-compose 路径，留空 = 用数据目录下 venv 的默认路径 |
| `compose.version` | `1.6.0` | pin 的 podman-compose 版本 |
| `compose.installedAt` | `''` | 上次装运行时的时间 |
| `jobsMaxRunning` | `2` | 长任务并发上限，1–4；再多会把 podman / lxc 自己拖慢 |
| `metrics.enabled` | `true` | 关掉就不采宿主历史 |
| `metrics.intervalSeconds` | `30` | 采样间隔，钳在 10–600 |
| `metrics.keepDays` | `3` | 历史保留天数 |
| `metrics.maxBytes` | `8388608` | 单个 NDJSON 上限，超了只留后一半 |
| `authz.aiRole` | `'operator'` | AI 角色：`readonly` / `operator` / `admin` |
| `authz.deny` | `[]` | 工具名黑名单，admin 也挡 |
| `backupPolicy.enabled` | `false` | 自动备份开关（只做 LXC） |
| `backupPolicy.targets` | `[]` | 要备份的 LXC 容器名 |
| `backupPolicy.everyHours` | `24` | 多久导一次，1–720 |
| `backupPolicy.keepCount` | `5` | 每个容器留几份 |
| `backupPolicy.keepDays` | `14` | 超过几天的一律删 |
| `alerts.webhooks` | `[]` | 出口：`{id, name, url, kind: json/ntfy/bark, enabled}` |
| `alerts.rules` | `[]` | 规则：`{id, kind: unhealthy/restarts/disk/pending, threshold, enabled}` |
| `alerts.dedupeMinutes` | `30` | 同一件事多久内只发一次 |

节点可以加远程 Podman（`transport: "ssh"`，需要免密 + `podman` 在远端 PATH 里）。
面板里没有「加节点」界面，直接改 `config.json` 或 `POST /nodes`。

---

## 已知限制（如实写）

- **rootless Podman**：1024 以下宿主端口绑不上；静态 IP 常常不支持；`podman unshare` 之外碰不到宿主的 root 网络。
- **本机 UTS（已解决，代码里仍留兜底）**：之前 rootless 容器报 `crun: sethostname: Operation not permitted`，
  根因是宿主 systemd drop-in 里的 `ProtectHostname=yes` 用 seccomp 挡了 `sethostname`
  （在 userns 里 uid=0 也照样 EPERM，而同环境 `mount -t tmpfs` 正常 —— 所以不是权限不足）。
  2026-11-20 关掉那一项后实测恢复：默认 `podman run ... hostname` 返回容器短 ID，
  `--uts=private --hostname x` 返回 `x`。插件仍保留「撞到 sethostname 就清半成品并退 `--uts=host`」的兜底，
  但正常情况下不会触发。
- **macvlan / ipvlan**：驱动一般已在内核里 —— 实测在 userns+netns 里 `ip link add ... type macvlan mode bridge`
  直接建成功，**不需要先 modprobe**。真正的前提是**有 CAP_NET_ADMIN**：rootless Podman 建 macvlan 网络通常
  要宿主上有 root 通道。反过来说，`modprobe macvlan` 报 `Module not found` 是个**误报** ——
  本机 `/lib/modules` 权限是 `d---------` 且 `/usr/lib/modules` 被一个空 tmpfs 遮蔽，modprobe 读不到目录而已。
- **AppArmor 没启用**：本机 `/sys/module/apparmor/parameters/enabled` 是 `N`，所以 `apt install lxc` 时报
  `Failed to run 'apparmor_parser -rWT /etc/apparmor.d/lxc-containers'`。容器照常跑（没有 profile 约束），
  但这意味着 LXC 那一层少了 AppArmor 隔离 —— 这是系统现状，不是插件的开关。
- **内核版本**：运行时是 `6.1.0-53-arm64`，但 `6.1.0-56` 已经装好在 `/boot`（`initrd.img` 已指向它）。
  下次重启会换内核，LXC 容器不受影响，但重启前最好知道这件事。
- **LXC 建容器第一次要联网**：某个发行版没缓存过时，`lxc-download` 会去 `images.linuxcontainers.org` 下 rootfs
  （模板自己有 3 次重试）。网络抖动时可能全失败，报的是 `Failed to download ...`，
  重试一次通常就好。下过一次之后就只解包本地缓存，不再联网。
- **LXC 网络**：创建时只认 `lxcbr0`（`/etc/default/lxc-net` 的默认 NAT 网桥），自定义网桥要建好容器后改。
- **不加物理网卡到网桥**：那会把你自己的 SSH 断掉。macvlan 是唯一「不打断宿主」的接法，也只按需启用。
- **`podman inspect` 会骗人，cgroup 不会**。这台机是 cgroup v2 + rootless podman 4.3.1，
  `podman update --memory 512m` 之后 `podman inspect` 里的 `HostConfig.Memory` **仍然是 0**，
  但容器内 `/sys/fs/cgroup/memory.max` 已经真的变成 `536870912`；`--cpus 0.5` 对应 `cpu.max = 50000 100000`。
  所以插件判断「有没有生效」读的是 cgroup，不是 inspect —— 拿 inspect 当证据会得出「假成功」的错误结论。
  创建时带 `--memory` 的限制同理：它真的进 cgroup，只是 inspect 那一栏不更新。
- **`podman update` 4.3.1 的能力边界**：支持 `--memory / --memory-reservation / --memory-swap /
  --cpus / --cpu-shares / --cpuset-cpus / --blkio-weight / --cpu-period / --cpu-quota`；
  **不支持 `--pids-limit`（报 `unknown flag`），也不支持 `--restart`**。
  所以 PID 上限只能在建容器时设，重启策略 / 端口 / 挂载 / 环境变量 / 命令改了必须重建容器。
- **重建走「先建新的、换名、再删旧的」**：`POST /containers/:node/:ref/recreate` 会起一个临时名字的新容器，
  起来之后把旧容器 `rename` 让位、新容器改回原名、最后删掉旧容器；任一步失败都会把名字回滚，
  不会出现「先删后建」把容器弄没的情况。它仍然是危险操作 —— 走待确认，确认按钮只在人手里。
- **podman-compose 1.6.0 的 healthcheck 会写坏**：它生成的 `--health-cmd` 是 `["wget", ...]`（JSON 数组当**一个**参数），
  容器里跑起来必然 unhealthy。面板把这条偏差显示出来，但不去 fork 上游。要健康检查就手写 `test: ["CMD", ...]` 之外的写法，
  或者等上游修。
- **podman-compose 默认会建 pod**：这里所有调用都带 `--in-pod=false`，因为 pod 会让端口与网络多一层，
  和面板「一个容器一个名」的模型对不上。
- **只重建改过的服务**，不是整项目 down/up。代价是 compose 里改 network / volume 这类跨服务的东西时，
  只有被点名的服务会换，其余保持原样 —— 这是故意的。
- **compose 只认一个子集**：`image / build / ports / environment / volumes / command / restart / depends_on /
  healthcheck / labels / working_dir / user / hostname / cap_* / devices / privileged / entrypoint / tty / stdin_open`。
  碰到别的一律显式报 `unsupported`，不假装支持，也不静默丢掉。
- **ext4 上的 LXC 快照是整份复制**：不共享数据块，占空间也慢；克隆同理。btrfs / zfs 才能做写时复制，这台没有。
- **终端窗口不可动态缩放**：`script -qfec` 包装出来的 pty 尺寸固定，`podman exec -it` 才认它是 tty（否则 `not a tty`）。
  所以拖窗口不会改变容器里的列数。xterm.js 的 fit 插件只在本端量尺寸，改不了远端 pty。
- **adopt 会删旧容器**：把手工起的容器换成 compose 管，必须先删掉同名的旧容器再按 YAML 重建。
  容器里的临时数据会丢；卷挂载在宿主上的东西不受影响。所以它走待确认。

---

## 自检

```bash
node scripts/selfcheck.mjs      # 假 ctx 跑一遍 apply()：17 工具 / 1 提示词 / 1 前缀
node scripts/livecheck.mjs      # 起临时端口打真 podman + 真 helper，只发 GET
node scripts/writetest.mjs      # Podman：临时容器走完整生命周期（含待确认删除），结束自动清理
node scripts/lxc-smoke.mjs      # LXC：启动/详情/日志/改网卡/改启动项/停止/删除，容器名必须 cm-smoke 开头
node scripts/lxc-smoke.mjs --with-create   # 同上，但容器由脚本自己走 API 创建（要联网拉 rootfs）
DSH_HOME=/tmp/cm-smoke node scripts/smoke-compose.mjs    # compose 全链路：建项目 → up → 端口 → 改端口重建 → 日志 → down
DSH_HOME=/tmp/cm-smoke node scripts/smoke-terminal.mjs   # 静态资源 + WS 终端：建容器 → 连上 → 里面 echo → 删掉
node scripts/smoke-lxc-extras.mjs                        # LXC 快照 / 克隆 / 挂载点，直接打 helper socket，需要 root
```

单元测试在本地 `test/` 下：`npm test`（= `node --test test/*.test.mjs`，380 条）。
这个目录**不在公开仓库里**（`.git/info/exclude` 排掉了）—— 它带着本机路径和真实容器名，
所以 `npm test` 只在开发机上跑得通，克隆下来是没有的。

`livecheck` / `writetest` / `lxc-smoke` 都用临时数据目录，不碰 `~/.dsh-next/container-manager/`。
`lxc-smoke` 需要先手工建一个测试容器：

```bash
sudo lxc-create -n cm-smoke-lxc -t download -- -d alpine -r 3.22 -a arm64
node scripts/lxc-smoke.mjs
```

---

## 排障

| 现象 | 看哪里 |
| --- | --- |
| 左侧没有「容器」 | 包在 `dsh.profile.bundles` 里吗？重启过 DSH 吗？`journalctl -u dsh-next` 搜 `[container-manager]` |
| 面板一片「读取中…」 | 直接 `curl localhost:3085/api/container-manager/health`，401 说明登录态/Connection 校验没过 |
| LXC 显示 HELPER_DOWN | `systemctl status dsh-lxcd`、`ls -l /run/dsh-container-manager/`、`curl --unix-socket ... http://localhost/health` |
| 创建容器报 sethostname | 已自动退到 `--uts=host`；要显式指定就传 `uts:"host"` |
| 危险操作点了没反应 | 看审计 `audit.jsonl` 与 `pending.json`；过期会 409，重新发起 |
| LXC 有容器但列表是空的 | 曾经是 helper 漏 import `NAME_RE` 被 catch 吞掉导致的「静默空列表」；现在读目录失败会直接报 `LXC_ERROR`。若还空，看 `journalctl -u dsh-lxcd` |
| 所有 LXC 接口都超时 | 多半是有人手工在前台跑过 `dsh-lxcd.mjs`，把服务的 socket 文件换掉了：`sudo systemctl restart dsh-lxcd` |

插件自己的日志前缀是 `[container-manager]`，写 stdout，进 systemd journal。

---

## 目录

```
lib/
  index.js       host 入口：注册工具 / 提示词 / REST / WebSocket 升级
  api.js         REST 路由与认证
  actions.js     动作编排：哪些直接执行、哪些挂起
  pending.js     待确认状态机（TTL、一次性 token、参数摘要）
  nodes.js       节点注册表，把多节点结果摊平
  config.js      配置读写（原子写、0600）
  audit.js       审计 JSONL
  tools.js       35 个 AI 工具
  static.js      /static/* 只服务 vendor/ 下的白名单
  ws.js          手搓的 RFC 6455 服务端（不引 ws 依赖）
  terminal.js    容器终端：升级 → pty → 双向管道
  compose/
    discover.js  扫一级子目录找 compose 文件
    parse.js     YAML → 中间结构，坏行报「第 N 行第 M 列」
    model.js     端口 / 卷 / 环境变量归一化
    render.js    服务 → podman run 参数（给 adopt 用）
    ports.js     ss 监听表 + 端口冲突预检
    status.js    项目状态：服务 ↔ 容器、缺失、陈旧
    runner.js    调 podman-compose（永远 --in-pod=false）
    runtime.js   venv 检测 / 安装 / 版本 pin
    yaml-write.js  改端口写回，保留注释，自动 .bak
    layout.js    根目录 + podman/ + lxc/ 的建立与检查
    service.js   编排层：对上层只暴露「项目」这个概念的动词
  drivers/
    podman.js    本机 / ssh Podman
    lxc.js       经 root helper 的 unix socket
client.js        浏览器半（左侧主面板，React.createElement，无 JSX）
vendor/          xterm.js / addon-fit / yaml（运行时不联网）
helper/
  dsh-lxcd.mjs       root 服务：白名单动作、只有 JSON over HTTP
  net-config.mjs     lxc.net.* 解析/生成
  dsh-lxcd.service
  install-helper.sh
scripts/         selfcheck / livecheck / writetest / lxc-smoke / smoke-compose / smoke-terminal
docs/design.md   分层、状态机、安全边界、决策记录
```

## 第三方代码

`vendor/` 下是打包进来的库，运行时不联网取：

| 路径 | 项目 | 许可 |
| --- | --- | --- |
| `vendor/xterm/` | [xterm.js](https://github.com/xtermjs/xterm.js)（含 addon-fit） | MIT |
| `vendor/yaml/` | [eemeli/yaml](https://github.com/eemeli/yaml) | ISC |

本仓库其余部分按 [MIT](LICENSE) 发布。
