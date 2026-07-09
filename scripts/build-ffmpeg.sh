#!/usr/bin/env bash
# 从源码编译 x264 + FFmpeg，生成「视频缩放 + 兼容视频压缩 + 维度/兼容性探测」所需的 libav* 库。
# 功能：读 mov/mp4/mkv/webm/wmv 等视频 → scale 缩放；桌面输出 libx264/AAC MP4。
# 图片推断、维度读取与缩略图由 infer/image crate 处理。
# 由 kabegame-core 经 rsmpeg/rusty_ffmpeg 进程内链接（替代旧的 ffmpeg sidecar 调用）。
#
# 构建顺序：
#   1. 从 third/x264 源码编译 x264 → third/x264-build/install/
#      Linux 在 configure 后改写 config.h 关闭 HAVE_THP（透明大页）：
#        CEF 在 Linux 进程内用 PartitionAlloc 替换全局 memalign，其 kMaxSupportedAlignment
#        约为 1MB（kSuperPageSize/2）。x264 开启 THP 时，x264_malloc 对 >=1.75MB 的分配
#        （如 1080p 帧缓冲）会用 memalign(2MB, ...) 请求 2MB 对齐，超过上限 → 断言崩溃。
#        关闭 THP 后仅剩 NATIVE_ALIGN(64 字节) 对齐，在上限内；asm/AVX2 全部保留，性能不受影响。
#      macOS/Windows 无此问题（WebKit/WebView2 不替换全局分配器），正常编译。
#   2. 以 x264-build/install 为 PKG_CONFIG_PATH 前缀编译 FFmpeg（third/FFmpeg）
#      → third/FFmpeg-build/install/
#      x264 静态嵌入 libavcodec（Unix）/ avcodec DLL（Windows），不依赖任何系统 libx264。
#
# 链接模型（见 cocs/build/PLATFORM_SHARED_LIBS.md）：
#   - macOS/Linux：静态库（install/lib/*.a + install/include），rust build.rs 静态链接。
#   - Windows(MSYS2/MinGW)：动态库（avcodec-*.dll 等），用 gendef + lib.exe 生成 MSVC 导入库。
#
# 依赖：
#   - 所有平台：git submodule update --init third/FFmpeg third/x264
#   - Linux：nasm 可选（有则 x264 启用 asm 加速；无则自动降级 C 实现）
#   - macOS：nasm 可选（brew install nasm 获取性能版本；无则自动降级 C 实现）
#   - Windows(MSYS2 MinGW 64-bit)：nasm 可选（pacman -S nasm）、
#     gendef（pacman -S mingw-w64-x86_64-tools-git）、
#     VS 的 lib.exe（在 x64 Native Tools 环境中运行）
#     运行方式：
#       1. 打开 x64 Native Tools Command Prompt for VS
#       2. 执行 D:\Programs\MSYS2\msys2_shell.cmd -mingw64 -use-full-path -defterm -no-start -here -c "cd /d/Codes/kabegame && ./scripts/build-ffmpeg.sh"
#
# 参数：
#   --skip-x264   跳过重新编译 x264，复用 third/x264-build/install/ 下已有产物
#                 （仅需迭代 FFmpeg configure flags 时用，节省 x264 编译时间；
#                 若该目录下没有已安装的 x264 会报错退出）。

set -euo pipefail

SKIP_X264=0
_ARGS=()
for _arg in "$@"; do
  if [[ "$_arg" == "--skip-x264" ]]; then
    SKIP_X264=1
  else
    _ARGS+=("$_arg")
  fi
done
set -- "${_ARGS[@]}"

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FFMPEG_SRC="${REPO_ROOT}/third/FFmpeg"
BUILD_DIR="${REPO_ROOT}/third/FFmpeg-build"
INSTALL_DIR="${BUILD_DIR}/install"
X264_SRC="${REPO_ROOT}/third/x264"
X264_BUILD_DIR="${REPO_ROOT}/third/x264-build"
X264_INSTALL_DIR="${X264_BUILD_DIR}/install"
BUILD_TMP_DIR="${REPO_ROOT}/third/.tmp"

