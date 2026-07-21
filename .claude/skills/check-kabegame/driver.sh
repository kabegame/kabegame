#!/usr/bin/env bash
# Kabegame 校验驱动 —— 包装 `deno task check -c <component>`。
#
# 用法（在仓库任意位置运行，脚本会自行定位仓库根）：
#   .claude/skills/check-kabegame/driver.sh                  # 全量：vue-tsc + cargo check
#   .claude/skills/check-kabegame/driver.sh --skip vue       # 只查 Rust
#   .claude/skills/check-kabegame/driver.sh --skip cargo     # 只查前端类型
#   .claude/skills/check-kabegame/driver.sh --mode android --skip vue
#   .claude/skills/check-kabegame/driver.sh -c kabegame-cli
#
# 未显式给 -c/--component 时默认 `-c kabegame`。其余参数原样透传给 deno task check。
# 完整日志落在 .kabegame/debug/check/check-<时间戳>.log（该目录已 gitignore）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1

LOG_DIR="$ROOT/.kabegame/debug/check"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/check-$(date +%Y%m%d-%H%M%S).log"

# --- 预检：运行中的 app 会锁住 target/，cef-dll-sys 的 build script 复制 CEF 运行时时
#     会以 "os error 32"（Windows）/ "Text file busy"（*nix）失败。先提醒。
if pgrep -x kabegame >/dev/null 2>&1 || pgrep -f 'kabegame\.exe' >/dev/null 2>&1; then
  echo "[check] 警告：检测到正在运行的 kabegame 进程。" >&2
  echo "[check]       cargo check 可能因 target/ 被占用而失败（os error 32 / Text file busy）。" >&2
  echo "[check]       建议先退出 app，或改用 --skip cargo 只查前端。" >&2
fi

# --- 组装参数：没给 -c/--component 就补默认组件
ARGS=("$@")
HAS_COMPONENT=0
for a in "${ARGS[@]:-}"; do
  case "$a" in
    -c|--component|-c=*|--component=*) HAS_COMPONENT=1 ;;
  esac
done
if [ "$HAS_COMPONENT" -eq 0 ]; then
  ARGS=(-c kabegame "${ARGS[@]:-}")
fi

echo "[check] 运行: deno task check ${ARGS[*]}"
echo "[check] 日志: $LOG"
START=$(date +%s)

deno task check "${ARGS[@]}" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

ELAPSED=$(( $(date +%s) - START ))

# --- 汇总。vue-tsc 输出 "error TSxxxx"，cargo 输出行首的 "error[E0xxx]:" / "error:"。
#     注意 tee 下来的日志带 ANSI 颜色码，grep 前先剥掉。
PLAIN="$(sed $'s/\033\\[[0-9;]*m//g' "$LOG")"
TS_ERRORS=$(printf '%s\n' "$PLAIN" | grep -c 'error TS[0-9]' || true)
# 排除 cargo 的收尾行（"could not compile ..." / "aborting due to ..."），它们是汇总不是新错误。
RS_ERRORS=$(printf '%s\n' "$PLAIN" \
  | grep -E '^error(\[E[0-9]+\])?:' \
  | grep -cvE '^error: (could not compile|aborting due to)' || true)

echo
echo "======== check 汇总 ========"
echo "耗时      : ${ELAPSED}s"
echo "退出码    : $STATUS"
echo "vue-tsc   : $TS_ERRORS 个 error"
echo "cargo     : $RS_ERRORS 个 error"

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "-------- 错误摘要 --------"
  printf '%s\n' "$PLAIN" | grep -nE 'error TS[0-9]|^error(\[E[0-9]+\])?:' | head -40
  echo
  echo "（完整上下文见 ${LOG} ）"
else
  echo "结果      : 通过 ✅（warning 不影响退出码）"
fi
echo "==========================="

exit "$STATUS"
