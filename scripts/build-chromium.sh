#!/usr/bin/env bash
#
# 编译带专利编码(H.264/AAC/MP4)的 CEF(Chromium Embedded Framework),Linux x64。
# 官方 Spotify 预编译版用 ffmpeg_branding=Chromium,不含 H.264/AAC;这里用
# proprietary_codecs=true + ffmpeg_branding=Chrome 自己编一份,供 tauri-runtime-cef 使用。
#
# 用法:
#   scripts/build-chromium.sh dev            # 快速开发版(关 LTO),已有 checkout 则增量重编
#   scripts/build-chromium.sh prod           # 最小体积发布版(开 LTO + optimize_for_size)
#   scripts/build-chromium.sh dev  --clean   # 强制全量重新 checkout + 编译(首次/想推倒重来)
#   scripts/build-chromium.sh prod --clean
#
# 关键前提:Chromium/CEF 的源码树重度依赖符号链接 + POSIX 权限 + 大小写敏感,
# exFAT/NTFS 都不行。本机 ~/e 是 exFAT,所以把构建空间放进一个 ext4 镜像里 loop 挂载:
#   镜像:   ~/e/cef-build.img   (ext4,实际数据落在 ~/e 大盘)
#   挂载点: ~/cefbuild          (空目录,在 /home 上,不占空间)
# 本脚本会在需要时自动创建镜像并挂载(挂载需要 sudo)。
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 可调参数
# ---------------------------------------------------------------------------
CEF_BRANCH=7827                     # 对应 CEF 149.0.x / Chromium 149.0.7827.x(与 cef-rs "149" 对齐)
IMG="$HOME/e/cef-build.img"         # ext4 镜像文件(放 exFAT 大盘)
IMG_SIZE=200G                       # 镜像大小(prod LTO 峰值占用不小,别低于 150G)
CEFBUILD="$HOME/cefbuild"           # 挂载点 = 构建根目录

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

log() { printf '\033[1;36m[build-chromium]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-chromium] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 确保 ext4 镜像已挂载(没有则创建,未挂则挂载)
# ---------------------------------------------------------------------------
ensure_mount() {
  if mountpoint -q "$CEFBUILD"; then
    log "构建空间已挂载: $CEFBUILD"
    return
  fi
  if [[ ! -f "$IMG" ]]; then
    log "镜像不存在,创建 $IMG ($IMG_SIZE, ext4)..."
    truncate -s "$IMG_SIZE" "$IMG"
    mkfs.ext4 -q "$IMG"
  fi
  mkdir -p "$CEFBUILD"
  log "挂载 $IMG -> $CEFBUILD (需要 sudo)"
  sudo mount -o loop "$IMG" "$CEFBUILD"
  sudo chown "$USER:$USER" "$CEFBUILD"
}

# ---------------------------------------------------------------------------
# 2. 验证构建空间支持符号链接(exFAT 会在这里挡下,正是之前报错的根因)
# ---------------------------------------------------------------------------
check_symlink() {
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
  mkdir -p "$CEFBUILD"/{tmp,cache,depot_tools,automate}
  export TMPDIR="$CEFBUILD/tmp"          # 别用 16G 的 /tmp tmpfs
  export XDG_CACHE_HOME="$CEFBUILD/cache" # vpython/gsutil 缓存别写满 /home
  export PATH="$CEFBUILD/depot_tools:$PATH"
  export CEF_USE_GN=1
  export GN_ARGUMENTS="--ide=none"
  export DEPOT_TOOLS_UPDATE=1
}

# ---------------------------------------------------------------------------
# 4. 引导 depot_tools + automate-git.py
# ---------------------------------------------------------------------------
bootstrap() {
  if [[ ! -x "$CEFBUILD/depot_tools/gclient" ]]; then
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
  local common="proprietary_codecs=true ffmpeg_branding=Chrome use_sysroot=true enable_nacl=false"
  if [[ "$VARIANT" == "dev" ]]; then
    # 快:关 LTO、不要符号、跳过 WebUI 优化(不需要 chrome:// 内置页面)
    export GN_DEFINES="$common is_official_build=false symbol_level=0 blink_symbol_level=0 dcheck_always_on=false optimize_webui=false"
    DISTRIB_FLAGS=(--minimal-distrib-only --no-distrib-docs --no-distrib-symbols --distrib-subdir-suffix=dev)
  else
    # 小:开 LTO + 体积优化,保留可符号化崩溃栈,去掉 DRM
    export GN_DEFINES="$common is_official_build=true optimize_for_size=true enable_widevine=false use_cups=false symbol_level=1"
    DISTRIB_FLAGS=(--minimal-distrib-only --no-distrib-docs --distrib-subdir-suffix=prod)
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
# 7. 跑 automate-git.py
# ---------------------------------------------------------------------------
run_build() {
  local logfile="$CEFBUILD/build-${VARIANT}.log"
  log "开始编译,日志: $logfile"
  log "建议在 tmux/screen 里跑;prod 的 LTO 链接很吃内存,OOM 就在 ~/e 挂 swap。"
  python3 "$CEFBUILD/automate/automate-git.py" \
    --download-dir="$CEFBUILD/chromium_git" \
    --depot-tools-dir="$CEFBUILD/depot_tools" \
    --branch="$CEF_BRANCH" \
    --x64-build \
    --no-debug-build \
    "${DISTRIB_FLAGS[@]}" \
    "${UPDATE_FLAGS[@]}" \
    2>&1 | tee "$logfile"

  local out
  out=$(ls -d "$CEFBUILD"/chromium_git/chromium/src/cef/binary_distrib/cef_binary_*_minimal_"$VARIANT" 2>/dev/null | tail -1 || true)
  if [[ -n "$out" ]]; then
    log "完成 ✓ 产物目录:"
    log "  $out"
    log "接入:export CEF_PATH=\"$out\"   然后正常 bun dev -c kabegame"
  else
    die "未找到产物目录,检查日志: $logfile"
  fi
}

# ---------------------------------------------------------------------------
main() {
  ensure_mount
  check_symlink
  setup_env
  bootstrap
  configure_variant
  configure_update
  run_build
}
main
