#!/usr/bin/env bash
# 交叉编译 aarch64-linux-android 的 librusty_v8.a，产出 Android V8 后端所需的自建产物：
#   bin/android/librusty_v8_simdutf_release_aarch64-linux-android.a      (静态库)
#   bin/android/src_binding_simdutf_release_aarch64-linux-android.rs      (FFI binding)
# 二者经 mode-plugin 的 RUSTY_V8_ARCHIVE / RUSTY_V8_SRC_BINDING_PATH 注入 android 构建。
# 产物 gitignore、不入库，由本命令复现（对标 build-ffmpeg.sh 的 --target android）。
#
# 构建树 = `third/rusty_v8` 子模块本身（denoland/rusty_v8，pin v149.4.0 = Cargo.lock 的 v8）。它是
# 一棵「就地复用」的完整树：nested submodules（v8 / build / third_party/*）与已编译的 target/ 都在其中，
# 所以复用构建（增量、不重新拉取、不从零重编）。补丁全部是 third-patches/rusty_v8/ 顶层 *.patch，均由
# `git -C third/rusty_v8 apply` 应用（0002 路径带 `build/` 前缀，git apply 会跨进嵌套 build 子模块）：
#   third-patches/rusty_v8/0001-ninja-jobserver-fd.patch    → build.rs（ninja jobserver 修复）
#   third-patches/rusty_v8/0002-android-ndk-build-gn.patch  → build/config/android/BUILD.gn（NDK 字面量）
# 本脚本幂等应用它们（已应用则跳过）。`bun run patch rusty_v8` 因胖树常驻脏态会被 patch-manager 跳过。
# 另有 3 处非 diff 的 fixup（simdutf checkout / host sysroot / android_toolchain ndk symlink）只在「首次
# 拉取 nested submodules」时做；复用树里已就绪。见 third-patches/rusty_v8/README.md 与
# cocs/crawler/V8_RUNTIME.md。
#
# 仅 Linux 宿主（NDK 工具链按 linux-x86_64）。首次拉取 nested submodules + NDK 需 ≥15 GB 磁盘、可联网。
# 另需 clang 19+ 的 libclang（build.rs 在 V8_FROM_SOURCE 下总跑 bindgen）——脚本自动探测 llvm-19。
#
# 环境变量：
#   GN / NINJA   指向「真 chromium 树」的 gn / ninja（非 depot_tools 包装脚本）。默认复用本机 cefbuild
#                里 chromium 自带的 gn/ninja；按需覆盖。
#   LIBCLANG_PATH   clang 19+ 的 libclang 目录（bindgen 用）。未设则自动探测 llvm-19
#                （llvm-config-19 --libdir 或 /usr/lib/llvm-19/lib）。
#   BINDGEN_EXTRA_CLANG_ARGS   透传给 bindgen 的 clang 参数。脚本自动前置 NDK Bionic aarch64
#                `--sysroot=...`（与 bindgen 的 --target=aarch64-linux-android 相符），已设则保留并前置。
#   RUSTY_V8_BINDING_SRC   显式指定 src_binding 源文件；默认用 build.rs 刚生成的 gn_out/src_binding.rs，
#                缺失才回退 cargo registry 里 v8 包预置的 aarch64 binding（64 位目标逐字节一致）。

source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

require_linux "build-v8.sh"
require_cmd git
require_cmd cargo "rustup"
require_cmd python3

# 所有参数原样透传给下面的 `cargo build`（如 -vv 看 gn/ninja/rustc 详细日志、--offline、-j N 等）。
CARGO_ARGS=("$@")

readonly SUB="$ROOT/third/rusty_v8"
readonly PATCH_DIR="$ROOT/third-patches/rusty_v8"
readonly TARGET="aarch64-linux-android"
readonly OUT_DIR="$ROOT/bin/android"
readonly ARCHIVE_OUT="$OUT_DIR/librusty_v8_simdutf_release_${TARGET}.a"
readonly BINDING_OUT="$OUT_DIR/src_binding_simdutf_release_${TARGET}.rs"

GN="${GN:-/home/cm/i/cefbuild/chromium_git/chromium/src/buildtools/linux64/gn}"
NINJA="${NINJA:-/home/cm/i/cefbuild/chromium_git/chromium/src/third_party/ninja/ninja}"

