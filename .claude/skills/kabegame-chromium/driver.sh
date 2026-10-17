#!/usr/bin/env bash
# Kabegame dev chromium 驱动 —— 让 agent 能真正"看到"和"操作"跑起来的 app。
#
# 原理：kabegame 桌面端跑在自建 CEF runtime 上（本质是 Chromium），dev 下由
# ComponentPlugin 注入 KABEGAME_CEF_DEBUG_PORT=random，app 起来后把**实际端口**
# POST 给 vite dev server（/__kabegame_cdp/register）。本驱动只认死端口 1420：
# 向 vite 要到随机端口，再用 playwright-core 的 connectOverCDP 连上去截图 / 执行
# JS / 点击。
#
# 本驱动**不管 dev 的生命周期**：编译要几分钟且没有进度可看，代跑只会把用户关在
# 黑箱外面。检测不到 dev 就直接让用户自己起（他自己的终端里能看到编译进度）。
#
# 用法（仓库任意位置）：
#   .claude/skills/kabegame-chromium/driver.sh status           # dev/CDP 状态
#   .claude/skills/kabegame-chromium/driver.sh port             # 打印发现到的 CDP 端口
#   .claude/skills/kabegame-chromium/driver.sh targets          # 列出所有 page
#   .claude/skills/kabegame-chromium/driver.sh shot /tmp/a.png  # 截图
#   .claude/skills/kabegame-chromium/driver.sh eval 'document.title'
#   .claude/skills/kabegame-chromium/driver.sh click '.foo'
#
# Android（系统 WebView 自带 CDP，经 adb forward 转到本机）：任意子命令加 --android，
# 或设 KABEGAME_ANDROID=1。
#   .claude/skills/kabegame-chromium/driver.sh status --android
#   .claude/skills/kabegame-chromium/driver.sh shot /tmp/a.png --android
#   .claude/skills/kabegame-chromium/driver.sh screen /tmp/full.png --android  # adb 整屏（含原生层）
#
# 覆盖项：
#   KABEGAME_DEV_SERVER_PORT  vite 端口（默认 1420）
#   KABEGAME_CEF_DEBUG_PORT   跳过发现，直连这个 CDP 端口
#   KABEGAME_ANDROID_PACKAGE  Android 包名（默认 app.kabegame.dev；prod 包不开 WebView 调试）
#   ANDROID_SERIAL            多台设备时指定 adb 目标（adb 原生识别）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="$ROOT/.claude/skills/kabegame-chromium"
cd "$ROOT" || exit 1

VITE_PORT="${KABEGAME_DEV_SERVER_PORT:-1420}"
VITE_BASE="http://127.0.0.1:${VITE_PORT}"
DEV_CMD="deno task dev -c kabegame"
ANDROID_PKG="${KABEGAME_ANDROID_PACKAGE:-app.kabegame.dev}"
ANDROID_DEV_CMD="deno task dev -c kabegame --mode android"

