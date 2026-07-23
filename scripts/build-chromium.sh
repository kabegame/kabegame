#!/usr/bin/env bash
#
# 编译带专利编码(H.264/AAC/MP4)的 CEF(Chromium Embedded Framework)。
# 官方 Spotify 预编译版用 ffmpeg_branding=Chromium,不含 H.264/AAC;这里用
# proprietary_codecs=true + ffmpeg_branding=Chrome 自己编一份,供 tauri-runtime-cef 使用。
#
# 用法:
#   scripts/build-chromium.sh dev            # 快速开发版(关 LTO),已有 checkout 则增量重编
#   scripts/build-chromium.sh prod           # 最小体积发布版(开 LTO + optimize_for_size)
#   scripts/build-chromium.sh dev  --clean   # 强制全量重新 checkout + 编译(首次/想推倒重来)
#   scripts/build-chromium.sh prod --clean
#   scripts/build-chromium.sh prod --target x86_64   # (仅 macOS)跨编 Intel 版 CEF
#
# --target x86_64|arm64(仅 macOS):在一台 Mac 上为另一架构编 CEF。默认宿主架构,
#   即 Apple Silicon 上不传时行为与以往完全一致。两种架构的产物彼此隔离:
#     arm64  → out/Release_GN_arm64 → 导出到 <root>/cef-<variant>
#     x86_64 → out/Release_GN_x64   → 导出到 <root>/cef-<variant>-x64
#   Chromium checkout(CEFBUILD)两者共用,只是 out/ 子目录不同;想彻底分开可用
#   CEFBUILD 环境变量各指一处(代价是多一份数十 G 的源码树)。
#   导出目录后缀需与 scripts/utils.ts 的 CEF_DIR_SUFFIX 保持一致 —— mode-plugin
#   会按同样的规则推导默认 CEF_PATH。
#
# 默认路径:
#   Linux:       构建根目录 ~/i/cefbuild, runtime ~/i/cef-dev 或 ~/i/cef-prod
#   Windows/MSYS:构建根目录 H:\cefbuild, runtime H:\cef-dev 或 H:\cef-prod
#   macOS:       构建根目录 /Volumes/KIOXIA/cefbuild, runtime /Volumes/KIOXIA/cef-dev 或 cef-prod
#                (x86_64 目标为 cef-dev-x64 / cef-prod-x64)
#
# Linux 关键前提:Chromium/CEF 的源码树重度依赖符号链接 + POSIX 权限 + 大小写敏感,
# exFAT/NTFS 都不行。本机已把构建空间放到 POSIX 文件系统下的 ~/i。
#
# Windows 关键前提:在 MSYS2 bash 中运行,建议从 VS x64 Native Tools 环境启动
# msys2_shell.cmd -mingw64/-msys -use-full-path,并把 H:\cefbuild 放在 NTFS 盘。
#
# macOS 关键前提:完整 Xcode/macOS SDK;构建空间必须是 APFS/HFS+ 等支持符号链接的
# 文件系统,不能是 exFAT。Apple Silicon 上可经 --target x86_64 跨编 Intel 版
# (Chromium 的 mac toolchain 本身支持 target_cpu=x64,与宿主架构无关)。
#
set -euo pipefail

# 仓库内 third/cef 是 Kabegame 的 CEF fork，也是所有 CEF 构建的源码入口。
# automate-git.py 会从这里创建 cefbuild/chromium_git/cef 的本地 clone，避免构建
# 过程中回退到官方 CEF checkout 而漏掉 Kabegame patch。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CEF_SOURCE="${CEF_SOURCE:-$REPO_ROOT/third/cef}"

# ---------------------------------------------------------------------------
# 可调参数
# ---------------------------------------------------------------------------
CEF_BRANCH="${CEF_BRANCH:-7827}"                     # 对应 CEF 149.0.x / Chromium 149.0.7827.x(与 cef-rs "149" 对齐)
CEF_RS_ARCHIVE_VERSION="${CEF_RS_ARCHIVE_VERSION:-149.0.2}" # 对应 Cargo.lock 里的 cef-dll-sys 149.0.0+149.0.2

