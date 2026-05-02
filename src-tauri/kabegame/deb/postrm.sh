#!/bin/sh
set -e

case "$1" in
  remove|purge)
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

# purge：额外清理用户数据目录
# （apt remove 只删程序文件；apt purge 才彻底移除配置和数据）
if [ "$1" = "purge" ]; then
    DATA_DIR="${HOME}/.local/share/com.kabegame"
    CONFIG_DIR="${HOME}/.config/com.kabegame"
    CACHE_DIR="${HOME}/.cache/com.kabegame"
    for d in "$DATA_DIR" "$CONFIG_DIR" "$CACHE_DIR"; do
        if [ -d "$d" ]; then
            rm -rf "$d"
            echo "[kabegame] Removed: $d"
        fi
    done
fi

exit 0