vite_up() {
  # 拿到任何 HTTP 状态码都说明 dev server 活着：200=已登记 CDP，404=还没登记。
  # 连不上时 curl 的 %{http_code} 是 000。
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$VITE_BASE/__kabegame_cdp" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# 从 vite 取 app 寄存的 CDP 端口。成功则 stdout 是端口号。
registered_port() {
  curl -sf -m 2 "$VITE_BASE/__kabegame_cdp" 2>/dev/null |
    sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p'
}

# 只看 HTTP 状态码不够：vite 的 SPA fallback 对**任意**路径都回 200 text/html，
# 探到 1420 会误判成 CDP。必须认响应里的 webSocketDebuggerUrl——cdp.mjs 连的也是它。
cdp_up() {
  curl -sf -m 2 "http://127.0.0.1:${1}/json/version" 2>/dev/null |
    grep -q 'webSocketDebuggerUrl'
}

# 兜底：绕开 vite 中转，直接在本机找 kabegame 进程自己监听的 CDP 端口。
#
# vite 中转有两个断点：登记是 vite 进程内的内存态（改 vite.config.ts 或它 import
# 的任何本地文件都会让 vite restart 并清空它，实测如此），而 app 侧只在启动时上报
# 一次、失败即放弃。落盘已经补上了 restart 那一环，这里再补一条完全不依赖 vite 的
# 路径：app 活着就一定能找到，vite 没跑也能用。
#
# lsof 缺席（如 Windows 的 git bash）时静默跳过，行为退回纯 vite 发现。
discover_port() {
  command -v lsof >/dev/null 2>&1 || return 1
  local ports p
  # `-a` 不能省：lsof 的多个选择项默认取**并集**，没有它 `-c kabegame` 形同虚设，
  # 会把本机所有监听端口都列出来。-c 按命令名前缀匹配，kabegame 与
  # kabegame-cef-helper 都会中；helper 不听 CDP，探活自然把它筛掉。
  ports="$(lsof -nP -iTCP -sTCP:LISTEN -a -c kabegame -Fn 2>/dev/null |
    sed -n 's/^n.*:\([0-9]\{1,\}\)$/\1/p' | sort -u)"
  for p in $ports; do
    if cdp_up "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# 解析出可用的 CDP 端口；失败时把"下一步该干嘛"写到 stderr 并返回非 0。
resolve_port() {
  # 显式指定就直连，跳过 vite 发现（应急/连非 dev 实例）。
  if [ -n "${KABEGAME_CEF_DEBUG_PORT:-}" ]; then
    echo "$KABEGAME_CEF_DEBUG_PORT"
    return 0
  fi

  if ! vite_up; then
    # vite 没跑不代表 app 没跑（比如只重启了 vite，或直接跑了 dev 编好的二进制）
    local scanned
    if scanned="$(discover_port)"; then
      echo "$scanned"
      return 0
    fi
    cat >&2 <<EOF
[chromium] 没检测到 dev server（${VITE_BASE} 无应答），本机也没扫到在监听的 CDP 端口。
[chromium] 请在你自己的终端里手动启动（这样编译进度你能直接看到）：
[chromium]
[chromium]     ${DEV_CMD}
[chromium]
[chromium] 首次/大改后要编 Rust，可能几分钟；窗口起来后再回来跑本 skill。
EOF
    return 1
  fi

  local port scanned
  port="$(registered_port)"

  # 健康路径：登记的端口活着，直接用。
  if [ -n "$port" ] && cdp_up "$port"; then
    echo "$port"
    return 0
  fi

  # 登记缺失或已陈旧（app 退出/换号都不会撤销登记）→ 回落到本机扫描
  if scanned="$(discover_port)"; then
    echo "$scanned"
    return 0
  fi

  if [ -z "$port" ]; then
    cat >&2 <<EOF
[chromium] dev server 活着，但查不到 CDP 端口（vite 上没登记，本机也没扫到）。常见原因：
[chromium]   1. app 还在编译 / 还没起到 setup（等一会儿再试）；
[chromium]   2. 这个 dev 实例是本次改动之前起的（没有上报逻辑）——重启 dev 即可；
[chromium]   3. 显式设了 KABEGAME_CEF_DEBUG_PORT=0 把调试端口关掉了。
EOF
    return 1
  fi

  cat >&2 <<EOF
[chromium] vite 上登记的 CDP 端口是 ${port}，但它现在不应答，本机也没扫到别的。
[chromium] 多半是 app 已退出/正在热重启（登记不会自动撤销）。等它起来再试。
EOF
  return 1
}

# ---------------------------------------------------------------------------
# Android：系统 WebView 是 Chromium，`setWebContentsDebuggingEnabled(true)` 后在设备上
# 监听 abstract unix socket `@webview_devtools_remote_<pid>`（chrome://inspect 走的就是
# 它）。Tauri 在 devtools=true（dev 配置）时由 wry 打开这个开关，所以只要
# `adb forward` 到本机端口，就是一个标准 CDP 端点，cdp.mjs 原样可用。
# ---------------------------------------------------------------------------

android_pid() {
  adb shell pidof "$ANDROID_PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}'
}

# 设备上该 pid 的 WebView devtools socket 名（不带 @）。没开调试则为空。
android_socket() {
  adb shell cat /proc/net/unix 2>/dev/null | tr -d '\r' |
    grep -ao "@webview_devtools_remote_${1}\$" | head -n 1 | sed 's/^@//'
}

# 复用已有的转发（同一 socket）；没有就 tcp:0 让 adb 分配本机空闲端口。
# pid 每次启动都会变，旧 pid 的转发留着无害，这里顺手清掉指向别的
# webview_devtools_remote_* 的陈旧条目，免得 forward --list 越积越长。
android_forward() {
  local sock="$1" line local_spec remote port
  while read -r _serial local_spec remote; do
    [ -n "${remote:-}" ] || continue
    case "$remote" in
      "localabstract:${sock}")
        port="${local_spec#tcp:}"
        ;;
      localabstract:webview_devtools_remote_*)
        adb forward --remove "$local_spec" >/dev/null 2>&1
        ;;
    esac
  done < <(adb forward --list 2>/dev/null | tr -d '\r')

  if [ -n "${port:-}" ] && cdp_up "$port"; then
    echo "$port"
    return 0
  fi
  [ -n "${port:-}" ] && adb forward --remove "tcp:${port}" >/dev/null 2>&1
  line="$(adb forward tcp:0 "localabstract:${sock}" 2>/dev/null | tr -d '\r')"
  [ -n "$line" ] && echo "$line"
}

