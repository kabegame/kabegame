#!/usr/bin/env bash
# scripts/build-deno.sh — 从源码自编 deno CLI（third/deno，denoland/deno pin v2.9.0）。
#
# 产物与 tauri-cli fork 同款管理：编到统一 target（默认 <root>/target，尊重
# CARGO_TARGET_DIR，如 VM 的 target-22），二进制为 <target>/release/deno。
# 日常增量刷新由 DenoCliPlugin 在 dev/build 前自动完成；本脚本是「第一次没有任何
# deno 时」的 bootstrap 入口（纯 bash，只依赖 rustup/cargo，避免鸡生蛋），也可手动重建。
#
# 注意：
#   - rust 工具链由 third/deno/rust-toolchain.toml 固定（1.95.0），rustup 自动安装。
#   - deno 官方 release profile 为 lto=true + codegen-units=1 + opt-level='z'，
#     链接期需 8-16GB 内存。默认用 thin-LTO 降级档（与 DenoCliPlugin 默认一致，
#     避免 profile 不一致触发全量重编）；KB_DENO_OFFICIAL=1 切回官方档。
#   - v8（149.4.0）走预编译静态库下载；网络受限时可设 RUSTY_V8_ARCHIVE=/path/to/
#     librusty_v8_*.a 或 RUSTY_V8_MIRROR=<url>（本脚本原样透传给 cargo）。
#   - 树内 deno_core 的 kabegame patch series（third-patches/deno）若已应用，编出的
#     CLI 会带上这些补丁——这正是自编通道的目的。`embed_ext_sources` feature 不会被
#     CLI 构建启用（仅 kabegame-core 依赖声明开启），CLI 行为与上游一致。
#   - Windows 下不能覆盖正在运行的 deno.exe：改动 third/deno 后请用官方 deno 或
#     另一份拷贝运行本脚本。

source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

require_cmd git
require_cmd rustup "https://rustup.rs"

SUB="$ROOT/third/deno"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
case "$TARGET_DIR" in
  /*) ;;
  *) TARGET_DIR="$ROOT/$TARGET_DIR" ;;
esac

[[ -f "$SUB/cli/Cargo.toml" ]] || die "缺少子模块 third/deno：先 git submodule update --init third/deno"

# 与 DenoCliPlugin 保持完全一致的编译环境(cargo 指纹一致才能增量复用)
export RUSTFLAGS="-Awarnings"

if [[ "${KB_DENO_OFFICIAL:-0}" == "1" ]]; then
  log "KB_DENO_OFFICIAL=1：使用 deno 官方 release profile（fat LTO，链接需 8-16GB 内存）"
else
  export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-thin}"
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-16}"
  export CARGO_PROFILE_RELEASE_OPT_LEVEL="${CARGO_PROFILE_RELEASE_OPT_LEVEL:-2}"
  log "release profile 降级档: lto=$CARGO_PROFILE_RELEASE_LTO codegen-units=$CARGO_PROFILE_RELEASE_CODEGEN_UNITS opt-level=$CARGO_PROFILE_RELEASE_OPT_LEVEL"
fi

log "building deno ($(git -C "$SUB" log -1 --format=%h 2>/dev/null || echo '?')) → $TARGET_DIR/release/deno"
cargo build --release --locked \
  --manifest-path "$SUB/cli/Cargo.toml" \
  --target-dir "$TARGET_DIR" \
  "$@"

BIN="$TARGET_DIR/release/deno"
[[ -x "$BIN" ]] || die "构建完成但未找到产物: $BIN"
log "done: $("$BIN" --version | head -1) → ${BIN#"$ROOT"/}"
