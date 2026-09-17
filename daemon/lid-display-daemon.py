#!/usr/bin/env python3
"""
Lid Display Off Daemon
----------------------
Maintains system awake while turning off the screen (DPMS + hardware backlight)
when the laptop lid is closed.

Features:
- Prevents system suspend via logind inhibitor
- Sets Mutter PowerSaveMode = 3 (DPMS off)
- Clamps physical backlight to 0 (keeps laptop screen dark even during remote desktop)
- Restores original brightness and display power when lid is opened
- Syncs with the GNOME Quick Settings toggle
"""

import os
import sys
import signal
import gi
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib

POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power'
EXT_SCHEMA_DIR = os.path.expanduser('~/.local/share/gnome-shell/extensions/lid-display-off@amit/schemas')
EXT_SCHEMA_ID = 'org.gnome.shell.extensions.lid-display-off'


class LidDisplayDaemon:
    def __init__(self):
        self.session_bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.system_bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)

        # Power settings (GNOME level)
        self.power_settings = Gio.Settings.new(POWER_SCHEMA)

        # Extension settings
        schema_source = Gio.SettingsSchemaSource.new_from_directory(
            EXT_SCHEMA_DIR,
            Gio.SettingsSchemaSource.get_default(),
            False
        )
        schema = schema_source.lookup(EXT_SCHEMA_ID, False)
        self.ext_settings = Gio.Settings.new_full(schema, None, None)

        self.inhibit_fd = -1
        self.is_closed = False
        self.saved_brightness = {}
        self.backlight_timer_id = 0

        # Save initial brightness
        self._save_brightness()

        # Connect GSettings changed listener
        self.ext_settings.connect('changed::enabled', self._on_enabled_changed)

        # Connect UPower proxy
        self._setup_upower()

        # Connect login1 proxy
        self._setup_login1()

        # Apply current state
        self._on_enabled_changed()

    def _find_backlight_devices(self):
        devices = []
        base = '/sys/class/backlight'
        if os.path.exists(base):
            for entry in os.listdir(base):
                b_path = os.path.join(base, entry, 'brightness')
                if os.path.exists(b_path) and os.access(b_path, os.W_OK):
                    devices.append(b_path)
        return devices

    def _save_brightness(self):
        for b_path in self._find_backlight_devices():
            try:
                with open(b_path, 'r') as f:
                    val = f.read().strip()
                if val and int(val) > 0:
                    self.saved_brightness[b_path] = val
            except Exception as e:
                print(f"[LidDaemon] Error reading {b_path}: {e}", file=sys.stderr)

    def _set_backlight_zero(self):
        self._save_brightness()
        for b_path in self._find_backlight_devices():
            try:
                with open(b_path, 'w') as f:
                    f.write('0')
                print(f"[LidDaemon] Backlight set to 0 for {b_path}")
            except Exception as e:
                print(f"[LidDaemon] Error setting {b_path} to 0: {e}", file=sys.stderr)

    def _restore_backlight(self):
        for b_path in self._find_backlight_devices():
            val = self.saved_brightness.get(b_path)
            if not val:
                max_path = os.path.join(os.path.dirname(b_path), 'max_brightness')
                try:
                    with open(max_path, 'r') as f:
                        val = f.read().strip()
                except Exception:
                    val = '400'
            try:
                with open(b_path, 'w') as f:
                    f.write(str(val))
                print(f"[LidDaemon] Restored {b_path} brightness to {val}")
            except Exception as e:
                print(f"[LidDaemon] Error restoring {b_path}: {e}", file=sys.stderr)

    def _backlight_watchdog(self):
        """Keeps physical backlight at 0 while lid is closed, even if Remote Desktop wakes Mutter"""
        if not self.is_closed or not self.ext_settings.get_boolean('enabled'):
            self.backlight_timer_id = 0
            return GLib.SOURCE_REMOVE

        for b_path in self._find_backlight_devices():
            try:
                with open(b_path, 'r') as f:
                    cur = f.read().strip()
                if cur and int(cur) > 0:
                    print(f"[LidDaemon] Backlight woke up ({cur}) while lid closed (Remote Desktop active) -> Clamping to 0")
                    self.saved_brightness[b_path] = cur
                    with open(b_path, 'w') as f:
                        f.write('0')
            except Exception:
                pass
        return GLib.SOURCE_CONTINUE

    def _setup_upower(self):
        try:
            self.upower_proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                None,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.UPower',
                None
            )
            self.upower_proxy.connect('g-properties-changed', self._on_upower_changed)
            prop = self.upower_proxy.get_cached_property('LidIsClosed')
            if prop is not None:
                self.is_closed = prop.get_boolean()
        except Exception as e:
            print(f"[LidDaemon] UPower setup error: {e}", file=sys.stderr)

    def _setup_login1(self):
        try:
            self.login1_proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                None,
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                None
            )
            self.login1_proxy.connect('g-properties-changed', self._on_login1_changed)
            prop = self.login1_proxy.get_cached_property('LidClosed')
            if prop is not None:
                self.is_closed = self.is_closed or prop.get_boolean()
        except Exception as e:
            print(f"[LidDaemon] login1 setup error: {e}", file=sys.stderr)

    def _on_upower_changed(self, proxy, changed, invalidated):
        val = changed.lookup_value('LidIsClosed', None)
        if val is not None:
            self._handle_lid_state(val.get_boolean(), source="UPower")

    def _on_login1_changed(self, proxy, changed, invalidated):
        val = changed.lookup_value('LidClosed', None)
        if val is not None:
            self._handle_lid_state(val.get_boolean(), source="login1")

    def _handle_lid_state(self, is_closed, source="unknown"):
        print(f"[LidDaemon] Lid event from {source}: closed={is_closed}")
        self.is_closed = is_closed

        if not self.ext_settings.get_boolean('enabled'):
            return

        if is_closed:
            print("[LidDaemon] Lid closed -> Turning OFF display (DPMS 3 + Backlight 0) & Locking")
            # 1. Turn off screen hardware / backlight immediately
            self._set_backlight_zero()
            self._set_display_power(False)
            self._lock_screen()

            # 2. Start watchdog to keep backlight at 0 even if Remote Desktop connects
            if self.backlight_timer_id == 0:
                self.backlight_timer_id = GLib.timeout_add(300, self._backlight_watchdog)
        else:
            print("[LidDaemon] Lid opened -> Turning ON display (PowerSaveMode 0 + Backlight restored)")
            # Stop watchdog
            if self.backlight_timer_id != 0:
                GLib.source_remove(self.backlight_timer_id)
                self.backlight_timer_id = 0

            # Restore display and backlight
            self._set_display_power(True)
            self._restore_backlight()

    def _set_display_power(self, power_on):
        """Sets Mutter PowerSaveMode: 0 = ON, 3 = OFF"""
        mode = 0 if power_on else 3
        try:
            self.session_bus.call_sync(
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig',
                'org.freedesktop.DBus.Properties',
                'Set',
                GLib.Variant(
                    '(ssv)',
                    ('org.gnome.Mutter.DisplayConfig', 'PowerSaveMode', GLib.Variant('i', mode))
                ),
                None,
                Gio.DBusCallFlags.NONE,
                2000,
                None
            )
            print(f"[LidDaemon] PowerSaveMode set to {mode}")
        except Exception as e:
            print(f"[LidDaemon] Error setting PowerSaveMode: {e}", file=sys.stderr)

    def _lock_screen(self):
        try:
            self.session_bus.call_sync(
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                'SetActive',
                GLib.Variant('(b)', (True,)),
                None,
                Gio.DBusCallFlags.NONE,
                2000,
                None
            )
            print("[LidDaemon] ScreenSaver SetActive(True)")
        except Exception as e:
            print(f"[LidDaemon] Error locking screensaver: {e}", file=sys.stderr)

    def _take_inhibitor(self):
        if self.inhibit_fd >= 0:
            return

        try:
            res, fd_list = self.system_bus.call_with_unix_fd_list_sync(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'Inhibit',
                GLib.Variant(
                    '(ssss)',
                    (
                        'handle-lid-switch',
                        'Lid Display Off',
                        'User requested lid-close to only blank the display',
                        'block'
                    )
                ),
                GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                -1,
                None,
                None
            )
            if fd_list and fd_list.get_length() > 0:
                self.inhibit_fd = fd_list.get(0)
                print(f"[LidDaemon] Acquired handle-lid-switch inhibitor fd: {self.inhibit_fd}")
        except Exception as e:
            print(f"[LidDaemon] Failed to take inhibitor: {e}", file=sys.stderr)

    def _release_inhibitor(self):
        if self.inhibit_fd >= 0:
            try:
                os.close(self.inhibit_fd)
                print(f"[LidDaemon] Released inhibitor fd: {self.inhibit_fd}")
            except Exception as e:
                print(f"[LidDaemon] Error closing inhibitor fd: {e}", file=sys.stderr)
            self.inhibit_fd = -1

    def _on_enabled_changed(self, *args):
        enabled = self.ext_settings.get_boolean('enabled')
        print(f"[LidDaemon] Feature enabled: {enabled}")

        if enabled:
            # Save originals
            if not self.ext_settings.get_string('original-ac-action'):
                self.ext_settings.set_string(
                    'original-ac-action',
                    self.power_settings.get_string('lid-close-ac-action')
                )
            if not self.ext_settings.get_string('original-battery-action'):
                self.ext_settings.set_string(
                    'original-battery-action',
                    self.power_settings.get_string('lid-close-battery-action')
                )

            # Override GNOME power
            self.power_settings.set_string('lid-close-ac-action', 'nothing')
            self.power_settings.set_string('lid-close-battery-action', 'nothing')

            # Acquire systemd inhibitor
            self._take_inhibitor()

            # If lid is already closed right now, turn off display
            if self.is_closed:
                self._handle_lid_state(True, "init")
        else:
            if self.backlight_timer_id != 0:
                GLib.source_remove(self.backlight_timer_id)
                self.backlight_timer_id = 0
            self._release_inhibitor()
            self._restore_original_actions()
            self._set_display_power(True)
            self._restore_backlight()

    def _restore_original_actions(self):
        orig_ac = self.ext_settings.get_string('original-ac-action')
        orig_bat = self.ext_settings.get_string('original-battery-action')

        if orig_ac:
            self.power_settings.set_string('lid-close-ac-action', orig_ac)
            self.ext_settings.set_string('original-ac-action', '')
        if orig_bat:
            self.power_settings.set_string('lid-close-battery-action', orig_bat)
            self.ext_settings.set_string('original-battery-action', '')
        print("[LidDaemon] Restored original power actions")

    def cleanup(self):
        print("[LidDaemon] Cleaning up...")
        if self.backlight_timer_id != 0:
            GLib.source_remove(self.backlight_timer_id)
            self.backlight_timer_id = 0
        self._set_display_power(True)
        self._restore_backlight()
        self._release_inhibitor()
        self._restore_original_actions()


def main():
    daemon = LidDisplayDaemon()

    loop = GLib.MainLoop()

    def handle_signal(sig, frame):
        print(f"[LidDaemon] Caught signal {sig}, exiting...")
        daemon.cleanup()
        loop.quit()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print("[LidDaemon] Running event loop with backlight control...")
    loop.run()


if __name__ == '__main__':
    main()