[[ -d "$SUB" ]]   || die "缺少子模块 third/rusty_v8：先 git submodule update --init third/rusty_v8"
[[ -x "$GN" ]]    || die "gn 不可执行：$GN — 设 GN=/path/to/gn（chromium 树的真 gn，非 depot_tools 包装脚本）"
[[ -x "$NINJA" ]] || die "ninja 不可执行：$NINJA — 设 NINJA=/path/to/ninja"

V8_VERSION="$(grep -m1 '^version' "$SUB/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')"
log "rusty_v8 (v8 crate) $V8_VERSION @ $(git -C "$SUB" describe --tags 2>/dev/null || echo detached)"

# 幂等应用一个 patch 到某个 git 仓：已应用(reverse-check 通过)→跳过；未应用但可应用→应用；否则报漂移。
apply_patch() {  # $1=repo dir  $2=patch file(abs)
  local repo="$1" patch="$2" name; name="$(basename "$patch")"
  if git -C "$repo" apply --reverse --check "$patch" 2>/dev/null; then
    log "  already applied: $name → ${repo#"$ROOT"/}"
  elif git -C "$repo" apply --check "$patch" 2>/dev/null; then
    git -C "$repo" apply "$patch"
    log "  applied:         $name → ${repo#"$ROOT"/}"
  else
    die "patch 既不能应用也未应用：$patch（→ $repo）。上游漂移？请核对并重生成。"
  fi
}

# 1) nested submodules 是否就绪（复用树里已在）。缺则首次拉取 + 做 3 处非 diff fixup。
if [[ -e "$SUB/build/config/android/BUILD.gn" && -e "$SUB/v8/BUILD.gn" ]]; then
  log "nested build tree present — reusing (skip fetch + one-time fixups)"
else
  log "fetching nested submodules (v8 / build / third_party — heavy, needs network) …"
  git -C "$SUB" submodule update --init --recursive
  # simdutf 子模块工作区可能只剩 gitlink，恢复文件。
  git -C "$SUB/third_party/simdutf" checkout -f HEAD
  # host sysroot（gn 生成时需要 amd64 sysroot；install-sysroot 已装则跳过）。
  python3 "$SUB/build/linux/sysroot_scripts/install-sysroot.py" --arch=amd64
  # gn 期望 third_party/android_toolchain/ndk，build.rs 却把 NDK 下到 third_party/android_ndk。
  mkdir -p "$SUB/third_party/android_toolchain"
  ln -sfn ../android_ndk "$SUB/third_party/android_toolchain/ndk"
fi

# 2) 幂等应用 kabegame 补丁：crate/*（→ third/rusty_v8）+ nested/<sub>/*（→ 对应 nested submodule）。
#    复用树里已打好，这里都是 no-op；fresh 树则实际应用。
log "ensuring kabegame patches …"
# 全部顶层 *.patch 都打到 third/rusty_v8；0002 的路径带 build/ 前缀，git apply 会跨进嵌套 build 子模块。
while IFS= read -r p; do
  apply_patch "$SUB" "$p"
done < <(find "$PATCH_DIR" -maxdepth 1 -name '*.patch' | sort)

# 3) bindgen 需要 clang 19+ 的 libclang——build.rs 在 V8_FROM_SOURCE 下总会跑 bindgen 生成 binding
#    （无法跳过）。未显式设 LIBCLANG_PATH 则自动探测 llvm-19（clang-sys 在其中找 libclang-19.so.*）。
if [[ -z "${LIBCLANG_PATH:-}" ]]; then
  for d in "$(llvm-config-19 --libdir 2>/dev/null || true)" /usr/lib/llvm-19/lib; do
    if [[ -n "$d" ]] && compgen -G "$d/libclang*.so*" >/dev/null 2>&1; then
      export LIBCLANG_PATH="$d"; break
    fi
  done
fi
if [[ -n "${LIBCLANG_PATH:-}" ]]; then
  log "LIBCLANG_PATH=$LIBCLANG_PATH"
else
  warn "未探测到 clang 19+ libclang(设 LIBCLANG_PATH 或 apt install llvm-19)；bindgen 会失败。"
fi