# 浅 checkout:只拉当前分支 tip,不下完整 git 历史(chromium/src 历史占大头,
# 全量单次 fetch ≈17G 过代理极易被掐断且不可续传)。牺牲 git 历史换"一次能下完"。
# 注意:
#   - 首次切成浅 checkout 时,已有的全量残包版本对不上,automate 会要求删掉重来,
#     所以切换那一次必须带 --clean(触发 --force-clean)。
#   - 将来升 CEF 大版本时浅仓库增量可能又炸成大包,届时可能要重下一次。
NO_HISTORY="${NO_HISTORY:-1}"        # 1=浅 checkout(--no-chromium-history);0=全量历史

# gclient DEPS 同步并发。gclient 默认 max(8, CPU 数)(本机 24),几十个并行 fetch
# 打同一个代理出口,googlesource 直接 429 限流,sync 断在半路(v8/skia 空目录的根因)。
# automate-git.py 没有透传参数,只能用 PATH shim 包一层 gclient 注入 --jobs。
GCLIENT_JOBS="${GCLIENT_JOBS:-4}"

# 编译并发上限(autoninja 的 NINJA_CORE_LIMIT)。默认 24 路并行 clang 编 Blink/V8
# bindings 单个可吃 1-2G+,31G 内存 + 小 swap 直接 OOM。16 路 ≈ 峰值 24-32G,
# 配合大 swap 可撑住;还 OOM 就继续调低。
NINJA_JOBS="${NINJA_JOBS:-16}"

log() { printf '\033[1;36m[build-chromium]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-chromium] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux*)
    HOST_OS="linux"
    CEF_ROOT="${CEF_ROOT:-$HOME/i}"                  # CEF 构建与 runtime 根目录
    CEFBUILD="${CEFBUILD:-$CEF_ROOT/cefbuild}"       # 构建根目录
    CEF_EXPORT_ROOT="${CEF_EXPORT_ROOT:-$CEF_ROOT}"  # cef-rs 扁平 runtime 导出目录的父目录
    CEF_ARCHIVE_PLATFORM="linux64"
    CEF_RUNTIME_LIB="libcef.so"
    PYTHON_BIN="${PYTHON_BIN:-python3}"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    HOST_OS="windows"
    # 用户在 MSYS2 中运行时,/h/cefbuild 对应 H:\cefbuild。
    if [[ -z "${CEF_ROOT:-}" ]]; then
      if command -v cygpath >/dev/null 2>&1; then
        CEF_ROOT="$(cygpath -u 'H:/')"
      else
        CEF_ROOT="/h"
      fi
    fi
    CEFBUILD="${CEFBUILD:-$CEF_ROOT/cefbuild}"
    CEF_EXPORT_ROOT="${CEF_EXPORT_ROOT:-$CEF_ROOT}"
    CEF_ARCHIVE_PLATFORM="windows64"
    CEF_RUNTIME_LIB="libcef.dll"
    PYTHON_BIN="${PYTHON_BIN:-python}"
    ;;
  Darwin*)
    HOST_OS="darwin"
    CEF_ROOT="${CEF_ROOT:-/Volumes/KIOXIA}"          # macOS CEF 构建与 runtime 根目录
    CEFBUILD="${CEFBUILD:-$CEF_ROOT/cefbuild}"       # 构建根目录
    CEF_EXPORT_ROOT="${CEF_EXPORT_ROOT:-$CEF_ROOT}"  # cef-rs 扁平 runtime 导出目录的父目录
    # CEF_ARCHIVE_PLATFORM / GN 输出目录 / 导出目录后缀由目标架构决定,
    # 在下面的参数解析(--target)之后统一设置。
    CEF_RUNTIME_LIB="Chromium Embedded Framework.framework"
    PYTHON_BIN="${PYTHON_BIN:-python3}"
    ;;
  *)
    echo "Unsupported OS: $UNAME_S" >&2
    exit 1
    ;;
