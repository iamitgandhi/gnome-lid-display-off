/**
 * Lid Display Off — GNOME Shell Extension
 *
 * Provides a single Quick Settings toggle in the system panel
 * that controls the lid-display-off feature via GSettings.
 *
 * Compatible with GNOME Shell 46 – 50 (ESM modules).
 */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    QuickToggle,
    SystemIndicator,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

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

            /* Panel indicator icon (shown when feature is active) */
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
                () => {
                    this._indicator.visible = this._settings.get_boolean('enabled');
                }
            );

            /* Initial indicator state */
            this._indicator.visible = this._settings.get_boolean('enabled');
        }

        destroy() {
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }

            // Destroy all toggle items explicitly to remove them from QuickSettings menu
            this.quickSettingsItems.forEach(item => {
                if (item && !item.is_finalized?.()) {
                    item.destroy();
                }
            });
            this.quickSettingsItems = [];

            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }

            super.destroy();
        }
    }
);

/* ───────────────────────── Extension Entry Point ──────────────────────── */

export default class LidDisplayOffExtension extends Extension {
    enable() {
        // Clean up any stale/duplicate LidDisplayOffToggle items in QuickSettings
        this._cleanupOrphanedItems();

        this._indicator = new LidDisplayOffIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._cleanupOrphanedItems();
    }

    _cleanupOrphanedItems() {
        try {
            const qs = Main.panel.statusArea.quickSettings;
            if (!qs) return;

            // Clean up from menu items
            const menu = qs.menu;
            if (menu) {
                const destroyDuplicates = (actor) => {
                    if (!actor || !actor.get_children) return;
                    const children = actor.get_children();
                    for (const child of children) {
                        const isLidToggle =
                            child instanceof LidDisplayOffToggle ||
                            child.title === 'Lid Off' ||
                            child._title?.text === 'Lid Off';

                        if (isLidToggle) {
                            child.destroy();
                        } else if (child.get_children) {
                            destroyDuplicates(child);
                        }
                    }
                };

                destroyDuplicates(menu);
            }

            // Clean up from indicators
            if (qs._indicators) {
                const indChildren = qs._indicators.get_children();
                for (const child of indChildren) {
                    if (child instanceof LidDisplayOffIndicator) {
                        child.destroy();
                    }
                }
            }
        } catch (e) {
            console.error(`[LidDisplayOff] Cleanup error: ${e.message}`);
        }
    }
}
