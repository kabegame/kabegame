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
# 覆盖项：
#   KABEGAME_DEV_SERVER_PORT  vite 端口（默认 1420）
#   KABEGAME_CEF_DEBUG_PORT   跳过发现，直连这个 CDP 端口

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="$ROOT/.claude/skills/kabegame-chromium"
cd "$ROOT" || exit 1

VITE_PORT="${KABEGAME_DEV_SERVER_PORT:-1420}"
VITE_BASE="http://127.0.0.1:${VITE_PORT}"
DEV_CMD="deno task dev -c kabegame"

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

cdp_up() {
  curl -sf -o /dev/null -m 2 "http://127.0.0.1:${1}/json/version" 2>/dev/null
}

# 解析出可用的 CDP 端口；失败时把"下一步该干嘛"写到 stderr 并返回非 0。
resolve_port() {
  # 显式指定就直连，跳过 vite 发现（应急/连非 dev 实例）。
  if [ -n "${KABEGAME_CEF_DEBUG_PORT:-}" ]; then
    echo "$KABEGAME_CEF_DEBUG_PORT"
    return 0
  fi

  if ! vite_up; then
    cat >&2 <<EOF
[chromium] 没检测到 dev server（${VITE_BASE} 无应答）。
[chromium] 请在你自己的终端里手动启动（这样编译进度你能直接看到）：
[chromium]
[chromium]     ${DEV_CMD}
[chromium]
[chromium] 首次/大改后要编 Rust，可能几分钟；窗口起来后再回来跑本 skill。
EOF
    return 1
  fi

  local port
  port="$(registered_port)"
  if [ -z "$port" ]; then
    cat >&2 <<EOF
[chromium] dev server 活着，但没有 app 上报 CDP 端口。常见原因：
[chromium]   1. app 还在编译 / 还没起到 setup（等一会儿再试）；
[chromium]   2. 这个 dev 实例是本次改动之前起的（没有上报逻辑）——重启 dev 即可；
[chromium]   3. 显式设了 KABEGAME_CEF_DEBUG_PORT=0 把调试端口关掉了；
[chromium]   4. vite 中途重启过，注册记录（内存态）被清空——重启 app 侧即可。
EOF
    return 1
  fi

  if ! cdp_up "$port"; then
    cat >&2 <<EOF
[chromium] vite 上登记的 CDP 端口是 ${port}，但它现在不应答。
[chromium] 多半是 app 已退出/正在热重启（登记是内存态，不会自动撤销）。等它起来再试。
EOF
    return 1
  fi

  echo "$port"
}

cmd_status() {
  echo "vite dev server : ${VITE_BASE}"
  if vite_up; then
    echo "  状态          : 活着 ✅"
  else
    echo "  状态          : 无应答 ❌（需手动启动: ${DEV_CMD}）"
    return 0
  fi

  local port
  port="$(registered_port)"
  if [ -z "$port" ]; then
    echo "CDP             : 未登记 ❌（app 未起 / 还在编译 / 端口被显式关闭）"
    return 0
  fi

  echo "CDP 端口        : ${port}（由 app 上报给 vite）"
  if cdp_up "$port"; then
    echo "  状态          : 就绪 ✅"
    curl -sf -m 2 "http://127.0.0.1:${port}/json/version" | sed 's/^/                  /'
  else
    echo "  状态          : 登记了但不应答 ❌（app 已退出或正在重启）"
  fi
}

SUB="${1:-help}"
shift 2>/dev/null || true

case "$SUB" in
  status) cmd_status ;;
  port)
    PORT="$(resolve_port)" || exit 4
    echo "$PORT"
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
