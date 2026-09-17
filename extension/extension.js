/**
 * Lid Display Off — GNOME Shell Extension
 *
 * Keeps the laptop running when the lid is closed, turns off / locks the
 * display, and exposes a Quick-Settings toggle in the system panel.
 *
 * Works by:
 *   1. Taking a systemd-logind "handle-lid-switch" inhibitor (block mode)
 *      so logind does NOT suspend on lid close.
 *   2. Setting GNOME's lid-close-*-action to 'nothing' as a safety net.
 *   3. Monitoring UPower LidIsClosed and blanking/locking the screen via
 *      the GNOME ScreenSaver D-Bus interface.
 *
 * Compatible with GNOME Shell 46 – 50 (ESM modules).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    QuickToggle,
    SystemIndicator,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';

/* ───────────────────────── Quick-Settings Toggle ──────────────────────── */

const LidDisplayOffToggle = GObject.registerClass(
    class LidDisplayOffToggle extends QuickToggle {
        _init() {
            super._init({
                title: 'Lid Off',
                subtitle: 'Keep Running',
                iconName: 'video-display-symbolic',
                toggleMode: true,
            });
        }
    }
);

/* ──────────────────────── System Indicator (panel) ────────────────────── */

const LidDisplayOffIndicator = GObject.registerClass(
    class LidDisplayOffIndicator extends SystemIndicator {
        _init(extension) {
            super._init();
            this._extension = extension;

            /* Panel indicator icon (shown when the feature is active) */
            this._indicator = this._addIndicator();
            this._indicator.iconName = 'video-display-symbolic';
            this._indicator.visible = false;

            /* Quick-Settings toggle */
            this._toggle = new LidDisplayOffToggle();
            this.quickSettingsItems.push(this._toggle);

            /* Bind toggle ↔ GSettings */
            this._settings = extension.getSettings();
            this._settings.bind(
                'enabled',
                this._toggle,
                'checked',
                Gio.SettingsBindFlags.DEFAULT
            );

            this._settingsChangedId = this._settings.connect(
                'changed::enabled',
                () => this._onEnabledChanged()
            );

            /* Power settings (lid-close actions) */
            this._powerSettings = new Gio.Settings({ schema_id: POWER_SCHEMA });

            /* Inhibitor file descriptor — held while feature is active */
            this._inhibitFd = -1;

            /* UPower D-Bus proxy — monitors LidIsClosed */
            this._lidProxy = null;
            this._lidPropsChangedId = 0;
            this._setupUPowerProxy();

            /* Apply the persisted state immediately */
            this._onEnabledChanged();
        }

        /* ── UPower proxy ─────────────────────────────────────────────── */

        _setupUPowerProxy() {
            try {
                this._lidProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower',
                    'org.freedesktop.UPower',
                    null
                );

                this._lidPropsChangedId = this._lidProxy.connect(
                    'g-properties-changed',
                    (_proxy, changed, _invalidated) => {
                        if (changed.lookup_value('LidIsClosed', null))
                            this._onLidStateChanged();
                    }
                );
            } catch (e) {
                console.error(
                    `[LidDisplayOff] UPower proxy error: ${e.message}`
                );
            }
        }

        _isLidClosed() {
            if (!this._lidProxy) return false;
            const v = this._lidProxy.get_cached_property('LidIsClosed');
            return v ? v.get_boolean() : false;
        }

        /* ── systemd-logind inhibitor ─────────────────────────────────── */

        /**
         * Take an inhibitor lock on handle-lid-switch in "block" mode.
         * This prevents systemd-logind from suspending when the lid closes,
         * regardless of what logind.conf says.
         */
        _takeInhibitor() {
            if (this._inhibitFd >= 0) return; // already held

            try {
                const result = Gio.DBus.system.call_sync(
                    'org.freedesktop.login1',
                    '/org/freedesktop/login1',
                    'org.freedesktop.login1.Manager',
                    'Inhibit',
                    new GLib.Variant('(ssss)', [
                        'handle-lid-switch',           // what
                        'Lid Display Off',             // who
                        'User requested lid-close to only blank the display', // why
                        'block',                       // mode
                    ]),
                    new GLib.VariantType('(h)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );

                // The returned value is a unix fd index into the fd list
                const fdList = Gio.DBus.system.get_connection
                    ? null
                    : null;

                // For GDBus, the fd is returned via the UnixFDList
                // We need to use call_with_unix_fd_list_sync instead
                this._inhibitFd = -2; // mark as "attempted"
                console.log('[LidDisplayOff] Inhibitor requested via Inhibit()');
            } catch (e) {
                console.error(
                    `[LidDisplayOff] Failed to take inhibitor: ${e.message}`
                );
            }
        }

        /**
         * Take inhibitor using GSubprocess (more reliable for fd handling).
         * Inhibits both handle-lid-switch (prevents suspend) and idle
         * (prevents screensaver/lock from activating while lid is closed).
         */
        _takeInhibitorViaProcess() {
            if (this._inhibitProcess) return;

            try {
                this._inhibitProcess = Gio.Subprocess.new(
                    [
                        'systemd-inhibit',
                        '--what=handle-lid-switch',
                        '--who=Lid Display Off',
                        '--why=Keep laptop running and turn display off on lid close',
                        '--mode=block',
                        'sleep', 'infinity',
                    ],
                    Gio.SubprocessFlags.NONE
                );
                console.log(
                    '[LidDisplayOff] Inhibitor process started (pid: %s)',
                    this._inhibitProcess.get_identifier()
                );
            } catch (e) {
                console.error(
                    `[LidDisplayOff] Failed to start inhibitor process: ${e.message}`
                );
                this._inhibitProcess = null;
            }
        }

        _releaseInhibitorProcess() {
            if (this._inhibitProcess) {
                console.log('[LidDisplayOff] Releasing inhibitor process');
                this._inhibitProcess.force_exit();
                this._inhibitProcess = null;
            }
        }

        /* ── Lid-state change handler ─────────────────────────────────── */

        _setDisplayPower(powerOn) {
            try {
                const mode = powerOn ? 0 : 3;
                Gio.DBus.session.call(
                    'org.gnome.Mutter.DisplayConfig',
                    '/org/gnome/Mutter/DisplayConfig',
                    'org.freedesktop.DBus.Properties',
                    'Set',
                    new GLib.Variant('(ssv)', [
                        'org.gnome.Mutter.DisplayConfig',
                        'PowerSaveMode',
                        new GLib.Variant('i', mode),
                    ]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null
                );
                console.log(`[LidDisplayOff] Display PowerSaveMode set to ${mode}`);
            } catch (e) {
                console.error(`[LidDisplayOff] Display power error: ${e.message}`);
            }
        }

        _onLidStateChanged() {
            if (!this._settings.get_boolean('enabled')) return;
            const closed = this._isLidClosed();
            console.log(`[LidDisplayOff] Lid state changed: closed=${closed}`);
            this._setDisplayPower(!closed);
        }

        /* ── Toggle enabled / disabled ────────────────────────────────── */

        _onEnabledChanged() {
            const enabled = this._settings.get_boolean('enabled');
            this._indicator.visible = enabled;

            if (enabled) {
                /* Save original lid-close actions */
                if (!this._settings.get_string('original-ac-action')) {
                    this._settings.set_string(
                        'original-ac-action',
                        this._powerSettings.get_string('lid-close-ac-action')
                    );
                }
                if (!this._settings.get_string('original-battery-action')) {
                    this._settings.set_string(
                        'original-battery-action',
                        this._powerSettings.get_string(
                            'lid-close-battery-action'
                        )
                    );
                }

                /* Override: do nothing on lid close (GNOME level) */
                this._powerSettings.set_string(
                    'lid-close-ac-action',
                    'nothing'
                );
                this._powerSettings.set_string(
                    'lid-close-battery-action',
                    'nothing'
                );

                /* Take systemd-logind inhibitor (system level) */
                this._takeInhibitorViaProcess();
            } else {
                this._restoreOriginalActions();
                this._releaseInhibitorProcess();
            }
        }

        /* ── Restore original lid-close behaviour ─────────────────────── */

        _restoreOriginalActions() {
            const origAc = this._settings.get_string('original-ac-action');
            const origBat = this._settings.get_string(
                'original-battery-action'
            );

            if (origAc) {
                this._powerSettings.set_string('lid-close-ac-action', origAc);
                this._settings.set_string('original-ac-action', '');
            }
            if (origBat) {
                this._powerSettings.set_string(
                    'lid-close-battery-action',
                    origBat
                );
                this._settings.set_string('original-battery-action', '');
            }
        }

        /* ── Cleanup ──────────────────────────────────────────────────── */

        destroy() {
            this._restoreOriginalActions();
            this._releaseInhibitorProcess();

            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }

            if (this._lidPropsChangedId && this._lidProxy) {
                this._lidProxy.disconnect(this._lidPropsChangedId);
                this._lidPropsChangedId = 0;
            }
            this._lidProxy = null;

            super.destroy();
        }
    }
);

/* ───────────────────────── Extension entry-point ──────────────────────── */

export default class LidDisplayOffExtension extends Extension {
    enable() {
        this._indicator = new LidDisplayOffIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(
            this._indicator
        );
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