case "$(uname -s)" in
  Darwin)            OS_KIND="unix" ;;
  Linux)             OS_KIND="unix" ;;
  MINGW*|MSYS*|CYGWIN*) OS_KIND="windows" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

mkdir -p "$BUILD_TMP_DIR"
if [[ "$OS_KIND" == "windows" ]]; then
  BUILD_TMP_WIN="$(cygpath -w "$BUILD_TMP_DIR")"
  export TMPDIR="$BUILD_TMP_DIR"
  export TMP="$BUILD_TMP_WIN"
  export TEMP="$BUILD_TMP_WIN"
else
  export TMPDIR="$BUILD_TMP_DIR"
fi

if [[ ! -f "$FFMPEG_SRC/configure" ]]; then
  echo "FFmpeg 源码未找到: $FFMPEG_SRC/configure" >&2
  echo "请执行: git submodule update --init third/FFmpeg" >&2
  exit 1
fi
if [[ "$SKIP_X264" -eq 0 ]] && [[ ! -f "$X264_SRC/configure" ]]; then
  echo "x264 源码未找到: $X264_SRC/configure" >&2
  echo "请执行: git submodule update --init third/x264" >&2
  exit 1
fi
if [[ "$SKIP_X264" -eq 1 ]] && [[ ! -f "$X264_INSTALL_DIR/lib/pkgconfig/x264.pc" ]]; then
  echo "错误: --skip-x264 但未找到已安装的 x264: $X264_INSTALL_DIR/lib/pkgconfig/x264.pc" >&2
  echo "请先不带 --skip-x264 完整运行一次本脚本。" >&2
  exit 1
fi

# ---- 并发数 / make 命令（x264 与 FFmpeg 共用）----
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

# ---- 构建 x264 ----
if [[ "$SKIP_X264" -eq 1 ]]; then
  echo "=== 跳过构建 x264（--skip-x264），复用 $X264_INSTALL_DIR ==="
else
  echo "=== 构建 x264 ==="
  mkdir -p "$X264_BUILD_DIR" && cd "$X264_BUILD_DIR"

  X264_FLAGS=(
    "--prefix=$X264_INSTALL_DIR"
    "--enable-static"
    "--disable-cli"
  )
  case "$(uname -s)" in
    Linux)  X264_FLAGS+=("--enable-pic") ;;
    Darwin) X264_FLAGS+=("--enable-pic") ;;
    MINGW*|MSYS*|CYGWIN*)
      # Windows/MinGW：x264 静态库嵌入 avcodec.dll，不需要 --enable-pic
      ;;
  esac

  "$X264_SRC/configure" "${X264_FLAGS[@]}"

  if [[ "$OS_KIND" == "unix" && "$(uname -s)" == "Linux" ]]; then
    # Linux only: disable x264 THP. CEF's PartitionAlloc rejects the 2MB
    # alignment requested by x264_malloc for large frame buffers.
    sed -i 's/#define HAVE_THP 1/#define HAVE_THP 0/' config.h
    grep -q "#define HAVE_THP 0" config.h || {
      echo "错误: 未能在 x264 config.h 中关闭 HAVE_THP" >&2
      exit 1
    }
  fi

  $MAKE_CMD -j"$NPROC"
  $MAKE_CMD install
  echo "x264 已安装到: $X264_INSTALL_DIR"
fi

# ---- 设置 PKG_CONFIG_PATH（确保我们的 x264 优先于任何系统版本）----
# Windows：先把 MinGW 系统路径加进来，再把我们的 x264 插到最前面
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [[ -d /mingw64/lib/pkgconfig ]]; then
      export PKG_CONFIG_PATH="/mingw64/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    fi
    ;;
esac
export PKG_CONFIG_PATH="$X264_INSTALL_DIR/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# ---- 构建 FFmpeg ----
echo "=== 构建 FFmpeg ==="
mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"

