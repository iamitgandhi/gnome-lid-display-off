#!/usr/bin/env bash
set -e

echo "========================================================"
echo "  Uninstalling Lid Display Off                          "
echo "========================================================"

EXT_UUID="lid-display-off@amit"

# 1. Stop and disable service
systemctl --user stop lid-display-daemon.service 2>/dev/null || true
systemctl --user disable lid-display-daemon.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/lid-display-daemon.service"
systemctl --user daemon-reload

# 2. Remove script
rm -f "$HOME/.local/bin/lid-display-daemon.py"

# 3. Disable and remove extension
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

# 4. Remove system configurations
if command -v sudo >/dev/null 2>&1; then
    sudo rm -f /etc/systemd/logind.conf.d/logind-lid-inhibitor.conf
    sudo rm -f /etc/systemd/logind.conf.d/lid-display-off.conf
    sudo rm -f /etc/NetworkManager/conf.d/nm-wifi-powersave.conf
    sudo rm -f /etc/NetworkManager/conf.d/wifi-powersave.conf
    sudo systemctl restart systemd-logind 2>/dev/null || true
    sudo nmcli general reload 2>/dev/null || true
fi

# 5. Restore default GNOME power actions
gsettings reset org.gnome.settings-daemon.plugins.power lid-close-battery-action 2>/dev/null || true
gsettings reset org.gnome.settings-daemon.plugins.power lid-close-ac-action 2>/dev/null || true
gsettings reset org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 2>/dev/null || true

echo "========================================================"
echo "  Uninstall Complete. Restored original power settings. "
echo "========================================================"
