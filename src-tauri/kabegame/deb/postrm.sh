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

exit 0
