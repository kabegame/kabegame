#!/bin/sh
set -e

# Kabegame prerm script
# This script runs before the package is removed or upgraded

# Only run on remove or upgrade
if [ "$1" = "remove" ] || [ "$1" = "upgrade" ]; then
  # Stop and disable systemd service
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet kabegame-daemon.service 2>/dev/null; then
      echo "停止 kabegame-daemon 服务..."
      systemctl stop kabegame-daemon.service || true
    fi
    
    if systemctl is-enabled --quiet kabegame-daemon.service 2>/dev/null; then
      echo "禁用 kabegame-daemon 服务..."
      systemctl disable kabegame-daemon.service || true
    fi
    
    # Reload systemd daemon
    systemctl daemon-reload || true
  fi

  # Clean up .kgpg file association (update databases after files are removed)
  # Note: Files will be removed by package manager, we just need to update databases
  if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
  fi
  
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
  fi
fi

exit 0
