#!/usr/bin/env bash
set -euo pipefail

# 统计仓库源码行数的便捷脚本（bash 版）
#
# 用法：在仓库根目录执行
#   bash scripts/cloc.sh
#   ./scripts/cloc.sh            # 需要 chmod +x scripts/cloc.sh
#
# 参数（与 cloc.ps1 对齐）：
#   --path <路径>          要统计的目录，默认 "."
#   --exclude <列表>       逗号分隔的排除目录
#   --include-ext <列表>   逗号分隔的仅统计后缀（避免把 json 等算进来）
#
# 备注：优先使用已安装的 cloc；否则回退用 npx cloc（无需全局安装）。

PATH_ARG="."
EXCLUDE_ARG="node_modules,dist,build,.git,.turbo,.next,target,.nx,public,actions-runner,data,crawler-venv,wallpaper-example"
INCLUDE_EXT_ARG="ts,tsx,js,jsx,vue,rs,go,py,java,kt,swift,cs,cpp,c,h,cc,hpp,rb,php,html,css,scss,rhai"

usage() {
  cat <<'EOF'
用法:
  bash scripts/cloc.sh [--path <路径>] [--exclude <逗号分隔目录>] [--include-ext <逗号分隔后缀>]

示例:
  bash scripts/cloc.sh
  bash scripts/cloc.sh --path src-tauri
  bash scripts/cloc.sh --exclude "node_modules,dist,build,.git"
  bash scripts/cloc.sh --include-ext "rs,ts,tsx,vue"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -p|--path|--Path)
      [[ $# -ge 2 ]] || { echo "缺少参数值：$1" >&2; exit 2; }
      PATH_ARG="$2"
      shift 2
      ;;
    -e|--exclude|--Exclude)
      [[ $# -ge 2 ]] || { echo "缺少参数值：$1" >&2; exit 2; }
      EXCLUDE_ARG="$2"
      shift 2
      ;;
    --include-ext|--IncludeExt|--includeExt)
      [[ $# -ge 2 ]] || { echo "缺少参数值：$1" >&2; exit 2; }
      INCLUDE_EXT_ARG="$2"
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

EXCLUDE_OPT="--exclude-dir=${EXCLUDE_ARG}"
INCLUDE_OPT="--include-ext=${INCLUDE_EXT_ARG}"

if command -v cloc >/dev/null 2>&1; then
  cloc "$PATH_ARG" "$EXCLUDE_OPT" "$INCLUDE_OPT"
  exit 0
fi

if command -v npx >/dev/null 2>&1; then
  npx --yes cloc "$PATH_ARG" "$EXCLUDE_OPT" "$INCLUDE_OPT"
  exit 0
fi

echo "未找到 cloc，也未找到 npx。请安装 cloc 或 Node.js(npx) 后重试。" >&2
echo "  - cloc: https://github.com/AlDanial/cloc" >&2
echo "  - npx:  npm i -g npm (或安装 Node.js)" >&2
exit 127

