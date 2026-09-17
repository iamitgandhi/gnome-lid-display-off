#!/usr/bin/env bash
set -e

# ==============================================================================
# Lid Display Off - Automated Installer
# ==============================================================================

echo "========================================================"
echo "  Installing Lid Display Off & Remote Optimization      "
echo "========================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="lid-display-off@amit"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
BIN_DEST="$HOME/.local/bin"
SYSTEMD_USER_DEST="$HOME/.config/systemd/user"

# 1. Install Extension
echo "[1/6] Installing GNOME Shell Extension..."
mkdir -p "$EXT_DEST/schemas"
cp -r "$SCRIPT_DIR/extension/metadata.json" "$EXT_DEST/"
cp -r "$SCRIPT_DIR/extension/extension.js" "$EXT_DEST/"
cp -r "$SCRIPT_DIR/extension/schemas/"* "$EXT_DEST/schemas/"

echo "[2/6] Compiling GSettings schemas..."
glib-compile-schemas "$EXT_DEST/schemas"

# 2. Install Daemon
echo "[3/6] Installing background daemon..."
mkdir -p "$BIN_DEST"
cp "$SCRIPT_DIR/daemon/lid-display-daemon.py" "$BIN_DEST/"
chmod +x "$BIN_DEST/lid-display-daemon.py"

# 3. Install User Systemd Service
echo "[4/6] Setting up systemd user service..."
mkdir -p "$SYSTEMD_USER_DEST"
sed "s|/home/amit|$HOME|g" "$SCRIPT_DIR/daemon/lid-display-daemon.service" > "$SYSTEMD_USER_DEST/lid-display-daemon.service"

systemctl --user daemon-reload
systemctl --user enable lid-display-daemon.service
systemctl --user restart lid-display-daemon.service

# 4. System level configs (requires sudo)
echo "[5/6] Applying system-level power & network optimizations..."
if command -v sudo >/dev/null 2>&1; then
    # Logind inhibitor respect
    sudo mkdir -p /etc/systemd/logind.conf.d
    sudo cp "$SCRIPT_DIR/system-configs/logind-lid-inhibitor.conf" /etc/systemd/logind.conf.d/
    sudo systemctl restart systemd-logind 2>/dev/null || true

    # Disable Wi-Fi power save to prevent drops while lid is closed
    sudo mkdir -p /etc/NetworkManager/conf.d
    sudo cp "$SCRIPT_DIR/system-configs/nm-wifi-powersave.conf" /etc/NetworkManager/conf.d/
    sudo nmcli general reload 2>/dev/null || true
    if command -v iw >/dev/null 2>&1; then
        WLAN_IFACE=$(iw dev | awk '$1=="Interface"{print $2}' | head -n1)
        if [ -n "$WLAN_IFACE" ]; then
            sudo iw dev "$WLAN_IFACE" set power_save off 2>/dev/null || true
        fi
    fi
else
    echo "Warning: sudo not available, skipping /etc system configurations."
fi

# 5. GNOME power settings
echo "[6/6] Configuring GNOME settings..."
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power lid-close-battery-action 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power lid-close-ac-action 'nothing'

# Enable extension in GNOME
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo "========================================================"
echo "  Installation Complete!                                "
echo "  - Quick Settings toggle: 'Lid Off' in top-right panel "
echo "  - Background daemon: active via systemd --user        "
echo "  - Remote Desktop & screen power off: fully configured "
echo "========================================================"
