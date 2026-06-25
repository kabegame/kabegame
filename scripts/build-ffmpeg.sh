#!/usr/bin/env bash
# 一键编译 FFmpeg：生成「视频缩放 + mp4 压缩 + 视频维度/兼容性探测」所需的 libav* 库（最小化编译，不再产出 CLI）。
# 功能：读 mov/mp4/mkv/webm/wmv 等视频 → scale 缩放 → libx264/AAC 编码；图片推断、维度读取与缩略图由 infer/image crate 处理。
# 由 kabegame-core 经 rsmpeg/rusty_ffmpeg 进程内链接（替代旧的 ffmpeg sidecar 调用）。
#
# 链接模型（见 cocs / 计划）：
#   - macOS/Linux：静态库（install/lib/*.a + install/include），rust build.rs 静态链接。
#   - Windows(MSYS2/MinGW)：动态库（avcodec-*.dll 等），用 gendef + lib.exe 生成 MSVC 导入库供 windows-msvc 链接，
#     DLL 复制到仓库根 bin/windows/ → resources/bin 由 scripts/plugins/os-plugin.ts 在 build 期处理。
#     —— 之所以 Windows 走 DLL：Dokan 仅有 MSVC 导入库，主程序须保持 windows-msvc；
#        而 MinGW 编出的 libav* 静态库无法被 MSVC 链接，DLL 的 C 导出表则跨工具链可用。
#
# 依赖: libx264
#   macOS:   brew install x264
#   Ubuntu:  apt install libx264-dev
#   Windows: 必须在 MSYS2 MinGW 64-bit 中安装：pacman -S mingw-w64-x86_64-x264 mingw-w64-x86_64-tools-git
#             （tools-git 提供 gendef；生成 MSVC 导入库还需 PATH 上有 VS 的 lib.exe，即在 VS Developer 环境运行）
#             （Git Bash 无 pacman，无法直接安装 x264，请改用 MSYS2 终端再执行本脚本）
#            1. 打开 x64 Native Tools Command Prompt for VS 
#            2. 执行 D:\Programs\MSYS2\msys2_shell.cmd -mingw64 -use-full-path -defterm -no-start -here -c "cd /d/Codes/kabegame && ./scripts/build-ffmpeg.sh"

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FFMPEG_SRC="${REPO_ROOT}/third/FFmpeg"
BUILD_DIR="${REPO_ROOT}/third/FFmpeg-build"
INSTALL_DIR="${BUILD_DIR}/install"
# 本脚本只产出 install/{bin,lib,include}/。把 install/bin/ 下的 DLL 复制到 bin/windows/
# 由 scripts/plugins/os-plugin.ts 在 build 期负责（含校验 + 报错提示），见 cocs/build/PLATFORM_SHARED_LIBS.md。

case "$(uname -s)" in
  Darwin)   OS_KIND="unix" ;;
  Linux)    OS_KIND="unix" ;;
  MINGW*|MSYS*|CYGWIN*) OS_KIND="windows" ;;
  *)        echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

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
esac

# 最小化编译：mov/mkv/webm/wmv 解码 + scale + libx264/AAC，输出 mp4；并保留 libav* 供进程内视频 API 使用。
# 链接模型：Unix 静态库 / Windows 动态库（见文件头说明）。
_LINK_FLAGS=()
if [[ "$OS_KIND" == "windows" ]]; then
  _LINK_FLAGS=(--enable-shared --disable-static)
else
  _LINK_FLAGS=(--enable-static --disable-shared --enable-pic)
fi

CONFIG_FLAGS=(
  "--disable-everything"
  "--disable-programs"
  "--enable-gpl"
  "--enable-libx264"

  "--enable-protocol=file"
  "--enable-demuxer=mov"
  "--enable-demuxer=matroska"
  "--enable-demuxer=asf"
  "--enable-decoder=h264"
  "--enable-decoder=hevc"
  "--enable-decoder=mpeg4"
  "--enable-decoder=vp8"
  "--enable-decoder=vp9"
  "--enable-decoder=wmv1"
  "--enable-decoder=wmv2"
  "--enable-decoder=wmv3"
  "--enable-decoder=vc1"
  "--enable-decoder=msmpeg4v1"
  "--enable-decoder=msmpeg4v2"
  "--enable-decoder=msmpeg4v3"
  "--enable-parser=h264"
  "--enable-parser=hevc"
  "--enable-parser=mpeg4video"
  "--enable-parser=vp8"
  "--enable-parser=vp9"
  "--enable-parser=vc1"
  "--enable-encoder=libx264"
  "--enable-muxer=mov"
  "--enable-muxer=mp4"

  # 音频:浏览器兼容版本(compatible_path)转 H.264 mp4 时需保留音轨 → 解码源音频 + AAC 编码。
  "--enable-decoder=aac"
  "--enable-decoder=mp3float"
  "--enable-decoder=ac3"
  "--enable-decoder=vorbis"
  "--enable-decoder=opus"
  "--enable-decoder=flac"
  "--enable-decoder=wmav1"
  "--enable-decoder=wmav2"
  "--enable-decoder=wmapro"
  "--enable-encoder=aac"
  "--enable-parser=aac"
  "--enable-muxer=ipod"
  "--enable-swresample"

  "--enable-filter=scale"
  "--enable-filter=buffer"
  "--enable-filter=buffersink"
  "--enable-filter=format"
  "--enable-filter=aresample"
  "--enable-filter=aformat"
  "--enable-filter=anull"
  "--enable-filter=abuffer"
  "--enable-filter=abuffersink"
  "--enable-filter=asetnsamples"

  "--enable-swscale"

  # binding里引用了符号，但没有调用，所以去掉这玩意没影响
  "--disable-avdevice"
  "--disable-doc"
  "--enable-small"
  "--disable-runtime-cpudetect"
)


