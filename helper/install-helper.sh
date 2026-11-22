#!/usr/bin/env bash
# dsh-container-manager · LXC helper 安装脚本
#
# 用法：
#   sudo bash helper/install-helper.sh              # 装 lxc + helper 并启动
#   sudo bash helper/install-helper.sh --dry-run    # 只打印要做什么
#   sudo bash helper/install-helper.sh --no-lxc     # 只装 helper（lxc 已经装好）
#   sudo bash helper/install-helper.sh --uninstall  # 停服务并删掉 helper（不删 lxc 与容器）
#
# 为什么要 root：DSH 主进程是 CapEff=0 + NoNewPrivs=1，lxc / 网桥 / macvlan 全部要 root。
# 这个脚本装的是那个「有权限的小半边」：一个只做白名单操作的 root 服务。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
INSTALL_LXC=1
UNINSTALL=0
INSTALL_ROOT="/usr/local/lib/dsh-container-manager"
SOCKET_DIR="/run/dsh-container-manager"
LOG_DIR="/var/log/dsh-container-manager"
NODE_BIN="$(command -v node || true)"
# root 的 PATH 里通常没有 nvm，所以 command -v 找不到；按常见位置再找一遍。
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-lxc) INSTALL_LXC=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] 当前不是 root —— 真实执行需要 sudo，下面只打印计划。" >&2
  else
    echo "需要 root：sudo bash $0" >&2
    exit 1
  fi
fi

if [[ "$UNINSTALL" -eq 1 ]]; then
  echo "== 卸载 dsh-lxcd =="
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] systemctl disable --now dsh-lxcd"
    echo "[dry-run] rm -f /etc/systemd/system/dsh-lxcd.service"
    echo "[dry-run] rm -rf $INSTALL_ROOT $SOCKET_DIR $LOG_DIR"
    exit 0
  fi
  systemctl disable --now dsh-lxcd || true
  rm -f /etc/systemd/system/dsh-lxcd.service
  systemctl daemon-reload || true
  rm -rf "$INSTALL_ROOT" "$SOCKET_DIR" "$LOG_DIR"
  echo "已卸载。lxc 本体与 /var/lib/lxc 下的容器没有动。"
  exit 0
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node。helper 需要 node 来跑；先确认 node 在 PATH 里（例如 /usr/local/bin/node）。" >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "== dsh-container-manager LXC helper =="
echo "node    : $NODE_BIN"
echo "package : $HERE"
echo "socket  : $SOCKET_DIR/lxcd.sock"
echo

if [[ "$INSTALL_LXC" -eq 1 ]]; then
  if command -v lxc-ls >/dev/null 2>&1 && command -v lxc-info >/dev/null 2>&1; then
    echo "lxc 已安装：$(lxc-info --version 2>/dev/null | head -1)"
  else
    echo "安装 lxc / lxc-templates ..."
    run apt-get update -qq
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y lxc lxc-templates
  fi
else
  echo "跳过 lxc 安装（--no-lxc）"
fi

echo "安装 helper 到 $INSTALL_ROOT ..."
run install -d -m 0755 "$INSTALL_ROOT"
run install -m 0755 "$HERE/dsh-lxcd.mjs" "$INSTALL_ROOT/dsh-lxcd.mjs"
# 数据盘靠这个 hook 在容器启动时 loop 挂进 rootfs（lxc.mount.entry 不认 fstab 的 loop 选项）。
run install -m 0755 "$HERE/hook-datadisk.sh" "$INSTALL_ROOT/hook-datadisk"
# 容器虚拟磁盘的工作目录（<名字>/<名字>-0.img 就落在这里）。
run install -d -m 0755 /opt/dsh-container/lxc

echo "准备 LXC 系统镜像缓存 ..."
IMAGE_ROOT="${LXCD_IMAGE_ROOT:-/opt/dsh-container/lxc/image}"
run install -d -m 0755 "$IMAGE_ROOT"
run install -d -m 0755 "$IMAGE_ROOT/download"
# 面板只认 $IMAGE_ROOT/download/<distro>/<release>/<arch>/<variant>，
# 而 lxc 默认缓存在 /var/cache/lxc/download —— 把已有的搬过来，免得重新下一遍。
if [[ -d /var/cache/lxc/download ]]; then
  for distro in /var/cache/lxc/download/*/; do
    [[ -d "$distro" ]] || continue
    name="$(basename "$distro")"
    if [[ -d "$IMAGE_ROOT/download/$name" ]]; then
      # 两边都有：合并，不覆盖新位置已有的文件
      echo "  合并已存在的缓存：$name"
      run cp -an "${distro}." "$IMAGE_ROOT/download/$name/"
    else
      echo "  迁移缓存：$name"
      run mv "$distro" "$IMAGE_ROOT/download/$name"
    fi
  done
  run rmdir /var/cache/lxc/download 2>/dev/null || true
  if [[ -d /var/cache/lxc/download ]]; then
    echo "  提示：/var/cache/lxc/download 还有内容没搬走，可能是别的工具在用，保持原样。"
  fi
fi

run install -m 0644 "$HERE/net-config.mjs" "$INSTALL_ROOT/net-config.mjs"
run install -d -m 0700 "$LOG_DIR"

echo "安装 systemd 服务 ..."
TMP_UNIT="$(mktemp)"
# socket 的属组：默认跟调用 sudo 的那个用户走（它的主组），也可以用 LXCD_GROUP 覆盖。
RUN_USER="${SUDO_USER:-${USER:-root}}"
RUN_GROUP="${LXCD_GROUP:-$(id -gn "$RUN_USER" 2>/dev/null || echo root)}"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__GROUP__|$RUN_GROUP|g" "$HERE/dsh-lxcd.service" > "$TMP_UNIT"
run install -m 0644 "$TMP_UNIT" /etc/systemd/system/dsh-lxcd.service
rm -f "$TMP_UNIT"
run systemctl daemon-reload
run systemctl enable dsh-lxcd
# 重装时必须 restart：enable --now 对已在运行的服务不会换上新代码。
run systemctl restart dsh-lxcd

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "[dry-run] 未真正启动。去掉 --dry-run 再跑一次。"
  exit 0
fi

echo
echo "服务状态："
systemctl --no-pager --full status dsh-lxcd | sed -n '1,12p'
echo
echo "health："
if command -v curl >/dev/null 2>&1; then
  # 刚 restart 完 socket 还没就绪，直接 curl 会空手而归 —— 重试几秒，别让用户以为装坏了。
  health_body=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    health_body=$(curl -s --max-time 3 --unix-socket "$SOCKET_DIR/lxcd.sock" http://localhost/health 2>/dev/null || true)
    [ -n "$health_body" ] && break
    sleep 0.6
  done
  if [ -n "$health_body" ]; then
    echo "$health_body"
  else
    echo "（health 暂时读不到，看 journalctl -u dsh-lxcd -n 50）"
  fi
else
  echo "（没有 curl，跳过；用 journalctl -u dsh-lxcd -n 50 看日志）"
fi
echo
echo "完成。回到 DSH 的「容器」面板点刷新，本机 LXC 节点应该变成可用。"
echo "如需让 LXC 用 NAT 网桥（10.0.3.0/24），在面板「网络」页点一次「启用 lxcbr0」。"