esac

is_windows() { [[ "$HOST_OS" == "windows" ]]; }
is_linux() { [[ "$HOST_OS" == "linux" ]]; }
is_macos() { [[ "$HOST_OS" == "darwin" ]]; }

host_path() {
  if is_windows; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
VARIANT="${1:-dev}"
CLEAN=0
TARGET_ARCH=""
_rest=("${@:2}")
i=0
while [[ $i -lt ${#_rest[@]} ]]; do
  a="${_rest[$i]}"
  case "$a" in
    --clean) CLEAN=1 ;;
    --target) i=$((i + 1)); TARGET_ARCH="${_rest[$i]:-}" ;;
    --target=*) TARGET_ARCH="${a#--target=}" ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
  i=$((i + 1))
done
case "$VARIANT" in
  dev|prod) ;;
  *) echo "用法: $0 [dev|prod] [--clean] [--target x86_64|arm64]" >&2; exit 2 ;;
esac

# --target 仅 macOS 支持(用于在一台 Mac 上跨编另一架构的 CEF)。Linux/Windows 恒为 x64,
# 不接受该参数。未指定时默认宿主架构 —— 即 Apple Silicon 上的既有行为(arm64)不变。
if [[ -n "$TARGET_ARCH" ]]; then
  if ! is_macos; then
    die "--target 仅在 macOS 上支持(跨编 x86_64 / arm64);当前宿主: $UNAME_S"
  fi
  case "$TARGET_ARCH" in
    x86_64|x64|amd64|x86_64-apple-darwin) TARGET_ARCH="x86_64" ;;
    arm64|aarch64|aarch64-apple-darwin)   TARGET_ARCH="arm64" ;;
    *) die "未知 --target: '$TARGET_ARCH'(允许 x86_64 | arm64)" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 目标架构 → automate-git 的 arch flag / GN 输出目录 / distrib 平台名 / 导出目录后缀
# ---------------------------------------------------------------------------
# x86_64 的 runtime 导出到 cef-<variant>-x64,与 arm64 的 cef-<variant> 彻底隔开
# ——两者是同名 framework 的不同架构,共用一个目录必然互相覆盖,且架构错配要到
# 链接期(ld: building for macOS-x86_64 but linking arm64)才暴露。
# 该后缀必须与 scripts/utils.ts 的 CEF_DIR_SUFFIX 保持一致。
CEF_EXPORT_SUFFIX=""
CEF_GN_OUT="Release_GN_x64"
CEF_ARCH_FLAG="--x64-build"
if is_macos; then
  [[ -n "$TARGET_ARCH" ]] || TARGET_ARCH="$(uname -m)"   # arm64 | x86_64
  case "$TARGET_ARCH" in
    x86_64)
      CEF_ARCHIVE_PLATFORM="macosx64"
      CEF_ARCH_FLAG="--x64-build"
      CEF_GN_OUT="Release_GN_x64"
      CEF_EXPORT_SUFFIX="-x64"
      ;;
    arm64)
      CEF_ARCHIVE_PLATFORM="macosarm64"
      CEF_ARCH_FLAG="--arm64-build"
      CEF_GN_OUT="Release_GN_arm64"
      CEF_EXPORT_SUFFIX=""
      ;;
    *) die "无法识别的 macOS 架构: $TARGET_ARCH" ;;
  esac
  log "目标架构: $TARGET_ARCH(宿主 $(uname -m))"
  log "GN 输出目录: out/$CEF_GN_OUT   distrib 平台名: $CEF_ARCHIVE_PLATFORM"

  # 关键:automate-git 的 --x64-build/--arm64-build 只决定它**期望读取**的 out 目录名
  # (get_build_directory_name),并不会告诉 CEF 的 gn_args.py 要为哪个架构生成配置。
  # gn_args.py 的 GetAllPlatformConfigs 只按**宿主** machine 决定生成哪些 CPU:
  #   arm64 宿主 → 只生成 Release_GN_arm64;要生成 x64 必须 CEF_ENABLE_AMD64=1。
  # 二者脱节时,automate 找不到 out/Release_GN_x64/args.gn 直接抛
  #   `Exception: Path does not exist: .../out/Release_GN_x64/args.gn`。
  # 这里按目标架构显式放行,并用 GN_OUT_CONFIGS 把生成收敛到目标那一个 Release 配置
  # ——本脚本恒传 --no-debug-build,只编 Release;同时避免顺带重生成宿主架构的配置。
  case "$TARGET_ARCH" in
    x86_64) export CEF_ENABLE_AMD64=1 ;;
    arm64)  export CEF_ENABLE_ARM64=1 ;;
  esac
  export GN_OUT_CONFIGS="$CEF_GN_OUT"
  log "gn_args 放行: CEF_ENABLE_$([[ "$TARGET_ARCH" == x86_64 ]] && echo AMD64 || echo ARM64)=1   GN_OUT_CONFIGS=$GN_OUT_CONFIGS"
