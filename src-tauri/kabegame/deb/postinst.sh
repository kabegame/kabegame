#!/bin/sh
set -e

case "$1" in
  configure)
    echo "[kabegame] Updating MIME database..."
    command -v update-mime-database >/dev/null 2>&1 && \
      update-mime-database /usr/share/mime || true

    echo "[kabegame] Updating desktop database..."
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database || true

    echo "[kabegame] Updating icon cache..."
    command -v gtk-update-icon-cache >/dev/null 2>&1 && \
      gtk-update-icon-cache -f /usr/share/icons/hicolor || true

    # Try to refresh common file managers for immediate effect
    killall -q dolphin nautilus nemo caja pcmanfm 2>/dev/null || true
    ;;
esac

exit 0