resolve_android_port() {
  if ! command -v adb >/dev/null 2>&1; then
    echo "[chromium] 找不到 adb（Android SDK platform-tools 没装或不在 PATH）。" >&2
    return 1
  fi
  if ! adb get-state >/dev/null 2>&1; then
    cat >&2 <<EOF
[chromium] adb 没有可用设备（未连接 / 未授权 / 多台设备未设 ANDROID_SERIAL）。
[chromium] 用 \`adb devices\` 确认。
EOF
    return 1
  fi

  local pid sock port
  pid="$(android_pid)"
  if [ -z "$pid" ]; then
    cat >&2 <<EOF
[chromium] 设备上没有在跑的 ${ANDROID_PKG}。请在你自己的终端里启动：
[chromium]
[chromium]     ${ANDROID_DEV_CMD}
[chromium]
[chromium] 或直接在手机上打开已安装的 dev 包；包名不同就设 KABEGAME_ANDROID_PACKAGE。
EOF
    return 1
  fi

  sock="$(android_socket "$pid")"
  if [ -z "$sock" ]; then
    cat >&2 <<EOF
[chromium] ${ANDROID_PKG}（pid ${pid}）没有 WebView 调试 socket。
[chromium] 只有 devtools=true 的构建（dev）才会 setWebContentsDebuggingEnabled；prod 包不行。
[chromium] 也可能是 WebView 还没创建完，等界面出来再试。
EOF
    return 1
  fi

  port="$(android_forward "$sock")"
  if [ -z "$port" ] || ! cdp_up "$port"; then
    echo "[chromium] adb forward 到 ${sock} 失败或不应答（端口: ${port:-无}）。" >&2
    return 1
  fi
  echo "$port"
}

cmd_status_android() {
  echo "Android 包      : ${ANDROID_PKG}"
  if ! command -v adb >/dev/null 2>&1; then
    echo "  adb           : 未找到 ❌"
    return 0
  fi
  echo "  设备          : $(adb get-serialno 2>/dev/null | tr -d '\r' || echo '无')"
  local pid
  pid="$(android_pid)"
  echo "  pid           : ${pid:-未运行 ❌（需手动启动: ${ANDROID_DEV_CMD}）}"
  [ -n "$pid" ] || return 0
  echo "  调试 socket   : $(android_socket "$pid" || true)"
  local port
  if port="$(resolve_android_port 2>/dev/null)"; then
    echo "CDP 端口        : ${port}（adb forward）"
    echo "  状态          : 就绪 ✅"
    curl -sf -m 2 "http://127.0.0.1:${port}/json/version" | sed 's/^/                  /'
  else
    echo "CDP             : 不可用 ❌（跑 \`$0 port --android\` 看具体原因）"
  fi
}

# 整屏截图：CDP 截图只包含 WebView 内容，系统栏 / 原生对话框 / 通知要靠 screencap。
cmd_screen_android() {
  local out="${1:-}"
  if [ -z "$out" ]; then
    echo "[chromium] screen 需要输出路径，例如: screen /tmp/full.png --android" >&2
    return 2
  fi
  adb exec-out screencap -p >"$out" || return 1
  realpath "$out"
}

cmd_status() {
  echo "vite dev server : ${VITE_BASE}"
  if vite_up; then
    echo "  状态          : 活着 ✅"
  else
    echo "  状态          : 无应答 ❌（需手动启动: ${DEV_CMD}）"
  fi

  local port source scanned
  port="$(registered_port)"
  source="由 app 上报给 vite"
  if [ -z "$port" ] || ! cdp_up "$port"; then
    if scanned="$(discover_port)"; then
      [ -n "$port" ] &&
        echo "CDP 登记        : ${port}（已陈旧，不应答；回落到本机扫描）"
      port="$scanned"
      source="本机扫描 kabegame 进程的监听端口"
    fi
  fi

  if [ -z "$port" ]; then
    echo "CDP             : 未发现 ❌（app 未起 / 还在编译 / 端口被显式关闭）"
    return 0
  fi

  echo "CDP 端口        : ${port}（${source}）"
  if cdp_up "$port"; then
    echo "  状态          : 就绪 ✅"
    curl -sf -m 2 "http://127.0.0.1:${port}/json/version" | sed 's/^/                  /'
  else
    echo "  状态          : 登记了但不应答 ❌（app 已退出或正在重启）"
  fi
}

SUB="${1:-help}"
shift 2>/dev/null || true

# --android 可出现在任意位置；从参数里摘掉，别透传给 cdp.mjs。
ANDROID="${KABEGAME_ANDROID:-}"
ARGS=()
for a in "$@"; do
  if [ "$a" = "--android" ]; then
    ANDROID=1
  else
    ARGS+=("$a")
  fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ -n "$ANDROID" ] && [ "$ANDROID" != "0" ]; then
  case "$SUB" in
    status) cmd_status_android ;;
    port)
      PORT="$(resolve_android_port)" || exit 4
      echo "$PORT"
      ;;
    screen) cmd_screen_android "$@" ;;
    targets | shot | eval | click | text)
      PORT="$(resolve_android_port)" || exit 4
      KABEGAME_CEF_DEBUG_PORT="$PORT" node "$SKILL_DIR/cdp.mjs" "$SUB" "$@"
      ;;
    help) node "$SKILL_DIR/cdp.mjs" help ;;
    *)
      echo "未知子命令: $SUB" >&2
      exit 2
      ;;
  esac
  exit $?
fi

case "$SUB" in
  status) cmd_status ;;
  port)
    PORT="$(resolve_port)" || exit 4
    echo "$PORT"
    ;;
  screen)
    echo "[chromium] screen 只在 --android 下可用（adb screencap）；桌面用 shot。" >&2
    exit 2
    ;;
  start | stop)
    cat >&2 <<EOF
[chromium] 本 skill 不再代管 dev 生命周期（编译几分钟且看不到进度）。
[chromium] 请自己在终端里跑： ${DEV_CMD}
[chromium] 起来之后用 status / shot / eval / click。
EOF
    exit 2
    ;;
  targets | shot | eval | click | text)
    PORT="$(resolve_port)" || exit 4
    KABEGAME_CEF_DEBUG_PORT="$PORT" node "$SKILL_DIR/cdp.mjs" "$SUB" "$@"
    ;;
  help) node "$SKILL_DIR/cdp.mjs" help ;;
  *)
    echo "未知子命令: $SUB" >&2
    node "$SKILL_DIR/cdp.mjs" help
    exit 2
    ;;
esac
