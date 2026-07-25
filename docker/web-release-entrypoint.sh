#!/usr/bin/env bash
# web-release 运行时入口：把镜像内预制产物（seed）同步进 bind-mount 的源码树 /src，
# 然后 exec 传入的命令（compose 的 command 只剩 `deno task b -c kabegame --mode web`）。
#
# 为什么要种回 /src 而不是留在镜像路径：
#   - mode-plugin 会把 FFMPEG_PKG_CONFIG_PATH 无条件指向 <repo>/third/FFmpeg-build-web/
#     install/lib/pkgconfig（repo=/src），.pc 的 prefix 也在 ffmpeg-builder 阶段烧成 /src/...；
#   - node_modules-web（0004 补丁重定向）必须位于 package.json 旁边的源码树内。
# rsync --delete 以镜像种子为唯一事实源：首个 run 全量落盘（宿主 gitignored 目录），
# 之后增量近似 no-op；镜像重建后自动收敛到新种子。
set -euo pipefail

SEED=/opt/kabegame/seed

if [[ -d /src && -f "$SEED/nm-list.txt" ]]; then
  # FFmpeg / x264 静态库（只同步 install 前缀，不碰同级其它内容）
  for d in FFmpeg-build-web x264-build-web; do
    mkdir -p "/src/third/$d/install"
    rsync -a --delete "$SEED/third/$d/install/" "/src/third/$d/install/"
  done

  # node_modules-web 树（清单驱动，含各 workspace 层级）
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    mkdir -p "/src/$rel"
    rsync -a --delete "$SEED/$rel/" "/src/$rel/"
  done < "$SEED/nm-list.txt"

  # 依赖漂移提示：lockfile 变了说明种子已过期，需要重建镜像
  if ! cmp -s "$SEED/deno.lock" /src/deno.lock; then
    echo "[web-release] warn: /src/deno.lock 与镜像构建时不一致——依赖有变更，" >&2
    echo "[web-release]       请先重建镜像: docker compose -f docker/docker-compose.web-release.yml build" >&2
  fi
fi

exec "$@"
