#!/usr/bin/env bash
# 在正在运行的 dev app 里跑插件任务（WebView 插件唯一的验证途径；V8 插件也可用）。
#   app-run.sh <plugin-id> '<userConfig JSON>' [--secs N] [--out DIR]
#
# 经 kabegame-chromium 的 CDP 调 Tauri 命令：refresh_plugins → start_task → 轮询
# get_task / get_task_logs → 超时 cancel_task。需要用户自己先跑 deno task dev -c kabegame。
# 任务运行期间可另开终端：kabegame-chromium/driver.sh targets 找到 crawler-<taskId> 窗口
# 截图或 eval，看 WebView 页面当下的真实 DOM。
set -uo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CHROME="$ROOT/.claude/skills/kabegame-chromium/driver.sh"
ID="${1:?用法: app-run.sh <plugin-id> '<userConfig JSON>' [--secs N] [--out DIR]}"
CFG="${2:-{\}}"; shift; [ $# -gt 0 ] && shift
SECS=90
OUT="${TMPDIR:-/tmp}"; OUT="${OUT%/}/kb-plugin-test/$ID-app"
while [ $# -gt 0 ]; do
  case "$1" in
    --secs) SECS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"

"$CHROME" port >/dev/null 2>&1 || { echo "✗ 没连上 dev app。请用户先跑：deno task dev -c kabegame" >&2; exit 1; }

ev() { "$CHROME" eval "$1" 2>/dev/null | tail -1; }

TASK=$(ev "(async()=>{const I=window.__TAURI_INTERNALS__;await I.invoke('refresh_plugins');
  return await I.invoke('start_task',{task:{pluginId:'$ID',outputDir:$(printf %s "$OUT" | deno eval 'console.log(JSON.stringify(await new Response(Deno.stdin.readable).text()))'),userConfig:$CFG}})})()" | tr -d '"')
[ -n "$TASK" ] && [ "$TASK" != "null" ] || { echo "✗ start_task 失败（插件未投放？userConfig 非法 JSON？）" >&2; exit 1; }
echo "▶ task ${TASK}（限时 ${SECS}s，输出 ${OUT}）"

STATUS=running
for ((t = 0; t < SECS; t += 3)); do
  sleep 3
  STATUS=$(ev "(async()=>(await window.__TAURI_INTERNALS__.invoke('get_task',{taskId:'$TASK'}))?.status)()" | tr -d '"')
  case "$STATUS" in completed|failed|canceled|cancelled) break ;; esac
done
case "$STATUS" in completed|failed|canceled|cancelled) STOPPED="自行结束" ;; *)
  STOPPED="限时 ${SECS}s 到，已取消"
  ev "(async()=>window.__TAURI_INTERNALS__.invoke('cancel_task',{taskId:'$TASK'}))()" >/dev/null; sleep 2 ;;
esac

echo "── 摘要 (${ID}, app) ── 运行：${STOPPED}"
"$CHROME" eval "(async()=>{const I=window.__TAURI_INTERNALS__;
  const t=await I.invoke('get_task',{taskId:'$TASK'});
  const raw=await I.invoke('get_task_logs',{taskId:'$TASK'});const logs=Array.isArray(raw)?raw:(raw.logs||[]);
  const key=c=>{const m=c.match(/\"k\":\"([A-Za-z]+)\"/);return m?'i18n:'+m[1]:c.slice(0,90)};
  const agg={};for(const l of logs.filter(l=>l.level==='warn'||l.level==='error')){const k=l.level+' '+key(l.content);agg[k]=(agg[k]||0)+1}
  return {status:t.status,新下载:t.successCount,去重跳过:t.dedupCount,失败:t.failedCount,进度:t.progress,错误:t.error||null,
    问题分类:agg,最后日志:logs.filter(l=>l.level==='print'||l.level==='info').slice(-6).map(l=>l.content.slice(0,160))}})()" 2>/dev/null \
  | sed -n '/^{/,$p'
