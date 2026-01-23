#!/bin/sh
set -e

# Kabegame postinst script
# This script runs after the package is installed/upgraded

# Define the group name
GROUP="fuse"

# Only run on configure (install or upgrade)
if [ "$1" = "configure" ]; then
  # Check if fuse group exists, create if not (should already exist from fuse3 package)
  if ! getent group "$GROUP" >/dev/null 2>&1; then
    if command -v groupadd >/dev/null 2>&1; then
      groupadd --system "$GROUP" || true
    fi
  fi

  # Try to detect the installing user
  # Priority: SUDO_USER > LOGNAME > USER > who am i
  INSTALL_USER=""
  if [ -n "$SUDO_USER" ]; then
    INSTALL_USER="$SUDO_USER"
  elif [ -n "$LOGNAME" ]; then
    INSTALL_USER="$LOGNAME"
  elif [ -n "$USER" ] && [ "$USER" != "root" ]; then
    INSTALL_USER="$USER"
  else
    # Try to get the real user from who
    INSTALL_USER=$(who am i | awk '{print $1}' 2>/dev/null || echo "")
  fi

  # Add user to fuse group if we found a valid user
  if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ]; then
    if id "$INSTALL_USER" >/dev/null 2>&1; then
      # Check if user is already in the group
      if ! groups "$INSTALL_USER" | grep -q "\b$GROUP\b"; then
        if command -v usermod >/dev/null 2>&1; then
          usermod -aG "$GROUP" "$INSTALL_USER" 2>/dev/null || true
        elif command -v adduser >/dev/null 2>&1; then
          adduser "$INSTALL_USER" "$GROUP" 2>/dev/null || true
        fi
      fi
    fi
  fi

  # Install and enable systemd service for daemon
  DAEMON_SERVICE_SRC="/usr/share/kabegame/kabegame-daemon.service"
  DAEMON_SERVICE_DST="/etc/systemd/system/kabegame-daemon.service"
  
  if [ -f "$DAEMON_SERVICE_SRC" ]; then
    echo "安装 systemd 服务..."
    cp "$DAEMON_SERVICE_SRC" "$DAEMON_SERVICE_DST"
    chmod 644 "$DAEMON_SERVICE_DST"
    systemctl daemon-reload || true
    
    # Enable and start service automatically
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable kabegame-daemon.service || true
      systemctl start kabegame-daemon.service || true
      echo "Daemon 服务已启用并自动启动"
    fi
  fi

  # Register .kgpg file association
  MIME_SRC="/usr/share/kabegame/kabegame-kgpg.xml"
  MIME_DST="/usr/share/mime/packages/kabegame-kgpg.xml"
  DESKTOP_SRC="/usr/share/kabegame/kabegame-kgpg.desktop"
  DESKTOP_DST="/usr/share/applications/kabegame-kgpg.desktop"

  if [ -f "$MIME_SRC" ]; then
    echo "注册 .kgpg 文件关联..."
    mkdir -p /usr/share/mime/packages
    cp "$MIME_SRC" "$MIME_DST"
    chmod 644 "$MIME_DST"
    
    # Update MIME database
    if command -v update-mime-database >/dev/null 2>&1; then
      update-mime-database /usr/share/mime || true
    fi
  fi

  if [ -f "$DESKTOP_SRC" ]; then
    mkdir -p /usr/share/applications
    cp "$DESKTOP_SRC" "$DESKTOP_DST"
    chmod 644 "$DESKTOP_DST"
    
    # Update desktop database
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database /usr/share/applications || true
    fi
  fi

  # Install main application desktop file
  MAIN_DESKTOP_SRC="/usr/share/kabegame/kabegame.desktop"
  MAIN_DESKTOP_DST="/usr/share/applications/kabegame.desktop"

  if [ -f "$MAIN_DESKTOP_SRC" ]; then
    echo "安装主应用 desktop 文件..."
    mkdir -p /usr/share/applications
    cp "$MAIN_DESKTOP_SRC" "$MAIN_DESKTOP_DST"
    chmod 644 "$MAIN_DESKTOP_DST"
    
    # Update desktop database
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database /usr/share/applications || true
    fi
  fi

  # Display a message to inform the user
  echo ""
  echo "========================================================================"
  echo "Kabegame 已安装完成"
  echo "========================================================================"
  echo ""
  echo "提示：要使用虚拟磁盘功能，您需要属于 'fuse' 组。"
  if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ]; then
    echo "已尝试将用户 '$INSTALL_USER' 添加到 'fuse' 组。"
  else
    echo "请手动将您的用户添加到 'fuse' 组："
    echo "  sudo usermod -aG fuse \$USER"
  fi
  echo ""
  echo "添加组后，请注销并重新登录以使更改生效。"
  echo ""
  echo "Daemon 服务已安装并自动启动。"
  echo "要查看服务状态，请运行："
  echo "  sudo systemctl status kabegame-daemon"
  echo ""
  echo "========================================================================"
  echo ""
fi

exit 0
