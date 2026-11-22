#!/usr/bin/env bash
# 在当前桌面会话里开一个嵌套的 GNOME Shell（窗口里的 GNOME 桌面），开发 GNOME 支持时用，不用注销。
#
#   scripts/gnome-nested.sh                        # 开嵌套 GNOME Shell，屏幕用缺省的
#   scripts/gnome-nested.sh 1920x1080 2560x1440    # 每个尺寸一块虚拟屏（WxH 或 WxH@R，只对 GNOME 49+）
#   scripts/gnome-nested.sh run <命令...>          # 在开着的嵌套会话里跑程序，例如
#                                                  #   scripts/gnome-nested.sh run deno task dev -c kabegame
#
# - GNOME 49 起是 `gnome-shell --devkit`（画面在 mutter-devkit 查看器窗口里，Ubuntu 的包是 mutter-dev-bin），
#   48 及更早是 `gnome-shell --nested`。devkit 窗口的菜单里还能再加屏、加启动器。
# - 嵌套会话有自己的 D-Bus 会话总线（dbus-run-session）；PipeWire 是用户级服务，和宿主会话共用。
# - `run` 把 WAYLAND_DISPLAY、DBUS_SESSION_BUS_ADDRESS 换成嵌套会话的，桌面标识换成 GNOME，去掉 KDE 的会话变量
#   与 DISPLAY（只走 Wayland），免得程序把自己当成跑在 Plasma 里。
# - 只用于开发：多显示器、真实的桌面层级与输入要在真的 GNOME 会话里验收。

set -euo pipefail

runtime_dir="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR 未设置}"
env_file="$runtime_dir/kabegame-gnome-nested.env"

fail() {
  echo "[gnome-nested] $*" >&2
  exit 1
}

if [[ "${1:-}" == "run" ]]; then
  shift
  (($# > 0)) || fail "用法：scripts/gnome-nested.sh run <命令...>"
  [[ -f "$env_file" ]] || fail "嵌套 GNOME Shell 没在跑（找不到 $env_file），先运行 scripts/gnome-nested.sh"
  # shellcheck disable=SC1090
  source "$env_file"
  exec "$@"
fi

# 不带推荐包：gnome-shell 推荐 gdm3，装上会被问要不要换掉现在的登录管理器
command -v gnome-shell >/dev/null ||
  fail "没装 GNOME Shell：sudo apt install --no-install-recommends gnome-shell mutter-dev-bin"
command -v dbus-run-session >/dev/null || fail "找不到 dbus-run-session（Ubuntu 的包是 dbus-daemon）"

if [[ -f "$env_file" ]]; then
  old_pid="$(sed -n 's/^# pid=//p' "$env_file")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    fail "已经有一个嵌套 GNOME Shell 在跑（pid $old_pid），用 scripts/gnome-nested.sh run <命令> 往里开程序"
  fi
fi

major="$(gnome-shell --version | awk '{print int($3)}')"
args=(--wayland)
if ((major >= 49)); then
  [[ -x /usr/libexec/mutter-devkit ]] || command -v mutter-devkit >/dev/null ||
    fail "GNOME $major 的嵌套会话要 mutter-devkit：sudo apt install --no-install-recommends mutter-dev-bin"
  args+=(--devkit)
  for size in "$@"; do
    [[ "$size" =~ ^[0-9]+x[0-9]+(@[0-9.]+)?$ ]] || fail "屏幕尺寸要写成 WxH 或 WxH@R：$size"
    args+=(--virtual-monitor "$size")
  done
else
  args+=(--nested)
  (($# == 0)) || echo "[gnome-nested] GNOME $major 用 --nested，忽略屏幕尺寸参数" >&2
fi

# 嵌套会话会新建一个 wayland-N 套接字，先记下现有的，启动后找新出来的那个
shopt -s nullglob
declare -A before=()
for sock in "$runtime_dir"/wayland-*; do
  [[ "$sock" == *.lock ]] && continue
  # 锁没人占着的是上次没清掉的旧套接字，合成器会重用这个名字，不算已有的
  [[ -e "$sock.lock" ]] && flock -n "$sock.lock" true 2>/dev/null && continue
  before["$sock"]=1
done

bus_file="$(mktemp "$runtime_dir/kabegame-gnome-nested.bus.XXXXXX")"
cleanup() {
  rm -f "$bus_file" "$env_file"
  if [[ -n "${shell_pid:-}" ]]; then
    # 后台进程不收终端的 Ctrl+C，自己连同 dbus-run-session 的子进程（gnome-shell、dbus-daemon）一起结束
    pkill -TERM -P "$shell_pid" 2>/dev/null || true
    kill "$shell_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "[gnome-nested] GNOME Shell $major：gnome-shell ${args[*]}"
dbus-run-session -- sh -c 'printf "%s" "$DBUS_SESSION_BUS_ADDRESS" > "$1"; shift; exec "$@"' \
  sh "$bus_file" gnome-shell "${args[@]}" &
shell_pid=$!

display=""
for _ in $(seq 1 300); do
  kill -0 "$shell_pid" 2>/dev/null || break
  for sock in "$runtime_dir"/wayland-*; do
    [[ "$sock" == *.lock || -n "${before[$sock]:-}" || ! -S "$sock" ]] && continue
    display="$(basename "$sock")"
  done
  [[ -n "$display" && -s "$bus_file" ]] && break
  sleep 0.1
done

if [[ -n "$display" && -s "$bus_file" ]]; then
  cat >"$env_file" <<EOF
# pid=$shell_pid
export WAYLAND_DISPLAY=$display
export DBUS_SESSION_BUS_ADDRESS='$(cat "$bus_file")'
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome DESKTOP_SESSION=gnome
unset DISPLAY KDE_SESSION_VERSION KDE_FULL_SESSION KDE_SESSION_UID
EOF
  echo "[gnome-nested] 已就绪：WAYLAND_DISPLAY=$display"
  echo "[gnome-nested] 往里开程序：scripts/gnome-nested.sh run <命令...>（关掉窗口即退出）"
else
  echo "[gnome-nested] 30 s 内没等到嵌套会话的 Wayland 套接字，run 用不了；看上面 gnome-shell 的输出" >&2
fi

status=0
wait "$shell_pid" || status=$?
shell_pid=""
exit "$status"
