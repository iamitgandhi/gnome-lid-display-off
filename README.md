# GNOME Lid Display Off & Headless Remote Desktop

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-46%20%7C%2047%20%7C%2048%20%7C%2049%20%7C%2050-blue.svg)](https://www.gnome.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Ubuntu-orange.svg)](https://ubuntu.com)

A complete solution for laptops running GNOME on Wayland or X11 to **keep running continuously with the lid closed**, **turn off the display completely** (saving battery and heat), and provide **seamless remote desktop control from mobile devices with zero screen light-leak**.

---

## 🚀 The Problem This Solves

By default on Linux laptops:
1. **Closing the lid suspends the system** — even if you set GNOME power settings to "do nothing", `systemd-logind` often suspends the laptop anyway due to system-level defaults.
2. **Screens don't actually turn off** — when suspend is disabled, the screen/backlight often stays powered on while closed, wasting battery and creating heat trapped against the keyboard.
3. **Remote Desktop wakes up the physical screen** — connecting from a phone via RDP or VNC forces the display compositor to wake up, lighting up the physical laptop screen in your room while the lid is closed.
4. **Wi-Fi disconnects on idle** — aggressive Wi-Fi power-saving causes brief connection drops when the user session is locked or idle, killing WebSocket connections (e.g. Fiverr, Slack, Discord, SSH).

**This project solves all of these problems out of the box.**

---

## ✨ Features

- **Quick Settings Toggle**: A native "Lid Off" button directly in the GNOME Shell top panel to toggle the feature on or off.
- **Hardware Backlight & DPMS Control**:
  - Sets Mutter `PowerSaveMode = 3` (cuts display power).
  - Directly sets `/sys/class/backlight/*/brightness` to `0` (pitch-black screen, no backlight bleed).
  - Restores your exact original brightness when you open the lid.
- **Headless Remote Desktop Optimization**:
  - When accessing your laptop from a smartphone or tablet (via GNOME RDP), the GPU renders the virtual stream cleanly while the **physical laptop screen remains 100% dark**.
- **Continuous Online Status**:
  - Takes a systemd-logind `handle-lid-switch` inhibitor in `block` mode.
  - Disables Wi-Fi power save mode (`powersave = 2`) so connections never drop.
  - Disables battery idle suspend timeouts.
- **Zero Configuration**: Single 1-click installer and clean uninstaller scripts.

---

## 🛠️ Requirements

- **Operating System**: Ubuntu 24.04 LTS, 24.10, 25.04, 26.04 LTS (or other systemd-based Linux distributions).
- **Desktop Environment**: GNOME Shell 46, 47, 48, 49, or 50 (Wayland or X11).
- **Dependencies**: `python3`, `python3-gi`, `systemd`, `NetworkManager`.

---

## 📦 Installation

Clone the repository and run the installer:

```bash
git clone https://github.com/iamitgandhi/gnome-lid-display-off.git
cd gnome-lid-display-off
chmod +x install.sh
./install.sh
```

The script will automatically:
1. Copy and enable the GNOME Shell extension.
2. Compile GSettings schemas.
3. Install and activate the background daemon as a user systemd service (`lid-display-daemon.service`).
4. Configure `/etc/systemd/logind.conf.d/` to respect lid inhibitors.
5. Disable Wi-Fi power saving in NetworkManager.

> **Note**: A session logout and login may be required once for GNOME Shell on Wayland to first register the top panel extension toggle.

---

## 📱 Mobile Remote Access (Phone Setup)

You can view and control your laptop remotely while the lid stays shut:

### 1. Enable Built-in Desktop Sharing on your Laptop
1. Open **GNOME Settings** → **System** → **Remote Desktop** (or **Desktop Sharing**).
2. Toggle **Desktop Sharing** → **ON**.
3. Toggle **Remote Control** → **ON**.
4. Note your **Username** and **Password**.

### 2. Connect from your Phone
1. Install **Windows App** (formerly **Microsoft Remote Desktop**):
   - [Google Play Store (Android)](https://play.google.com/store/apps/details?id=com.microsoft.rdc.androidx)
   - [Apple App Store (iOS)](https://apps.apple.com/app/windows-app-mobile/id714464092)
2. Tap **`+`** → **Add PC**.
3. Enter your laptop's local IP address (e.g., `192.168.1.x`).
4. Enter your configured Remote Desktop username and password.
5. Connect! Your phone will display your desktop while your laptop screen stays completely dark.

---

## ⚙️ How It Works (Architecture)

```
                       ┌───────────────────────────────────────────┐
                       │  GNOME Shell Quick Settings: "Lid Off"    │
                       └─────────────────────┬─────────────────────┘
                                             │
                                     GSettings Sync
                                             │
                                             ▼
       ┌────────────────────────────────────────────────────────────────────────┐
       │                 lid-display-daemon.py (systemd user)                   │
       ├────────────────────────────────────────────────────────────────────────┤
       │ 1. Holds systemd-logind 'handle-lid-switch' inhibitor lock             │
       │ 2. Monitors UPower & login1 D-Bus for LidClosed events                 │
       │ 3. On Lid Close:                                                       │
       │    ├── Sets Mutter DPMS PowerSaveMode = 3 (display off)                │
       │    ├── Clamps /sys/class/backlight/*/brightness to 0                   │
       │    └── Runs 300ms watchdog (keeps screen dark during RDP connections)  │
       │ 4. On Lid Open:                                                        │
       │    ├── Sets Mutter PowerSaveMode = 0 (display on)                      │
       │    └── Restores original backlight brightness                          │
       └────────────────────────────────────────────────────────────────────────┘
```

---

## 🗑️ Uninstallation

To remove the extension, daemon, and restore default system configurations:

```bash
cd gnome-lid-display-off
./uninstall.sh
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
