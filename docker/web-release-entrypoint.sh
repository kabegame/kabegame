#!/usr/bin/env bash
# web-release 运行时入口：把镜像内预制产物（seed，FFmpeg/x264 静态库）同步进
# bind-mount 的源码树 /src，然后 exec 传入的命令（compose 的 command，仅 Rust 构建）。
#
# 为什么要种回 /src 而不是留在镜像路径：mode-plugin 会从
# <repo>/bin/linux/x86_64/FFmpeg-build/install/lib/pkgconfig（repo=/src）取依赖，
# .pc 的 prefix 也在 ffmpeg-builder 阶段烧成 /src/...。
# rsync --delete 以镜像种子为唯一事实源：首个 run 全量落盘（宿主 gitignored 目录），
# 之后增量近似 no-op；镜像重建后自动收敛到新种子。
#
# 注意：在 Linux 开发机上跑 web 构建时，容器会把自己那份（glibc 2.28 地板）的
# FFmpeg/x264 种进 bin/linux/x86_64/，覆盖 guest 产的那份，且 .pc 里烧的 /src
# 前缀在宿主无效；跑完后需要在 Ubuntu 22.04 guest 里重新执行
# `deno task build:ffmpeg`。macOS 宿主无此问题（树内本无 Linux 产物）。
#
# 容器不跑任何 JS 产物构建；官方 deno 只执行构建编排，直接读取挂载树里宿主的
# node_modules（纯 JS 依赖），无需额外的依赖目录种子。
set -euo pipefail

SEED=/opt/kabegame/seed

if [[ -d /src && -d "$SEED/bin/linux/x86_64" ]]; then
  # FFmpeg / x264 静态库（只同步 install 前缀，不碰同级其它内容）
  for d in FFmpeg-build x264-build; do
    mkdir -p "/src/bin/linux/x86_64/$d/install"
    rsync -a --delete "$SEED/bin/linux/x86_64/$d/install/" "/src/bin/linux/x86_64/$d/install/"
  done
fi

exec "$@"
