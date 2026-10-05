#!/usr/bin/env bash
# 打包到 dev 插件目录 → release kabegame-cli 以另一个 id 直接运行该 .kgpg，限时后取消，给出可判定的摘要。
#   run-cli.sh <plugin-id> [--id TEST_ID] [--secs N] [--out DIR] [--no-deploy] [--var k=v ...] [其它 plugin run 参数]
#
# 1. deploy.sh 打包到 .kabegame/debug/data/plugins-directory/<id>.kgpg（dev app 也能看到这一版）
# 2. release CLI `plugin run <该 .kgpg> --id <TEST_ID>`：路径模式临时运行、不安装；
#    --id（默认 <id>-test）让插件数据目录、default-configs、入库 plugin_id 与正式插件隔离。
#    不传 --data：release 默认用系统用户数据目录。图片落到 --out（默认临时目录）。
# 默认 60 秒后发 SIGINT：CLI 会把任务标记为 canceled，而不是留下永远 running 的任务。
# --plain 模式下任务被取消时不打印计数，所以计数从系统数据目录的 images.db 读。
set -uo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ID="${1:?用法: run-cli.sh <plugin-id> [--id TEST_ID] [--secs N] [--out DIR] [--no-deploy] [--var k=v ...]}"; shift
CLI="$ROOT/target/release/kabegame-cli"
KGPG="$ROOT/.kabegame/debug/data/plugins-directory/$ID.kgpg"
TEST_ID="$ID-test"
SECS=60
DEPLOY=1
OUT="${TMPDIR:-/tmp}"; OUT="${OUT%/}/kb-plugin-test/$ID"
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --id) TEST_ID="$2"; shift 2 ;;
    --secs) SECS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --no-deploy) DEPLOY=0; shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done
# 与 CLI 的 DataMode::Auto（release）一致：dirs::data_local_dir()/Kabegame
case "$(uname)" in
  Darwin) DB="$HOME/Library/Application Support/Kabegame/images.db" ;;
  *) DB="${XDG_DATA_HOME:-$HOME/.local/share}/Kabegame/images.db" ;;
esac
mkdir -p "$OUT"
LOG="$OUT/run-$(date +%H%M%S).log"
MARK="$OUT/.run-start"; touch "$MARK"

if [ "$DEPLOY" = 1 ]; then "$(dirname "$0")/deploy.sh" "$ID" || exit 1; fi
[ -f "$KGPG" ] || { echo "✗ 找不到 $KGPG（去掉 --no-deploy）" >&2; exit 1; }
[ -x "$CLI" ] || { echo "✗ 缺少 release CLI —— 请用户在仓库根执行 deno task b -c kabegame-cli --release" >&2; exit 1; }

"$CLI" plugin run "$KGPG" --id "$TEST_ID" --plain --output-dir "$OUT" ${PASS[@]+"${PASS[@]}"} >"$LOG" 2>&1 &
PID=$!
for ((i = 0; i < SECS; i++)); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then
  STOPPED="限时 ${SECS}s 到，已取消"
  kill -INT "$PID"
  for ((i = 0; i < 15; i++)); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$PID" 2>/dev/null
else
  STOPPED="自行结束"
fi
wait "$PID" 2>/dev/null

TASK=$(grep -o '"taskId":"[^"]*"' "$LOG" | head -1 | cut -d'"' -f4)
echo "── 摘要 (${ID} 以 id=${TEST_ID} 运行) ──"
echo "  运行：${STOPPED}   日志：${LOG}"
grep -m1 "^插件 " "$LOG" | sed 's/^/  /'
if grep -q "Hardening assertion\|panicked at\|SIGSEGV" "$LOG"; then
  echo "  ✗ 进程崩溃："; grep -m3 "Hardening assertion\|panicked at\|SIGSEGV" "$LOG" | sed 's/^/    /'
fi
if [ -n "$TASK" ] && [ -f "$DB" ]; then
  sqlite3 -readonly "$DB" "select '  任务：'||status||'  新下载 '||success_count||'  去重跳过 '||dedup_count||'  失败 '||failed_count||'  进度 '||progress||'%'||coalesce('  错误 '||error,'') from tasks where id='$TASK';"
else
  echo "  ✗ 任务没建起来（--var key 写错 / 配置非法 / id 不合法），日志开头："
  head -20 "$LOG" | sed 's/^/    /'
fi
echo "  日志计数：LOG $(grep -c '^   LOG' "$LOG")  WARN $(grep -c '^  WARN' "$LOG")  ERROR $(grep -c '^ ERROR' "$LOG")"
# i18n 占位警告（去重等）按 key 聚合，其余按前 90 字聚合
grep '^  WARN\|^ ERROR' "$LOG" | sed -E 's/.*"k":"([A-Za-z]+)".*/  i18n:\1/; s/^(.{0,90}).*/\1/' | sort | uniq -c | sort -rn | head -8
echo "  最后几条插件日志："
grep '^   LOG' "$LOG" | tail -4 | cut -c1-160 | sed 's/^/  /'
echo "  本次新增文件：$(find "$OUT" -type f -newer "$MARK" ! -name '*.log' | wc -l | tr -d ' ')  (${OUT})"