"$FFMPEG_SRC/configure" \
  --prefix="$INSTALL_DIR" \
  "${CONFIG_FLAGS[@]}" \
  --extra-cflags="-O2" \
  "${_LINK_FLAGS[@]}" \
  "${CONFIGURE_EXTRA[@]}" \
  "$@"


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

# 校验库与头文件已安装（供 rust build.rs 经 pkg-config / FFMPEG_LIBS_DIR 链接）
if [[ ! -f "$INSTALL_DIR/lib/pkgconfig/libavcodec.pc" ]]; then
  echo "未找到 libav* 安装产物: $INSTALL_DIR/lib/pkgconfig/libavcodec.pc" >&2
  exit 1
fi

if [[ "$OS_KIND" != "windows" ]]; then
  # 去除 avdevice 静态库与 .pc（--disable-avdevice 通常不产出，防止 configure 变体残留）
  rm -f "$INSTALL_DIR/lib/libavdevice"*.a "$INSTALL_DIR/lib/pkgconfig/libavdevice.pc"
  echo "已输出静态库: $INSTALL_DIR/lib/*.a  头文件: $INSTALL_DIR/include"
  echo "rust build.rs 将经 FFMPEG_PKG_CONFIG_PATH=$INSTALL_DIR/lib/pkgconfig 静态链接。"
  exit 0
fi

# ---- Windows：生成 MSVC 导入库 ----
# DLL 复制到 bin/windows/ 的步骤已迁出，由 scripts/plugins/os-plugin.ts 在 build 期处理
# （见 OSPlugin.collectWindowsFFmpegDlls()）。本脚本只产出 install/{bin,lib,include}/ 与 .lib。
shopt -s nullglob
_dlls=()
for _dll in "$INSTALL_DIR/bin"/av*.dll "$INSTALL_DIR/bin"/swscale-*.dll "$INSTALL_DIR/bin"/swresample-*.dll; do
  [[ "$(basename "$_dll")" == avdevice-* ]] && continue
  _dlls+=("$_dll")
done
if [[ ${#_dlls[@]} -eq 0 ]]; then
  echo "未找到 libav* DLL: $INSTALL_DIR/bin/*.dll" >&2
  exit 1
fi

# 生成 MSVC 导入库（.lib）：gendef 从 DLL 提取 .def，再用 VS 的 lib.exe 生成 <name>.lib
#   输出到 install/lib（与 .pc 同目录，便于 build.rs 经 FFMPEG_LIBS_DIR 找到）
if ! command -v gendef &>/dev/null; then
  echo "错误: 未找到 gendef（生成 .def 需要）。请在 MSYS2 执行: pacman -S mingw-w64-x86_64-tools-git" >&2
  exit 1
fi
if ! command -v lib.exe &>/dev/null && ! command -v lib &>/dev/null; then
  echo "错误: 未找到 lib.exe（MSVC 库管理器）。请在 'x64 Native Tools / VS Developer' 环境运行本脚本。" >&2
  exit 1
fi
_LIB_EXE="lib.exe"; command -v lib.exe &>/dev/null || _LIB_EXE="lib"
_DEF_DIR="$BUILD_DIR/msvc-implib"
mkdir -p "$_DEF_DIR"
for _dll in "${_dlls[@]}"; do
  _base="$(basename "$_dll" .dll)"             # e.g. avcodec-61
  _libname="${_base%%-*}"                       # e.g. avcodec（rusty_ffmpeg 链接名）
  ( cd "$_DEF_DIR" && gendef "$_dll" >/dev/null 2>&1 )
  _def="$_DEF_DIR/${_base}.def"
  if [[ ! -f "$_def" ]]; then
    echo "未能为 $(basename "$_dll") 生成 .def" >&2
    exit 1
  fi
  "$_LIB_EXE" "/def:$_def" /machine:x64 "/out:$INSTALL_DIR/lib/${_libname}.lib" >/dev/null
  echo "已生成 MSVC 导入库: ${_libname}.lib"
done
echo "Windows libav* DLL 留在 $INSTALL_DIR/bin（由 os-plugin 在 build 期复制到 bin/windows）；MSVC 导入库已生成到 $INSTALL_DIR/lib。"
