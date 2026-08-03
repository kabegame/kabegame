#!/usr/bin/env bash
# Kabegame 后端测试驱动 —— 包装 `deno task test -c <crate> -- <args...>`。
#
# 用法（在仓库任意位置运行，脚本会自行定位仓库根）：
#   .claude/skills/test-kabegame/driver.sh                                # cargo test -p kabegame-core（全量，慢且有既有失败，慎用）
#   .claude/skills/test-kabegame/driver.sh kabegame-core --lib kgpg       # core 的 lib 单测，按名过滤
#   .claude/skills/test-kabegame/driver.sh kabegame-core --test dsl_e2e   # core 的集成测试 target
#   .claude/skills/test-kabegame/driver.sh kabegame-cli                   # cli crate 的测试
#   .claude/skills/test-kabegame/driver.sh kabegame --lib rotator         # 主 app crate（会链 CEF，编译最重）
#
# 第一个参数若是 kabegame|kabegame-cli|kabegame-core 则作为 -c 组件，否则默认
# kabegame-core。**其余参数不用自己写 `--`**——driver 统一加上 `--` 原样传给
# cargo test（可以是测试名过滤、--lib/--test <target>，或再带一个 `--` 透传给
# 测试二进制，如 `-- --nocapture`）。
# 完整日志落在 .kabegame/debug/test/test-<时间戳>.log（该目录已 gitignore）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1

CRATE="kabegame-core"
if [ "$#" -gt 0 ]; then
  case "$1" in
    kabegame|kabegame-cli|kabegame-core)
      CRATE="$1"
      shift
      ;;
  esac
fi

LOG_DIR="$ROOT/.kabegame/debug/test"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/test-$(date +%Y%m%d-%H%M%S).log"

# --- 预检：运行中的 app 会锁住 target/。-c kabegame 时 cef-dll-sys 的 build script
#     要往 target/ 复制 CEF 运行时，被占用时报 os error 32 / Text file busy。
if [ "$CRATE" = "kabegame" ]; then
  if pgrep -x kabegame >/dev/null 2>&1 || pgrep -f 'kabegame\.exe' >/dev/null 2>&1; then
    echo "[test] 警告：检测到正在运行的 kabegame 进程，-c kabegame 的编译可能因 target/ 被占用而失败。" >&2
  fi
fi

echo "[test] 运行: deno task test -c $CRATE -- $*"
echo "[test] 日志: $LOG"
START=$(date +%s)

deno task test -c "$CRATE" -- "$@" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

ELAPSED=$(( $(date +%s) - START ))

# --- 汇总。cargo test 每个 target 输出一行
#     `test result: ok|FAILED. X passed; Y failed; Z ignored; ...`，可能有多行
#     （lib / 每个集成测试 / doc-test 各一行），这里跨行累加。
#     日志带 ANSI 颜色码，grep 前先剥掉。
PLAIN="$(sed $'s/\033\\[[0-9;]*m//g' "$LOG")"
PASSED=$(printf '%s\n' "$PLAIN" | grep -oE '[0-9]+ passed' | awk '{s+=$1} END {print s+0}')
FAILED=$(printf '%s\n' "$PLAIN" | grep -oE '[0-9]+ failed' | awk '{s+=$1} END {print s+0}')
IGNORED=$(printf '%s\n' "$PLAIN" | grep -oE '[0-9]+ ignored' | awk '{s+=$1} END {print s+0}')
# 编译期 error（测试没跑起来时汇总里只有它）。排除 cargo 的收尾行。
RS_ERRORS=$(printf '%s\n' "$PLAIN" \
  | grep -E '^error(\[E[0-9]+\])?:' \
  | grep -cvE '^error: (could not compile|aborting due to|test failed)' || true)

echo
echo "======== test 汇总 ========"
echo "crate     : $CRATE"
echo "耗时      : ${ELAPSED}s"
echo "退出码    : $STATUS"
echo "编译 error: $RS_ERRORS 个"
echo "测试      : $PASSED passed / $FAILED failed / $IGNORED ignored"

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "-------- 失败摘要 --------"
  # 失败的测试名（"test foo ... FAILED"）+ 编译错误行，带日志行号
  printf '%s\n' "$PLAIN" | grep -nE '^test .* FAILED$|^error(\[E[0-9]+\])?:' | head -40
  echo
  echo "（每个失败用例的 panic/断言详情在 failures: 段落，完整上下文见 ${LOG} ）"
else
  echo "结果      : 通过 ✅"
fi
echo "==========================="

exit "$STATUS"