fi

# ---------------------------------------------------------------------------
# 1. 确保构建目录存在
# ---------------------------------------------------------------------------
ensure_build_dir() {
  mkdir -p "$CEFBUILD"
  log "构建空间: $CEFBUILD"
  log "runtime 导出父目录: $CEF_EXPORT_ROOT"
}

# ---------------------------------------------------------------------------
# 2. 验证构建空间
# ---------------------------------------------------------------------------
check_build_dir() {
  if is_windows; then
    log "Windows/MSYS 分支:跳过 POSIX 符号链接检查,请确认 H:\\cefbuild 位于 NTFS 盘。"
    return
  fi

  local t="$CEFBUILD/.symlink_test"
  rm -f "$t" "$t.lnk" 2>/dev/null || true
  : > "$t"
  if ln -s "$t" "$t.lnk" 2>/dev/null; then
    rm -f "$t" "$t.lnk"
    log "符号链接可用 ✓"
  else
    rm -f "$t" 2>/dev/null || true
    die "构建空间不支持符号链接($CEFBUILD)。它必须是 ext4 等 POSIX 文件系统,不能是 exFAT/NTFS。"
  fi
}

# ---------------------------------------------------------------------------
# 3. 准备仓库内 CEF fork 引用
# ---------------------------------------------------------------------------
prepare_cef_reference() {
  [[ -d "$CEF_SOURCE" ]] || die "CEF 源码不存在: $CEF_SOURCE（请先 git submodule update --init third/cef）"
  git -C "$CEF_SOURCE" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "third/cef 不是有效的 Git checkout: $CEF_SOURCE"

  CEF_SOURCE_COMMIT="$(git -C "$CEF_SOURCE" rev-parse HEAD)"
  if is_windows; then
    # automate-git.py 会把 --url 拼进 git 命令；使用 mixed path 避免反斜杠
    # 在 shell 中被当成转义字符。
    CEF_SOURCE_URL="$(cygpath -m "$CEF_SOURCE")"
  else
    CEF_SOURCE_URL="$CEF_SOURCE"
  fi

  # 增量构建可能已有官方 CEF checkout。把它的 origin 校正到 third/cef，
  # automate-git.py 随后会 fetch 当前提交并在需要时重拷贝 chromium/src/cef。
  local checkout="$CEFBUILD/chromium_git/cef"
  if git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$checkout" remote set-url origin "$CEF_SOURCE_URL"
  fi

  log "CEF 源码引用: $CEF_SOURCE"
  log "CEF 源码提交: $CEF_SOURCE_COMMIT"
}

