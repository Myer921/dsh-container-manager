#!/bin/sh
# 把容器的数据盘（loop 镜像）挂进 rootfs。
# LXC 在 mount 阶段调用本脚本：$1 = 容器名，$LXC_ROOTFS_MOUNT = 已挂好的 rootfs。
# 清单由 dsh-lxcd 写在 /var/lib/lxc/<名字>/.dsh-data-disks，每行「镜像绝对路径 挂载点」。
set -u

NAME="${1:-}"
[ -n "$NAME" ] || exit 0

LIST="/var/lib/lxc/$NAME/.dsh-data-disks"
[ -f "$LIST" ] || exit 0

MNT="${LXC_ROOTFS_MOUNT:-}"
[ -n "$MNT" ] || exit 0

CODE=0
while read -r IMG TARGET; do
  [ -n "$IMG" ] || continue
  [ -f "$IMG" ] || continue
  [ -n "$TARGET" ] || continue
  case "$TARGET" in
    /*|*..*) echo "cm-datadisk: 跳过可疑挂载点 $TARGET" >&2; CODE=1; continue ;;
  esac
  DEST="$MNT/$TARGET"
  mkdir -p "$DEST"
  # 幂等：已经挂着就跳过（重启容器、冻结后解冻都会再进来一次）。
  if grep -q " $DEST " /proc/mounts 2>/dev/null; then continue; fi
  mount -o loop "$IMG" "$DEST" || CODE=1
done < "$LIST"

exit $CODE
