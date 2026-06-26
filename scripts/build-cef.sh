#!/usr/bin/env bash
# 导出 CEF 预编译运行时(release/minimal)到 CEF_PATH(默认 ~/.local/share/cef),
# 供构建期 os-plugin 的 collectLinuxCefLibs() 收集进 Linux .deb。
#
# - 幂等:目标目录已有 libcef.so + icudtl.dat 则跳过。
# - 版本须与 src-tauri/tauri-runtime-cef/Cargo.toml 的 `cef` 主版本一致(当前 149)。
# - 不自行编译 Chromium —— export-cef-dir 拉官方预编译包。
set -euo pipefail

CEF_VERSION_MAJOR="149"
DEST="${CEF_PATH:-$HOME/.local/share/cef}"

if [[ -f "$DEST/libcef.so" && -f "$DEST/icudtl.dat" ]]; then
  echo "✅ CEF runtime 已存在,跳过: $DEST"
  exit 0
fi

if ! command -v export-cef-dir >/dev/null 2>&1; then
  echo "未找到 export-cef-dir,安装中(CEF $CEF_VERSION_MAJOR)…"
  cargo install export-cef-dir --version "^${CEF_VERSION_MAJOR}.0.0"
fi

echo "导出 CEF runtime → $DEST"
export-cef-dir --force "$DEST"
echo "✅ CEF runtime 已导出: $DEST"
echo "   (构建会通过 CEF_PATH/默认路径收集 libcef.so、资源与 locales 白名单进包)"