# ---------------------------------------------------------------------------
# 4. 环境变量
# ---------------------------------------------------------------------------
setup_env() {
  mkdir -p "$CEFBUILD"/{tmp,cache,depot_tools,automate,shim}
  export TMPDIR="$CEFBUILD/tmp"          # 别用 16G 的 /tmp tmpfs
  export XDG_CACHE_HOME="$CEFBUILD/cache" # vpython/gsutil 缓存别写满 /home
  if is_windows; then
    local tmp_win
    tmp_win="$(host_path "$CEFBUILD/tmp")"
    export TMP="$tmp_win"
    export TEMP="$tmp_win"
    export DEPOT_TOOLS_WIN_TOOLCHAIN="${DEPOT_TOOLS_WIN_TOOLCHAIN:-0}"
    export GYP_MSVS_VERSION="${GYP_MSVS_VERSION:-2026}"
    if [[ "$GYP_MSVS_VERSION" == "2026" ]]; then
      export vs2026_install="${vs2026_install:-D:\\Applications\\Microsoft Visual Studio\\18\\Community}"
    fi
    # Let Chromium's vs_toolchain.py use vs2026_install/version detection.
    # A stale override can bypass runtime discovery and point at VS 2022.
    unset GYP_MSVS_OVERRIDE_PATH
    log "VS toolchain: GYP_MSVS_VERSION=$GYP_MSVS_VERSION"
    [[ -n "${vs2026_install:-}" ]] && log "VS 2026 install: $vs2026_install"
  fi

  # gclient shim:对 sync/revert 注入 --jobs,压低 DEPS 并发防 googlesource 429。
  # automate-git.py 通过 PATH 调 gclient,shim 排在 depot_tools 前即可拦截。
  cat > "$CEFBUILD/shim/gclient" <<EOF
#!/usr/bin/env bash
args=("\$@")
case "\${1:-}" in sync|revert) args+=(--jobs $GCLIENT_JOBS) ;; esac
exec "$CEFBUILD/depot_tools/gclient" "\${args[@]}"
EOF
  chmod +x "$CEFBUILD/shim/gclient"
  if is_windows; then
    local gclient_bat
    gclient_bat="$(host_path "$CEFBUILD/depot_tools/gclient.bat")"
    cat > "$CEFBUILD/shim/gclient.bat" <<EOF
@echo off
setlocal
if /I "%~1"=="sync" goto with_jobs
if /I "%~1"=="revert" goto with_jobs
call "$gclient_bat" %*
exit /b %ERRORLEVEL%
:with_jobs
call "$gclient_bat" %* --jobs $GCLIENT_JOBS
exit /b %ERRORLEVEL%
EOF
  fi
  export PATH="$CEFBUILD/shim:$CEFBUILD/depot_tools:$PATH"
  export CEF_USE_GN=1
  # 不设 GN_ARGUMENTS:gn 的 --ide 没有 "none" 取值,不生成 IDE 工程就别传 --ide
  export DEPOT_TOOLS_UPDATE=1
  export NINJA_CORE_LIMIT="$NINJA_JOBS"   # 封顶 autoninja/siso 编译并发,防 OOM
}

# ---------------------------------------------------------------------------
# 5. 引导 depot_tools + automate-git.py
# ---------------------------------------------------------------------------
bootstrap() {
  if [[ ! -x "$CEFBUILD/depot_tools/gclient" && ! -f "$CEFBUILD/depot_tools/gclient.bat" ]]; then
    log "拉取 depot_tools..."
    git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git \
      "$CEFBUILD/depot_tools"
  fi
  if [[ ! -f "$CEFBUILD/automate/automate-git.py" ]]; then
    log "下载 automate-git.py..."
    curl -fSL \
      https://raw.githubusercontent.com/chromiumembedded/cef/master/tools/automate/automate-git.py \
      -o "$CEFBUILD/automate/automate-git.py"
  fi
}

