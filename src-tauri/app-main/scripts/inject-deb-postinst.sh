#!/bin/bash
# Script to inject postinst script, daemon binary, and systemd service into generated deb package
# This should be called after Tauri builds the deb package

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POSTINST_SRC="$APP_DIR/deb/postinst.sh"
PRERM_SRC="$APP_DIR/deb/prerm.sh"
SERVICE_SRC="$APP_DIR/deb/kabegame-daemon.service"
BUNDLE_DIR="$APP_DIR/../../target/release/bundle/deb"
SRC_TAURI_DIR="$APP_DIR/.."
DAEMON_BINARY_SRC="$SRC_TAURI_DIR/target/release/kabegame-daemon"
PLASMA_PLUGIN_DIR="$APP_DIR/../../../src-plasma-wallpaper-plugin"

# Check if postinst source exists
if [ ! -f "$POSTINST_SRC" ]; then
    echo "Warning: postinst script not found at $POSTINST_SRC"
    exit 0
fi

# Find deb packages in bundle directory
if [ ! -d "$BUNDLE_DIR" ]; then
    echo "Warning: bundle directory not found at $BUNDLE_DIR"
    exit 0
fi

# Process each deb file
for DEB_FILE in "$BUNDLE_DIR"/*.deb; do
    if [ ! -f "$DEB_FILE" ]; then
        continue
    fi

    echo "Injecting files into deb package: $(basename "$DEB_FILE")"
    
    # Create temporary directory for extracting deb
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf '$TEMP_DIR'" EXIT
    
    # Extract deb package
    dpkg-deb -R "$DEB_FILE" "$TEMP_DIR/extracted"
    
    # Create DEBIAN directory if it doesn't exist
    mkdir -p "$TEMP_DIR/extracted/DEBIAN"
    
    # Copy postinst script
    cp "$POSTINST_SRC" "$TEMP_DIR/extracted/DEBIAN/postinst"
    chmod 755 "$TEMP_DIR/extracted/DEBIAN/postinst"
    
    # Copy prerm script if it exists
    if [ -f "$PRERM_SRC" ]; then
      cp "$PRERM_SRC" "$TEMP_DIR/extracted/DEBIAN/prerm"
      chmod 755 "$TEMP_DIR/extracted/DEBIAN/prerm"
      echo "Added prerm script"
    fi
    
    # Install all binaries to /usr/bin if they exist
    mkdir -p "$TEMP_DIR/extracted/usr/bin"
    
    # Install daemon binary
    if [ -f "$DAEMON_BINARY_SRC" ]; then
        echo "Adding daemon binary to /usr/bin"
        cp "$DAEMON_BINARY_SRC" "$TEMP_DIR/extracted/usr/bin/kabegame-daemon"
        chmod 755 "$TEMP_DIR/extracted/usr/bin/kabegame-daemon"
    else
        echo "Warning: daemon binary not found at $DAEMON_BINARY_SRC (skipping)"
    fi
    
    # Install CLI binaries
    CLI_BINARY_SRC="$SRC_TAURI_DIR/target/release/kabegame-cli"
    if [ -f "$CLI_BINARY_SRC" ]; then
        echo "Adding CLI binary to /usr/bin"
        cp "$CLI_BINARY_SRC" "$TEMP_DIR/extracted/usr/bin/kabegame-cli"
        chmod 755 "$TEMP_DIR/extracted/usr/bin/kabegame-cli"
    else
        echo "Warning: CLI binary not found at $CLI_BINARY_SRC (skipping)"
    fi
    
    # Install plugin-editor binary
    PLUGIN_EDITOR_BINARY_SRC="$SRC_TAURI_DIR/target/release/kabegame-plugin-editor"
    if [ -f "$PLUGIN_EDITOR_BINARY_SRC" ]; then
        echo "Adding plugin-editor binary to /usr/bin"
        cp "$PLUGIN_EDITOR_BINARY_SRC" "$TEMP_DIR/extracted/usr/bin/kabegame-plugin-editor"
        chmod 755 "$TEMP_DIR/extracted/usr/bin/kabegame-plugin-editor"
    else
        echo "Warning: plugin-editor binary not found at $PLUGIN_EDITOR_BINARY_SRC (skipping)"
    fi
    
    # Install systemd service file if it exists
    if [ -f "$SERVICE_SRC" ]; then
        echo "Adding systemd service file"
        # Service file goes to /usr/share/kabegame (template location)
        mkdir -p "$TEMP_DIR/extracted/usr/share/kabegame"
        cp "$SERVICE_SRC" "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-daemon.service"
        chmod 644 "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-daemon.service"
    else
        echo "Warning: systemd service file not found at $SERVICE_SRC (skipping)"
    fi

    # Install MIME type definition and desktop file for .kgpg association
    MIME_SRC="$APP_DIR/deb/kabegame-kgpg.xml"
    DESKTOP_SRC="$APP_DIR/deb/kabegame-kgpg.desktop"
    
    if [ -f "$MIME_SRC" ]; then
        echo "Adding MIME type definition for .kgpg"
        mkdir -p "$TEMP_DIR/extracted/usr/share/kabegame"
        cp "$MIME_SRC" "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-kgpg.xml"
        chmod 644 "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-kgpg.xml"
    else
        echo "Warning: MIME type definition not found at $MIME_SRC (skipping)"
    fi

    if [ -f "$DESKTOP_SRC" ]; then
        echo "Adding desktop file for .kgpg association"
        mkdir -p "$TEMP_DIR/extracted/usr/share/kabegame"
        cp "$DESKTOP_SRC" "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-kgpg.desktop"
        chmod 644 "$TEMP_DIR/extracted/usr/share/kabegame/kabegame-kgpg.desktop"
    else
        echo "Warning: desktop file not found at $DESKTOP_SRC (skipping)"
    fi

    # Install main application desktop file
    MAIN_DESKTOP_SRC="$APP_DIR/deb/kabegame.desktop"
    
    if [ -f "$MAIN_DESKTOP_SRC" ]; then
        echo "Adding main application desktop file"
        mkdir -p "$TEMP_DIR/extracted/usr/share/kabegame"
        cp "$MAIN_DESKTOP_SRC" "$TEMP_DIR/extracted/usr/share/kabegame/kabegame.desktop"
        chmod 644 "$TEMP_DIR/extracted/usr/share/kabegame/kabegame.desktop"
    else
        echo "Warning: main application desktop file not found at $MAIN_DESKTOP_SRC (skipping)"
    fi

    # Build and install Plasma wallpaper plugin (only for Plasma desktop)
    # Check if desktop environment is Plasma via VITE_DESKTOP or RUSTFLAGS
    IS_PLASMA=false
    if [ -n "$VITE_DESKTOP" ] && [ "$VITE_DESKTOP" = "plasma" ]; then
        IS_PLASMA=true
    elif echo "$RUSTFLAGS" | grep -q 'desktop="plasma"'; then
        IS_PLASMA=true
    fi

    if [ "$IS_PLASMA" = "true" ] && [ -d "$PLASMA_PLUGIN_DIR" ]; then
        echo "Building Plasma wallpaper plugin (desktop environment: plasma)..."
        PLASMA_BUILD_DIR="$PLASMA_PLUGIN_DIR/build"
        ORIGINAL_DIR="$(pwd)"
        
        # Build the plugin if not already built
        if [ ! -f "$PLASMA_BUILD_DIR/plugin/libplasma_wallpaper_kabegame.so" ]; then
            echo "Plasma plugin not built, building now..."
            cd "$PLASMA_PLUGIN_DIR"
            mkdir -p "$PLASMA_BUILD_DIR"
            cd "$PLASMA_BUILD_DIR"
            
            # Configure and build (non-interactive, install to staging directory)
            if ! cmake .. \
                -DCMAKE_BUILD_TYPE=Release \
                -DCMAKE_INSTALL_PREFIX="/usr" \
                -DKDE_INSTALL_USE_QT_SYS_PATHS=ON 2>&1; then
                echo "Warning: Failed to configure Plasma plugin (missing dependencies?)"
                echo "Skipping Plasma plugin installation"
                cd "$ORIGINAL_DIR"
            elif ! make -j$(nproc) 2>&1; then
                echo "Warning: Failed to compile Plasma plugin"
                echo "Skipping Plasma plugin installation"
                cd "$ORIGINAL_DIR"
            else
                # Install to staging directory for packaging (will be installed to user dir by postinst)
                # We install to /usr/share/kabegame/plasma-plugin so postinst can copy to user directory
                echo "Installing Plasma plugin to package (temporary location)..."
                PLUGIN_STAGING_DIR="$TEMP_DIR/extracted/usr/share/kabegame/plasma-plugin"
                mkdir -p "$PLUGIN_STAGING_DIR"
                
                # Manually copy plugin files to staging directory
                # The plugin files are installed by make install, but we need to copy them to staging
                # First install normally to get the file structure
                if ! make install DESTDIR="$TEMP_DIR/extracted/plugin-temp" 2>&1; then
                    echo "Warning: Failed to install Plasma plugin (checking structure)..."
                fi
                
                # Copy from temp install location to staging
                if [ -d "$TEMP_DIR/extracted/plugin-temp/usr/share/plasma/wallpapers/org.kabegame.wallpaper" ]; then
                    cp -r "$TEMP_DIR/extracted/plugin-temp/usr/share/plasma/wallpapers/org.kabegame.wallpaper"/* "$PLUGIN_STAGING_DIR/" 2>/dev/null || true
                    rm -rf "$TEMP_DIR/extracted/plugin-temp"
                    echo "Plasma plugin staged for user installation"
                else
                    echo "Warning: Plugin install location not found after make install"
                fi
                cd "$ORIGINAL_DIR"
            fi
        else
            # Plugin already built, install to staging
            echo "Plasma plugin already built, staging for user installation..."
            PLUGIN_STAGING_DIR="$TEMP_DIR/extracted/usr/share/kabegame/plasma-plugin"
            mkdir -p "$PLUGIN_STAGING_DIR"
            
            # Install to temp location first
            if ! make install DESTDIR="$TEMP_DIR/extracted/plugin-temp" 2>&1; then
                echo "Warning: Failed to stage Plasma plugin"
            elif [ -d "$TEMP_DIR/extracted/plugin-temp/usr/share/plasma/wallpapers/org.kabegame.wallpaper" ]; then
                cp -r "$TEMP_DIR/extracted/plugin-temp/usr/share/plasma/wallpapers/org.kabegame.wallpaper"/* "$PLUGIN_STAGING_DIR/" 2>/dev/null || true
                rm -rf "$TEMP_DIR/extracted/plugin-temp"
                echo "Plasma plugin staged for user installation"
            fi
            cd "$ORIGINAL_DIR"
        fi
    fi
    
    # Rebuild deb package
    dpkg-deb -b "$TEMP_DIR/extracted" "$DEB_FILE"
    
    echo "Successfully injected files"
    
    # Cleanup
    rm -rf "$TEMP_DIR"
done

echo "Done injecting files into deb packages"
