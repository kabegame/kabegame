#!/usr/bin/env bash
# 一键编译 FFmpeg：仅生成「视频缩放 + mov/mp4 压缩」所需组件（最小化编译）。
# 功能：读 mov/mp4/mkv 等 → scale 缩放 → libx264 编码 → 输出 mp4。
# 输出到 src-tauri/app-main/sidecar/，供 Tauri externalBin（sidecar）使用。
# 文件名须符合 Tauri 约定：ffmpeg-{target_triple}[.exe]（如 ffmpeg-x86_64-apple-darwin）。
# 在目标系统上直接执行即可（Windows/Linux/macOS 各在真实环境编译）。
#
# 依赖: libx264（macOS: brew install x264，Ubuntu: libx264-dev，Windows: 自行安装）
set -e

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FFMPEG_SRC="${REPO_ROOT}/third/FFmpeg"
SIDECAR_DIR="${REPO_ROOT}/src-tauri/app-main/sidecar"
BUILD_DIR="${REPO_ROOT}/third/FFmpeg-build"

# Tauri externalBin 约定：二进制名为 binary-{target_triple}[.exe]
TARGET_TRIPLE="${CARGO_BUILD_TARGET:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "无法获取 target triple（请安装 Rust 或设置 CARGO_BUILD_TARGET）" >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin)   EXE_SUF="" ;;
  Linux)    EXE_SUF="" ;;
  MINGW*|MSYS*|CYGWIN*) EXE_SUF=".exe" ;;
  *)        echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
SIDECAR_NAME="ffmpeg-${TARGET_TRIPLE}${EXE_SUF}"

if [[ ! -d "$FFMPEG_SRC" ]]; then
  echo "FFmpeg 源码目录不存在: $FFMPEG_SRC（请先执行 git submodule update --init third/FFmpeg）" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"

# 最小化编译：仅启用 mov→mp4 压缩链路（scale + libx264 + mov）
"$FFMPEG_SRC/configure" \
  --prefix="$BUILD_DIR/install" \
  --disable-everything \
  --enable-gpl \
  --enable-libx264 \
  --enable-protocol=file \
  --enable-demuxer=mov \
  --enable-demuxer=matroska \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-decoder=mpeg4 \
  --enable-decoder=vp8 \
  --enable-decoder=vp9 \
  --enable-parser=h264 \
  --enable-parser=hevc \
  --enable-parser=mpeg4video \
  --enable-parser=vp8 \
  --enable-parser=vp9 \
  --enable-encoder=libx264 \
  --enable-muxer=mov \
  --enable-filter=scale \
  --enable-swscale \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-doc \
  --disable-avdevice \
  --enable-small \
  --disable-runtime-cpudetect \
  --extra-cflags="-O2" \
  "$@"

if command -v nproc &>/dev/null; then
  NPROC=$(nproc)
elif command -v sysctl &>/dev/null; then
  NPROC=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
else
  NPROC=4
fi
make -j"${NPROC}"
make install

mkdir -p "$SIDECAR_DIR"
FFMPEG_BIN="${BUILD_DIR}/install/bin/ffmpeg${EXE_SUF}"
if [[ -f "$FFMPEG_BIN" ]]; then
  cp -f "$FFMPEG_BIN" "${SIDECAR_DIR}/${SIDECAR_NAME}"
  echo "已输出: ${SIDECAR_DIR}/${SIDECAR_NAME}"
else
  echo "未找到编译产物: $FFMPEG_BIN" >&2
  exit 1
fi
