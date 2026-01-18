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

  # Check and install Plasma wallpaper plugin to user directory
  # The plugin is staged in /usr/share/kabegame/plasma-plugin by inject-deb-postinst.sh
  # We install it to ~/.local/share/plasma/wallpapers/org.kabegame.wallpaper
  PLUGIN_STAGING_DIR="/usr/share/kabegame/plasma-plugin"
  
  if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ]; then
    USER_HOME="/home/$INSTALL_USER"
    USER_PLUGIN_DIR="$USER_HOME/.local/share/plasma/wallpapers/org.kabegame.wallpaper"
    
    # Check if plugin already exists in user directory (from Plasma Addons store)
    if [ -d "$USER_PLUGIN_DIR" ] && [ -f "$USER_PLUGIN_DIR/metadata.json" ]; then
      echo "检测到 Plasma 壁纸插件（用户已安装，通过 Plasma Addons）"
      PLUGIN_INSTALLED=true
    fi
    
    # Install plugin from package to user directory
    if [ -d "$PLUGIN_STAGING_DIR" ] && [ -f "$PLUGIN_STAGING_DIR/metadata.json" ]; then
      echo "安装 Plasma 壁纸插件到用户目录..."
      
      # Create target directory
      mkdir -p "$USER_PLUGIN_DIR"
      
      # Copy plugin files (preserve ownership for user)
      cp -r "$PLUGIN_STAGING_DIR"/* "$USER_PLUGIN_DIR/" 2>/dev/null || true
      
      # Set correct ownership and permissions
      if command -v chown >/dev/null 2>&1; then
        chown -R "$INSTALL_USER:$INSTALL_USER" "$USER_PLUGIN_DIR" 2>/dev/null || true
      fi
      chmod -R u+rwX,go+rX "$USER_PLUGIN_DIR" 2>/dev/null || true
      
      echo "Plasma 壁纸插件已安装到用户目录"
      PLUGIN_INSTALLED=true
    fi
    
    # Refresh Plasma plugin cache if plugin is installed
    if [ "$PLUGIN_INSTALLED" = "true" ]; then
      echo "刷新 Plasma 插件缓存..."
      # Run as the installing user to ensure proper permissions
      if [ -n "$INSTALL_USER" ]; then
        # Plasma 5: kbuildsycoca5
        if command -v kbuildsycoca5 >/dev/null 2>&1; then
          su - "$INSTALL_USER" -c "kbuildsycoca5 --noincremental" 2>/dev/null || true
        fi
        # Plasma 6: kbuildsycoca6
        if command -v kbuildsycoca6 >/dev/null 2>&1; then
          su - "$INSTALL_USER" -c "kbuildsycoca6 --noincremental" 2>/dev/null || true
        fi
      fi
      
      echo ""
      echo "Plasma 壁纸插件已可用。要使用插件，请："
    echo "  1. 右键点击桌面 → 配置桌面和壁纸"
    echo "  2. 在壁纸类型中选择 'Kabegame 壁纸'"
    echo "  3. 如需重启 Plasma Shell，请运行："
    echo "     kquitapp5 plasmashell && kstart5 plasmashell"
    elif [ ! -d "$PLUGIN_STAGING_DIR" ]; then
      # Plugin not found in package (might be non-Plasma build or plugin build failed)
      echo "注意: Plasma 壁纸插件未包含在此 deb 包中"
      echo "这可能是因为："
      echo "  1. 构建时未检测到 Plasma 环境"
      echo "  2. 缺少编译插件的依赖"
      echo ""
      echo "您可以："
      echo "  1. 通过 Plasma Addons 商店安装插件（推荐）"
      echo "  2. 或从源码手动编译安装"
    fi
  else
    # No valid user detected, can't install to user directory
    if [ -d "$PLUGIN_STAGING_DIR" ]; then
      echo "注意: 检测到 Plasma 壁纸插件，但无法确定安装用户"
      echo "插件已包含在包中，但需要手动安装到用户目录："
      echo "  cp -r $PLUGIN_STAGING_DIR ~/.local/share/plasma/wallpapers/org.kabegame.wallpaper"
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
