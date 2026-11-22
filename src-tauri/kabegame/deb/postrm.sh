#!/bin/sh
set -e

# 插件模式的 Plasma 壁纸插件（Kabegame 装在每个用户的 ~/.local/share/plasma/wallpapers/ 里，见
# src-tauri/kabegame/src/wallpaper/manager/plasma/install.rs）跟着应用一起卸载：
# - 正在用它的桌面先换回 org.kde.image：登录着的用户经他自己的会话总线让 plasmashell 换（换回之前的图片），
#   没登录的用户改 Plasma 的桌面配置文件；
# - 再删掉用户目录里带 Kabegame 标记（X-Kabegame-StreamProtocol）的那份。
# 系统目录里别的包装的旧版（C++ / IPC 版）不碰。只在 remove / purge 时做，升级（upgrade）不动。
# KABEGAME_POSTRM_DRY_RUN=1 时只打印要做的事。
PLASMA_PLUGIN_ID="org.kabegame.wallpaper"

kabegame_run() {
  if [ "${KABEGAME_POSTRM_DRY_RUN:-}" = "1" ]; then
    echo "[kabegame] (dry run) $*"
  else
    "$@"
  fi
}

# 以用户 $1 的身份跑后面的命令（root 跑 postrm；dry run 或本来就是这个用户时直接跑）
kabegame_as_user() {
  user="$1"
  shift
  if [ "$(id -un)" = "$user" ]; then
    kabegame_run "$@"
  elif command -v runuser >/dev/null 2>&1; then
    kabegame_run runuser -u "$user" -- "$@"
  else
    return 1
  fi
}

# 用户 $1（uid $2、家目录 $3）的桌面里用着 Kabegame 插件的换回 org.kde.image
kabegame_reset_plasma_wallpaper() {
  user="$1"
  uid="$2"
  home="$3"
  bus="/run/user/$uid/bus"
  if [ -S "$bus" ] && pgrep -u "$uid" -x plasmashell >/dev/null 2>&1; then
    script="desktops().forEach(function (d) { if (d.wallpaperPlugin === '$PLASMA_PLUGIN_ID') d.wallpaperPlugin = 'org.kde.image'; });"
    if kabegame_as_user "$user" env DBUS_SESSION_BUS_ADDRESS="unix:path=$bus" \
      dbus-send --session --print-reply --reply-timeout=5000 --dest=org.kde.plasmashell \
      /PlasmaShell org.kde.PlasmaShell.evaluateScript "string:$script" >/dev/null 2>&1; then
      echo "[kabegame] Switched $user's desktop wallpaper back to org.kde.image"
      return 0
    fi
    echo "[kabegame] Could not reach $user's plasmashell; editing the Plasma config instead"
  fi
  config="$home/.config/plasma-org.kde.plasma.desktop-appletsrc"
  if [ -f "$config" ] && grep -q "^wallpaperplugin=$PLASMA_PLUGIN_ID\$" "$config"; then
    kabegame_as_user "$user" sed -i "s/^wallpaperplugin=$PLASMA_PLUGIN_ID\$/wallpaperplugin=org.kde.image/" "$config" ||
      echo "[kabegame] Could not edit $config"
  fi
}

kabegame_remove_plasma_plugin() {
  command -v getent >/dev/null 2>&1 || return 0
  getent passwd | while IFS=: read -r user _ uid _ _ home _; do
    [ "$uid" -ge 1000 ] 2>/dev/null && [ "$uid" -lt 65534 ] || continue
    plugin="$home/.local/share/plasma/wallpapers/$PLASMA_PLUGIN_ID"
    [ -f "$plugin/metadata.json" ] || continue
    grep -q '"X-Kabegame-StreamProtocol"' "$plugin/metadata.json" || continue
    kabegame_reset_plasma_wallpaper "$user" "$uid" "$home" || true
    kabegame_run rm -rf "$plugin"
    echo "[kabegame] Removed the Plasma wallpaper plugin of $user"
  done
}

case "$1" in
  remove|purge)
    echo "[kabegame] Removing the Plasma wallpaper plugin..."
    kabegame_remove_plasma_plugin || true

    echo "[kabegame] Cleaning MIME database..."
    command -v update-mime-database >/dev/null 2>&1 && \
      update-mime-database /usr/share/mime || true

    echo "[kabegame] Cleaning desktop database..."
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database || true

    echo "[kabegame] Cleaning icon cache..."
    command -v gtk-update-icon-cache >/dev/null 2>&1 && \
      gtk-update-icon-cache -f /usr/share/icons/hicolor || true
    ;;
esac

exit 0