# Windows：显式指定 pkg-config 可执行文件路径，确保 configure 子进程能找到 x264
CONFIGURE_EXTRA=()
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    _pkgconfig_exe=$(which pkg-config 2>/dev/null || true)
    if [[ -n "$_pkgconfig_exe" ]]; then
      CONFIGURE_EXTRA+=(--pkg-config="$_pkgconfig_exe")
    fi
    ;;
esac

# 最小化编译：mov/mkv/webm/wmv 解码 + scale + 桌面兼容视频编码；
# 同时保留 WebM muxer，供 MSE 多流合流时 stream-copy 输出 VP9/Opus WebM。
# 链接模型：Unix 静态库 / Windows 动态库（见文件头说明）。
_LINK_FLAGS=()
_EXTRA_LIBS=()
if [[ "$OS_KIND" == "windows" ]]; then
  _LINK_FLAGS=(--enable-shared --disable-static)
  # avutil 的 av_gettime()/av_usleep() 用到 clock_gettime64/nanosleep64，
  # mingw-w64 把这两个符号放在 libwinpthread 里（跟 FFmpeg 线程后端无关，
  # HAVE_PTHREADS 本来就是 no，用的是 HAVE_W32THREADS）。静态链接 libwinpthread.a
  # 进 avutil-*.dll，避免运行时再依赖单独的 libwinpthread-1.dll。
  # 必须用 --extra-libs 而非 --extra-ldflags：DLL 链接行是
  #   LINK( LINK_SO_ARGS <objects> FFEXTRALIBS )（见 FFmpeg ffbuild/library.mak），
  # extra-ldflags 落在 objects 之前（此时无未决符号，-lwinpthread 被丢弃，回退到动态导入库），
  # extra-libs 落在 FFEXTRALIBS 末尾即 objects 之后，才能解析 avutil 的未决符号并静态吸收。
  _EXTRA_LIBS=(--extra-libs="-Wl,-Bstatic -lwinpthread -Wl,-Bdynamic")
else
  _LINK_FLAGS=(--enable-static --disable-shared --enable-pic)
fi

CONFIG_FLAGS=(
  "--disable-everything"
  "--disable-programs"
  # 禁用可选硬件 API，静态 FFmpeg 不拉入 VA-API/VDPAU/DRM 动态库
  "--disable-hwaccels"
  "--disable-libdrm"
  "--disable-vaapi"
  "--disable-vdpau"
  "--disable-opencl"
  "--enable-gpl"

  "--enable-protocol=file"
  "--enable-demuxer=mov"
  "--enable-demuxer=matroska"
  "--enable-demuxer=asf"
  "--enable-decoder=h264"
  "--enable-decoder=hevc"
  "--enable-decoder=mpeg4"
  "--enable-decoder=vp8"
  "--enable-decoder=vp9"
  # AV1: bilibili/YouTube DASH 常用 av01。桌面预览缩略图/兼容副本需解码一帧;
  # 内嵌 Chromium/CEF 播放不经 ffmpeg。用原生 av1 解码器(无外部依赖,单帧解码够用)。
  "--enable-decoder=av1"
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
  "--enable-parser=av1"
  "--enable-parser=vc1"
  "--enable-muxer=mov"
  "--enable-muxer=mp4"
  "--enable-muxer=webm"

  # 音频：兼容视频转 H.264 mp4 时需保留音轨 → 解码源音频 + AAC 编码
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

  # binding 里引用了符号但没有调用，去掉无影响
  "--disable-avdevice"
  "--disable-doc"
  "--disable-iconv"
  "--disable-zlib"
  "--disable-bzlib"
  "--disable-lzma"
  "--enable-small"
  "--disable-runtime-cpudetect"

  "--enable-libx264"
  "--enable-encoder=libx264"
)

"$FFMPEG_SRC/configure" \
  --prefix="$INSTALL_DIR" \
  "${CONFIG_FLAGS[@]}" \
  --extra-cflags="-O2" \
  "${_LINK_FLAGS[@]}" \
  "${_EXTRA_LIBS[@]}" \
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

$MAKE_CMD -j"$NPROC"
$MAKE_CMD install