# ---------------------------------------------------------------------------
# 6. 按 variant 设置 GN_DEFINES + distrib 参数
# ---------------------------------------------------------------------------
configure_variant() {
  # 注意:CEF 7827 的 gn_args.py GetRequiredArgs() 硬性要求 optimize_webui=true、
  # enable_widevine=true(还有 //cef/BUILD.gn 的 assert 兜底),覆盖会直接 assertion,
  # 所以这两项不能出现在 GN_DEFINES 里。
  # enable_nacl 已随 NaCl 从 Chromium 149 移除,不要再设(设了报 has no effect)
  local common="proprietary_codecs=true ffmpeg_branding=Chrome"
  if is_linux; then
    common="$common use_sysroot=true"
  fi
  # PGO(按性能剖析优化):is_official_build=true 时 Chromium 默认开启
  # chrome_pgo_phase,gn gen 阶段会去取 chrome-linux-*.profdata。该 profile 由
  # gclient runhooks 下载,前提是 .gclient 的 custom_vars.checkout_pgo_profiles=True。
  # automate-git.py 的 --with-pgo-profiles 会在(重)生成 .gclient 时把它写成 True。
  # 只有全量/--force-config 才会重写 .gclient,所以此 flag 主要对带 --clean 的重建生效;
  # 增量重编下需已存在 profile(见脚本注释与手动 update_pgo_profiles.py update)。
  # dev 是 is_official_build=false,PGO 默认关闭,不需要 profile。
  PGO_FLAGS=()
  if [[ "$VARIANT" == "dev" ]]; then
    # 快:关 LTO、不要符号
    export GN_DEFINES="$common is_official_build=false symbol_level=0 blink_symbol_level=0 dcheck_always_on=false"
    DISTRIB_FLAGS=(--minimal-distrib-only --no-distrib-docs --no-distrib-symbols --distrib-subdir-suffix=dev)
  else
    # 小:开 LTO + 体积优化
    local prod_extra="optimize_for_size=true symbol_level=0"
    if is_linux; then
      prod_extra="$prod_extra use_cups=false"
    fi
    export GN_DEFINES="$common is_official_build=true $prod_extra"
    DISTRIB_FLAGS=(--minimal-distrib-only --no-distrib-docs --distrib-subdir-suffix=prod)
    PGO_FLAGS=(--with-pgo-profiles)   # 让全量 checkout 自动下载 PGO profile
  fi
  log "variant=$VARIANT"
  log "GN_DEFINES=$GN_DEFINES"
}

# ---------------------------------------------------------------------------
# 7. 决定全量 checkout 还是增量重编
# ---------------------------------------------------------------------------
configure_update() {
  local src="$CEFBUILD/chromium_git/chromium/src"
  if [[ "$CLEAN" == 1 || ! -d "$src" ]]; then
    [[ "$CLEAN" == 1 ]] && log "强制全量 checkout (--clean)" || log "首次:全量 checkout(会拉取数十 G,耗时较长)"
    UPDATE_FLAGS=(--force-clean)
  else
    log "增量:复用 Chromium checkout,同步 third/cef 后重编 + 重新打包"
    UPDATE_FLAGS=(--no-chromium-update --force-cef-update --force-build --force-distrib)
  fi
}

