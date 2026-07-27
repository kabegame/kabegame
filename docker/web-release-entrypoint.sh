#!/usr/bin/env bash
# web-release 运行时入口：把镜像内预制产物（seed，FFmpeg/x264 -web 静态库）同步进
# bind-mount 的源码树 /src，然后 exec 传入的命令（compose 的 command，仅 Rust 构建）。
#
# 为什么要种回 /src 而不是留在镜像路径：mode-plugin 会把 FFMPEG_PKG_CONFIG_PATH
# 无条件指向 <repo>/third/FFmpeg-build-web/install/lib/pkgconfig（repo=/src），
# .pc 的 prefix 也在 ffmpeg-builder 阶段烧成 /src/...。
# rsync --delete 以镜像种子为唯一事实源：首个 run 全量落盘（宿主 gitignored 目录），
# 之后增量近似 no-op；镜像重建后自动收敛到新种子。
#
# node_modules-web 种子已随自编 deno / 0004 后缀补丁一并移除：容器不再跑任何 JS
# 产物构建，官方 deno 只执行构建编排，直接读挂载树里宿主的 node_modules（纯 JS 依赖）。
set -euo pipefail

SEED=/opt/kabegame/seed

if [[ -d /src && -d "$SEED/third" ]]; then
  # FFmpeg / x264 静态库（只同步 install 前缀，不碰同级其它内容）
  for d in FFmpeg-build-web x264-build-web; do
    mkdir -p "/src/third/$d/install"
    rsync -a --delete "$SEED/third/$d/install/" "/src/third/$d/install/"
  done
fi

exec "$@"