# ---- 校验 ----
if [[ ! -f "$INSTALL_DIR/lib/pkgconfig/libavcodec.pc" ]]; then
  echo "未找到 libav* 安装产物: $INSTALL_DIR/lib/pkgconfig/libavcodec.pc" >&2
  exit 1
fi

# Linux 静态链接校验：libavcodec.a 须携带 -lx264（来自我们自己编译的 x264）
if [[ "$(uname -s)" == "Linux" ]]; then
  _pc_path="$INSTALL_DIR/lib/pkgconfig:$X264_INSTALL_DIR/lib/pkgconfig"
  _ffmpeg_static_libs="$(PKG_CONFIG_PATH="$_pc_path" pkg-config --libs --static libavcodec)"
  if [[ "$_ffmpeg_static_libs" != *"-lx264"* ]]; then
    echo "错误: FFmpeg 静态链接信息缺少 -lx264" >&2
    echo "请确认 configure 已启用 libx264，然后重新运行 bun run build:ffmpeg" >&2
    exit 1
  fi
fi

if [[ "$OS_KIND" != "windows" ]]; then
  rm -f "$INSTALL_DIR/lib/libavdevice"*.a "$INSTALL_DIR/lib/pkgconfig/libavdevice.pc"
  echo "已输出静态库: $INSTALL_DIR/lib/*.a  头文件: $INSTALL_DIR/include"
  echo "rust build.rs 将经 FFMPEG_PKG_CONFIG_PATH=$INSTALL_DIR/lib/pkgconfig 静态链接。"
  exit 0
fi

# ---- Windows：生成 MSVC 导入库 ----
# DLL 复制到 bin/windows/ 由 scripts/plugins/os-plugin.ts 在 build 期处理
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

if ! command -v gendef &>/dev/null; then
  echo "错误: 未找到 gendef。请在 MSYS2 执行: pacman -S mingw-w64-x86_64-tools-git" >&2
  exit 1
fi
if ! command -v lib.exe &>/dev/null && ! command -v lib &>/dev/null; then
  echo "错误: 未找到 lib.exe。请在 'x64 Native Tools / VS Developer' 环境运行本脚本。" >&2
  exit 1
fi
_LIB_EXE="lib.exe"; command -v lib.exe &>/dev/null || _LIB_EXE="lib"
_DEF_DIR="$BUILD_DIR/msvc-implib"
mkdir -p "$_DEF_DIR"
for _dll in "${_dlls[@]}"; do
  _base="$(basename "$_dll" .dll)"
  _libname="${_base%%-*}"
  ( cd "$_DEF_DIR" && gendef "$_dll" >/dev/null 2>&1 )
  _def="$_DEF_DIR/${_base}.def"
  if [[ ! -f "$_def" ]]; then
    echo "未能为 $(basename "$_dll") 生成 .def" >&2
    exit 1
  fi
  # lib.exe 是 MSVC 原生工具,只认 Windows 路径。用 cygpath -w 显式转换,并用 -def:/-out:
  # 形式(前导 '-' 不会被 MSYS2 当作路径参数尝试转换),不依赖 MSYS2 的自动路径转换启发式。
  _def_win="$(cygpath -w "$_def")"
  _out_win="$(cygpath -w "$INSTALL_DIR/lib/${_libname}.lib")"
  _lib_out="$(mktemp)"
  if ! "$_LIB_EXE" "-def:$_def_win" -machine:x64 "-out:$_out_win" >"$_lib_out" 2>&1; then
    echo "错误: lib.exe 为 $(basename "$_dll") 生成导入库失败:" >&2
    cat "$_lib_out" >&2
    rm -f "$_lib_out"
    exit 1
  fi
  rm -f "$_lib_out"
  echo "已生成 MSVC 导入库: ${_libname}.lib"
done
echo "Windows libav* DLL 留在 $INSTALL_DIR/bin（由 os-plugin 在 build 期复制到 bin/windows）；MSVC 导入库已生成到 $INSTALL_DIR/lib。"
