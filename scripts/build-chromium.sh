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

# 浅 checkout:只拉当前分支 tip,不下完整 git 历史(chromium/src 历史占大头,
# 全量单次 fetch ≈17G 过代理极易被掐断且不可续传)。牺牲 git 历史换"一次能下完"。
# 注意:
#   - 首次切成浅 checkout 时,已有的全量残包版本对不上,automate 会要求删掉重来,
#     所以切换那一次必须带 --clean(触发 --force-clean)。
#   - 将来升 CEF 大版本时浅仓库增量可能又炸成大包,届时可能要重下一次。
NO_HISTORY=1                        # 1=浅 checkout(--no-chromium-history);0=全量历史

# gclient DEPS 同步并发。gclient 默认 max(8, CPU 数)(本机 24),几十个并行 fetch
# 打同一个代理出口,googlesource 直接 429 限流,sync 断在半路(v8/skia 空目录的根因)。
# automate-git.py 没有透传参数,只能用 PATH shim 包一层 gclient 注入 --jobs。
GCLIENT_JOBS=4

# 编译并发上限(autoninja 的 NINJA_CORE_LIMIT)。默认 24 路并行 clang 编 Blink/V8
# bindings 单个可吃 1-2G+,31G 内存 + 小 swap 直接 OOM。16 路 ≈ 峰值 24-32G,
# 配合大 swap 可撑住;还 OOM 就继续调低。
NINJA_JOBS=16

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
  mkdir -p "$CEFBUILD"/{tmp,cache,depot_tools,automate,shim}
  export TMPDIR="$CEFBUILD/tmp"          # 别用 16G 的 /tmp tmpfs
  export XDG_CACHE_HOME="$CEFBUILD/cache" # vpython/gsutil 缓存别写满 /home
  # gclient shim:对 sync/revert 注入 --jobs,压低 DEPS 并发防 googlesource 429。
  # automate-git.py 通过 PATH 调 gclient,shim 排在 depot_tools 前即可拦截。
  cat > "$CEFBUILD/shim/gclient" <<EOF
#!/usr/bin/env bash
args=("\$@")
case "\${1:-}" in sync|revert) args+=(--jobs $GCLIENT_JOBS) ;; esac
exec "$CEFBUILD/depot_tools/gclient" "\${args[@]}"
EOF
  chmod +x "$CEFBUILD/shim/gclient"
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
  # 注意:CEF 7827 的 gn_args.py GetRequiredArgs() 硬性要求 optimize_webui=true、
  # enable_widevine=true(还有 //cef/BUILD.gn 的 assert 兜底),覆盖会直接 assertion,
  # 所以这两项不能出现在 GN_DEFINES 里。
  # enable_nacl 已随 NaCl 从 Chromium 149 移除,不要再设(设了报 has no effect)
  local common="proprietary_codecs=true ffmpeg_branding=Chrome use_sysroot=true"
  if [[ "$VARIANT" == "dev" ]]; then
    # 快:关 LTO、不要符号
    export GN_DEFINES="$common is_official_build=false symbol_level=0 blink_symbol_level=0 dcheck_always_on=false"
    DISTRIB_FLAGS=(--minimal-distrib-only --no-distrib-docs --no-distrib-symbols --distrib-subdir-suffix=dev)
  else
    # 小:开 LTO + 体积优化,保留可符号化崩溃栈
    export GN_DEFINES="$common is_official_build=true optimize_for_size=true use_cups=false symbol_level=1"
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

  python3 "$CEFBUILD/automate/automate-git.py" \
    --download-dir="$CEFBUILD/chromium_git" \
    --depot-tools-dir="$CEFBUILD/depot_tools" \
    --branch="$CEF_BRANCH" \
    --x64-build \
    --no-debug-build \
    "${HISTORY_FLAGS[@]}" \
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