# bindgen 继承 cargo TARGET，以 --target=aarch64-linux-android 解析头文件；但 build.rs 只在 target_os
# 为 linux/macos 时补 sysroot、android 分支不补（见 build.rs），于是 clang 拿**宿主 glibc 头**去解析
# aarch64 目标——宿主 x86_64 头里的 `#ifdef __x86_64__` 在 aarch64 目标下不成立，`bits/wordsize.h` 误判
# `__WORDSIZE=32` 进而拉 `gnu/stubs-32.h`……一路错位。正解是给它 NDK 的 Bionic aarch64 sysroot（与 --target
# 相符，无这些 glibc/x86 arch 分支）。binding 对 64 位目标架构无关，Bionic 头解析出的产物同样通用。
# 注：sysroot 里的 NDK 由 build.rs 首次构建时下载，复用树里已就绪；全新 re-vendor 的首跑可能尚无，需再跑一次。
NDK_SYSROOT="$(ls -d "$SUB"/third_party/android_ndk/toolchains/llvm/prebuilt/*/sysroot 2>/dev/null | head -1 || true)"
if [[ -n "$NDK_SYSROOT" && -d "$NDK_SYSROOT" ]]; then
  export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$NDK_SYSROOT ${BINDGEN_EXTRA_CLANG_ARGS:-}"
  log "BINDGEN_EXTRA_CLANG_ARGS += --sysroot=$NDK_SYSROOT"
else
  warn "未找到 NDK Bionic sysroot(third_party/android_ndk/.../sysroot)；若 bindgen 因宿主头错位失败，待 NDK 下载后再跑一次 build:v8。"
fi

# 4) 构建（复用 target/，增量；若已最新近似 no-op）。--features simdutf 必须（deno_core 0.405 开了
#    v8 的 simdutf feature）；jobserver fd 修复由 crate 补丁提供。
log "building librusty_v8.a for $TARGET (incremental; from-source first run ~15GB) …"
GN="$GN" NINJA="$NINJA" V8_FROM_SOURCE=1 \
  cargo build --release --manifest-path "$SUB/Cargo.toml" --target "$TARGET" --features simdutf \
  "${CARGO_ARGS[@]}"

ARCHIVE_IN="$SUB/target/$TARGET/release/gn_out/obj/librusty_v8.a"
[[ -f "$ARCHIVE_IN" ]] || die "构建未产出 $ARCHIVE_IN"

# 5) 拷到 bin/android/。直接放 .a（RUSTY_V8_ARCHIVE 接非 gzip 的 .a，copy_archive 原样拷贝；bin/android
#    已 gitignore，不入库，无需 gzip 压缩）。
mkdir -p "$OUT_DIR"
cp "$ARCHIVE_IN" "$ARCHIVE_OUT"
log "wrote $(du -h "$ARCHIVE_OUT" | cut -f1)  ${ARCHIVE_OUT#"$ROOT"/}"

# 6) src_binding：V8_FROM_SOURCE 下 build.rs 已用 clang19 跑 bindgen 生成 binding（对 64 位目标架构
#    无关，aarch64 与 x86_64 逐字节相同）。优先用刚生成的 gn_out/src_binding.rs；缺失则回退 v8 crate
#    registry 预置版或 RUSTY_V8_BINDING_SRC。
BINDING_SRC="${RUSTY_V8_BINDING_SRC:-}"
if [[ -z "$BINDING_SRC" ]]; then
  GEN_BINDING="$SUB/target/$TARGET/release/gn_out/src_binding.rs"
  if [[ -f "$GEN_BINDING" ]]; then
    BINDING_SRC="$GEN_BINDING"
  else
    BINDING_SRC="$(ls "$HOME"/.cargo/registry/src/*/v8-"$V8_VERSION"/gen/src_binding_simdutf_release_aarch64-unknown-linux-gnu.rs 2>/dev/null | head -1 || true)"
  fi
fi
[[ -n "$BINDING_SRC" && -f "$BINDING_SRC" ]] || die \
  "找不到 src_binding 源。设 RUSTY_V8_BINDING_SRC=<file>，或确认 bindgen 已生成 gn_out/src_binding.rs（需 LIBCLANG_PATH 指向 clang19）。"
cp "$BINDING_SRC" "$BINDING_OUT"
log "wrote ${BINDING_OUT#"$ROOT"/}  (from ${BINDING_SRC#"$ROOT"/})"

log "done. Android build picks these up via mode-plugin (RUSTY_V8_ARCHIVE / RUSTY_V8_SRC_BINDING_PATH)."
