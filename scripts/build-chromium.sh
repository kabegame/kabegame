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
#
# 默认路径:
#   Linux:       构建根目录 ~/i/cefbuild, runtime ~/i/cef-dev 或 ~/i/cef-prod
#   Windows/MSYS:构建根目录 H:\cefbuild, runtime H:\cef-dev 或 H:\cef-prod
#   macOS arm64: 构建根目录 /Volumes/KIOXIA/cefbuild, runtime /Volumes/KIOXIA/cef-dev 或 cef-prod
#
# Linux 关键前提:Chromium/CEF 的源码树重度依赖符号链接 + POSIX 权限 + 大小写敏感,
# exFAT/NTFS 都不行。本机已把构建空间放到 POSIX 文件系统下的 ~/i。
#
# Windows 关键前提:在 MSYS2 bash 中运行,建议从 VS x64 Native Tools 环境启动
# msys2_shell.cmd -mingw64/-msys -use-full-path,并把 H:\cefbuild 放在 NTFS 盘。
#
# macOS 关键前提:Apple Silicon + 完整 Xcode/macOS SDK;构建空间必须是 APFS/HFS+
# 等支持符号链接的文件系统,不能是 exFAT。
#
set -euo pipefail

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
    CEF_ARCHIVE_PLATFORM="macosarm64"
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
for a in "${@:2}"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done
case "$VARIANT" in
  dev|prod) ;;
  *) echo "用法: $0 [dev|prod] [--clean]" >&2; exit 2 ;;
esac

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
# 3. 环境变量
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
# 4. 引导 depot_tools + automate-git.py
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
# 5. 按 variant 设置 GN_DEFINES + distrib 参数
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
# 6. 决定全量 checkout 还是增量重编
# ---------------------------------------------------------------------------
configure_update() {
  local src="$CEFBUILD/chromium_git/chromium/src"
  if [[ "$CLEAN" == 1 || ! -d "$src" ]]; then
    [[ "$CLEAN" == 1 ]] && log "强制全量 checkout (--clean)" || log "首次:全量 checkout(会拉取数十 G,耗时较长)"
    UPDATE_FLAGS=(--force-clean)
  else
    log "增量:复用已有 checkout,仅重编 + 重新打包"
    UPDATE_FLAGS=(--no-update --force-build --force-distrib)
  fi
}

# ---------------------------------------------------------------------------
# 7. 导出 cef-rs 期望的扁平 runtime 目录
# ---------------------------------------------------------------------------
export_cef_runtime() {
  local distrib="$1"
  local export_dir="$CEF_EXPORT_ROOT/cef-${VARIANT}"
  local tmp_dir="${export_dir}.tmp"

  if is_macos; then
    local build_dir="$CEFBUILD/chromium_git/chromium/src/out/Release_GN_arm64"
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
# 8. 跑 automate-git.py
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
  local ARCH_FLAG="--x64-build"
  is_macos && ARCH_FLAG="--arm64-build"

  # --build-target=cefsimple:默认目标 cefclient 在 Linux 无条件 include <gtk/gtk.h>,
  # 而 sysroot 里没有 GTK 头(CEF BUILD.gn 自己注释了这一点),use_sysroot=true 下编不过。
  # cefsimple 无 GTK 依赖,同样把 libcef 全量拉着编;Windows 下也能避开 cefclient 的额外 UI 目标。
  "$PYTHON_BIN" "$(host_path "$automate_py")" \
    --download-dir="$(host_path "$download_dir")" \
    --depot-tools-dir="$(host_path "$depot_tools_dir")" \
    --branch="$CEF_BRANCH" \
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
  setup_env
  bootstrap
  configure_variant
  configure_update
  run_build
}
main
