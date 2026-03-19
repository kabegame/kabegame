#!/usr/bin/env bash
# 一键编译 FFmpeg：仅生成「视频缩放 + mov/mp4 压缩」所需组件（最小化编译）。
# 功能：读 mov/mp4/mkv 等 → scale 缩放 → libx264 编码 → 输出 mp4。
# 输出到 src-tauri/app-main/sidecar/，供 Tauri externalBin（sidecar）使用。
# 文件名须符合 Tauri 约定：ffmpeg-kb-{target_triple}[.exe]（如 ffmpeg-kb-x86_64-apple-darwin），避免与系统 /usr/bin/ffmpeg 冲突。
# 在目标系统上直接执行即可（Windows/Linux/macOS 各在真实环境编译）。
#
# 依赖: libx264
#   macOS:   brew install x264
#   Ubuntu:  apt install libx264-dev
#   Windows: 必须在 MSYS2 MinGW 64-bit 中安装：pacman -S mingw-w64-x86_64-x264
#             （Git Bash 无 pacman，无法直接安装 x264，请改用 MSYS2 终端再执行本脚本）
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
SIDECAR_NAME="ffmpeg-kb-${TARGET_TRIPLE}${EXE_SUF}"

if [[ ! -d "$FFMPEG_SRC" ]]; then
  echo "FFmpeg 源码目录不存在: $FFMPEG_SRC（请先执行 git submodule update --init third/FFmpeg）" >&2
  exit 1
fi

# Windows (MINGW/MSYS)：若未安装 x264，configure 会报错；提前检查并提示
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if ! pkg-config --exists x264 2>/dev/null; then
      echo "错误: 未找到 libx264（pkg-config x264 失败）" >&2
      echo "请在 MSYS2 MinGW 64-bit 终端中执行: pacman -S mingw-w64-x86_64-x264" >&2
      echo "然后在该 MSYS2 终端中重新运行本脚本（不要用 Git Bash）。" >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"

# Windows：显式指定 pkg-config 与 .pc 搜索路径，确保 configure 子进程能找到 x264
CONFIGURE_EXTRA=()
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    _pkgconfig_exe=$(which pkg-config 2>/dev/null || true)
    if [[ -n "$_pkgconfig_exe" ]]; then
      CONFIGURE_EXTRA+=(--pkg-config="$_pkgconfig_exe")
    fi
    if [[ -d /mingw64/lib/pkgconfig ]]; then
      export PKG_CONFIG_PATH="/mingw64/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    fi
    ;;
  Linux)
    # Linux：GIF 多帧输出（输入解码与 Windows/macOS 一致，不启用 libx264/mov）
    CONFIGURE_LINUX_ONLY=1
    ;;
esac

# 最小化编译：输入一致（mov/mkv 解码 + scale）；输出 Linux 为 GIF，其它平台 mov+libx264。
if [[ -n "${CONFIGURE_LINUX_ONLY:-}" ]]; then
  "$FFMPEG_SRC/configure" \
    --prefix="$BUILD_DIR/install" \
    --disable-everything \
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
    --enable-encoder=gif \
    --enable-muxer=gif \
    --enable-filter=fps \
    --enable-filter=scale \
    --enable-swscale \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-doc \
    --disable-avdevice \
    --enable-small \
    --disable-runtime-cpudetect \
    --extra-cflags="-O2" \
    "${CONFIGURE_EXTRA[@]}" \
    "$@"
else
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
    "${CONFIGURE_EXTRA[@]}" \
    "$@"
fi

# Windows：make 无法解析 /d/... 绝对路径，将 Makefile 与 config.mak 中的源码路径改为相对路径
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [[ -f Makefile ]]; then
      sed -i '1s|include .*Makefile|include ../FFmpeg/Makefile|' Makefile
    fi
    if [[ -f ffbuild/config.mak ]]; then
      sed -i 's|^SRC_PATH=.*|SRC_PATH=../FFmpeg|' ffbuild/config.mak
    fi
    ;;
esac

if command -v nproc &>/dev/null; then
  NPROC=$(nproc)
elif command -v sysctl &>/dev/null; then
  NPROC=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
else
  NPROC=4
fi
MAKE_CMD="make"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    command -v make &>/dev/null || MAKE_CMD="mingw32-make"
    NPROC=1
    ;;
esac
$MAKE_CMD -j"${NPROC}"
$MAKE_CMD install

mkdir -p "$SIDECAR_DIR"
FFMPEG_BIN="${BUILD_DIR}/install/bin/ffmpeg${EXE_SUF}"
if [[ -f "$FFMPEG_BIN" ]]; then
  cp -f "$FFMPEG_BIN" "${SIDECAR_DIR}/${SIDECAR_NAME}"
  echo "已输出: ${SIDECAR_DIR}/${SIDECAR_NAME}"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      for _dll in /mingw64/bin/libx264*.dll; do
        [[ -f "$_dll" ]] && cp -f "$_dll" "$SIDECAR_DIR" && echo "已复制 x264 DLL: $(basename "$_dll")"
      done
      ;;
  esac
else
  echo "未找到编译产物: $FFMPEG_BIN" >&2
  exit 1
fi