# ---------------------------------------------------------------------------
# 7b. 确保目标架构的 PGO profile 就位(仅 prod 增量构建)
# ---------------------------------------------------------------------------
# prod 是 is_official_build=true,gn gen 阶段要读 chrome/build/pgo_profiles/ 下与
# chrome/build/<target>.pgo.txt 同名的 .profdata。全量 checkout 由 --with-pgo-profiles
# 触发 gclient runhook 下载;但**增量**重编不重跑 runhook,且 .gclient 常年
# checkout_pgo_profiles=False —— 跨编到一个新架构时,该架构的 profile 从没被下过,
# gn gen 直接抛 `requested profile ... doesn't exist`(这正是 macOS 上 arm64→x64
# 跨编踩到的坑)。这里在 automate 之前按目标架构幂等补下:已存在则秒退。
# 全量(--clean,src 尚不存在)时不介入,交给 --with-pgo-profiles。
ensure_pgo_profile() {
  [[ "$VARIANT" == "prod" ]] || return 0
  local src="$CEFBUILD/chromium_git/chromium/src"
  [[ -d "$src" ]] || return 0   # 全量:src 还没 checkout,走 --with-pgo-profiles

  # 平台+架构 → update_pgo_profiles.py 的 --target 名(与 chrome/build/*.pgo.txt 对应)。
  local pgo_target
  if is_macos; then
    [[ "$TARGET_ARCH" == "x86_64" ]] && pgo_target="mac" || pgo_target="mac-arm"
  elif is_linux; then
    pgo_target="linux"
  else
    pgo_target="win64"   # 本仓库 Windows 恒 x64
  fi

  local state_file="$src/chrome/build/${pgo_target}.pgo.txt"
  if [[ ! -f "$state_file" ]]; then
    log "跳过 PGO 预取:未找到状态文件 $state_file(profile 名未知,交给 automate 处理)"
    return 0
  fi
  local profile_name profile_path
  profile_name="$(tr -d '[:space:]' < "$state_file")"
  profile_path="$src/chrome/build/pgo_profiles/$profile_name"
  if [[ -f "$profile_path" ]]; then
    log "PGO profile 已就位($pgo_target): $profile_name"
    return 0
  fi

  log "下载 PGO profile($pgo_target): $profile_name"
  # gs-url-base 与 chromium DEPS 里 'Fetch PGO profiles for mac' 一致。
  # PATH 已在 setup_env 前置 depot_tools(供 gsutil.py);此处 setup_env 已跑过。
  "$PYTHON_BIN" "$src/tools/update_pgo_profiles.py" \
    --target="$pgo_target" \
    update \
    --gs-url-base=chromium-optimization-profiles/pgo_profiles \
    || die "PGO profile 下载失败($pgo_target)。可手动重试或改用 dev variant(无 PGO)。"
  [[ -f "$profile_path" ]] || die "PGO profile 下载后仍缺失: $profile_path"
  log "PGO profile 下载完成 ✓"
}

# ---------------------------------------------------------------------------
# 8. 导出 cef-rs 期望的扁平 runtime 目录
# ---------------------------------------------------------------------------
export_cef_runtime() {
  local distrib="$1"
  local export_dir="$CEF_EXPORT_ROOT/cef-${VARIANT}${CEF_EXPORT_SUFFIX}"
  local tmp_dir="${export_dir}.tmp"

  if is_macos; then
    local build_dir="$CEFBUILD/chromium_git/chromium/src/out/$CEF_GN_OUT"
    local framework_dir="$build_dir/$CEF_RUNTIME_LIB"
    [[ -d "$framework_dir" ]] || die "CEF build 缺少 framework: $framework_dir"
  else
    [[ -d "$distrib/Release" ]] || die "CEF distrib 缺少 Release/: $distrib"
    [[ -d "$distrib/Resources" ]] || die "CEF distrib 缺少 Resources/: $distrib"
  fi

  log "导出 cef-rs runtime: $export_dir"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"

  # download-cef/cef-dll-sys 会把官方 distrib 展平成这个结构:
  # Linux/Windows: Release/* 和 Resources/* 位于 CEF_PATH 根层,libcef.so/libcef.dll 也必须在根层。
  # macOS: framework 在 GN build output 根层,headers/cmake/libcef_dll 仍来自 distrib。
  if is_macos; then
    cp -a "$framework_dir" "$tmp_dir/"
  else
    cp -a "$distrib/Release/." "$tmp_dir/"
    cp -a "$distrib/Resources/." "$tmp_dir/"
  fi

  local item
  for item in CMakeLists.txt cmake include libcef_dll CREDITS.html; do
    [[ -e "$distrib/$item" ]] || die "CEF distrib 缺少 $item: $distrib"
    cp -a "$distrib/$item" "$tmp_dir/"
  done

  cat > "$tmp_dir/archive.json" <<EOF
{
  "type": "minimal",
  "name": "cef_binary_${CEF_RS_ARCHIVE_VERSION}+${CEF_ARCHIVE_PLATFORM}_${VARIANT}_minimal",
  "sha1": "0000000000000000000000000000000000000000"
}
EOF

  if is_macos; then
    [[ -d "$tmp_dir/$CEF_RUNTIME_LIB" ]] || die "导出失败: $tmp_dir/$CEF_RUNTIME_LIB 不存在"
  else
    [[ -f "$tmp_dir/$CEF_RUNTIME_LIB" ]] || die "导出失败: $tmp_dir/$CEF_RUNTIME_LIB 不存在"
    [[ -d "$tmp_dir/locales" ]] || die "导出失败: $tmp_dir/locales 不存在"
  fi

  rm -rf "$export_dir"
  mv "$tmp_dir" "$export_dir"

  log "runtime 导出完成 ✓"
  log "接入:export CEF_PATH=\"$export_dir\"   然后正常 bun dev -c kabegame"
  if is_windows; then
    log "Windows PowerShell 接入:\$env:CEF_PATH=\"$(host_path "$export_dir")\""
  fi
}

# ---------------------------------------------------------------------------
# 9. 跑 automate-git.py
# ---------------------------------------------------------------------------
run_build() {
  local logfile="$CEFBUILD/build-${VARIANT}.log"
  log "开始编译,日志: $logfile"
  log "建议在 tmux/screen 里跑;prod 的 LTO 链接很吃内存,OOM 就在 ~/e 挂 swap。"

  local HISTORY_FLAGS=()
  if [[ "$NO_HISTORY" == 1 ]]; then
    HISTORY_FLAGS=(--no-chromium-history)
    log "浅 checkout:仅拉当前分支 tip,不下完整 git 历史"
    if [[ "$CLEAN" != 1 && ! -d "$CEFBUILD/chromium_git/chromium/src" ]]; then
      : # 首次全新目录,automate 自会全新浅 checkout
    elif [[ "$CLEAN" != 1 ]]; then
      log "提示:若已有全量残包,切浅 checkout 可能报 'checkout is incorrect',需带 --clean 重来"
    fi
  fi

  local automate_py="$CEFBUILD/automate/automate-git.py"
  local download_dir="$CEFBUILD/chromium_git"
  local depot_tools_dir="$CEFBUILD/depot_tools"
  local ARCH_FLAG="$CEF_ARCH_FLAG"

  # --build-target=cefsimple:默认目标 cefclient 在 Linux 无条件 include <gtk/gtk.h>,
  # 而 sysroot 里没有 GTK 头(CEF BUILD.gn 自己注释了这一点),use_sysroot=true 下编不过。
  # cefsimple 无 GTK 依赖,同样把 libcef 全量拉着编;Windows 下也能避开 cefclient 的额外 UI 目标。
  "$PYTHON_BIN" "$(host_path "$automate_py")" \
    --download-dir="$(host_path "$download_dir")" \
    --depot-tools-dir="$(host_path "$depot_tools_dir")" \
    --branch="$CEF_BRANCH" \
    --url="$CEF_SOURCE_URL" \
    --checkout="$CEF_SOURCE_COMMIT" \
    "$ARCH_FLAG" \
    --no-debug-build \
    --build-target=cefsimple \
    ${HISTORY_FLAGS[@]+"${HISTORY_FLAGS[@]}"} \
    ${PGO_FLAGS[@]+"${PGO_FLAGS[@]}"} \
    ${DISTRIB_FLAGS[@]+"${DISTRIB_FLAGS[@]}"} \
    ${UPDATE_FLAGS[@]+"${UPDATE_FLAGS[@]}"} \
    2>&1 | tee "$logfile"

  local out
  # 实际产物目录名格式:cef_binary_<ver>_<platform>_<variant>_minimal
  out=$(ls -d "$CEFBUILD"/chromium_git/chromium/src/cef/binary_distrib/cef_binary_*_"${CEF_ARCHIVE_PLATFORM}"_"${VARIANT}"_minimal 2>/dev/null | tail -1 || true)
  if [[ -n "$out" ]]; then
    log "完成 ✓ 产物目录:"
    log "  $out"
    export_cef_runtime "$out"
  else
    die "未找到产物目录,检查日志: $logfile"
  fi
}

# ---------------------------------------------------------------------------
main() {
  ensure_build_dir
  check_build_dir
  prepare_cef_reference
  setup_env
  bootstrap
  configure_variant
  configure_update
  ensure_pgo_profile
  run_build
}
main
