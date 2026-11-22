// Kabegame GNOME Shell extension: the part shared by both flavors.
//
// The app builds the installed extension.js from this file and one wrapper. legacy.js is for
// GNOME 42–44 and uses `imports.*`; esm.js is for GNOME 45+ and uses ES modules. The wrapper
// defines Gio, GLib, Meta, Main and loadShellModules() before this code. It also hooks
// KabegameExtension's enable() / disable() into the shell.
// See src-tauri/kabegame/src/wallpaper/manager/gnome/extension.rs.
//
// What it does:
// - Kabegame's wallpaper windows (title "kabegame-wallpaper <slot>") become the desktop wallpaper
//   of a monitor. Slot 0 goes to the primary monitor; Linux has no screen enumeration yet. They
//   are kept sticky, unminimized and at the bottom, sized to the monitor, and follow monitor
//   changes.
//   - GNOME 49+: Meta.Window.set_type(DESKTOP) and hide_from_window_list(), both public since
//     mutter 49.
//   - GNOME 42–48: the shell cannot change a window's type. X11 windows get
//     _NET_WM_WINDOW_TYPE_DESKTOP through xprop; mutter re-reads the property, so the window
//     becomes a real desktop window. Wayland windows stay normal windows kept at the bottom and
//     are filtered out of Alt+Tab and the overview.
// - D-Bus, on the shell's session connection: while enabled it owns BUS_NAME (the app watches it
//   to know the extension is online) and exports app.kabegame.Shell1 at OBJECT_PATH.
//
// Keep PROTOCOL in sync with `PROTOCOL` in extension.rs. Bump it when the D-Bus contract or the
// window handling changes, so that the app reinstalls the extension.

const PROTOCOL = 1;
const BUS_NAME = 'app.kabegame.Shell';
const OBJECT_PATH = '/app/kabegame/Shell';
const WALLPAPER_TITLE = /^kabegame-wallpaper (\d+)$/;

const SHELL_IFACE = `<node>
  <interface name="app.kabegame.Shell1">
    <property name="Protocol" type="u" access="read"/>
    <method name="GetWindowFrame">
      <arg type="s" direction="in" name="title"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="d" direction="out" name="x"/>
      <arg type="d" direction="out" name="y"/>
      <arg type="d" direction="out" name="width"/>
      <arg type="d" direction="out" name="height"/>
    </method>
  </interface>
</node>`;

// mutter 49 made set_type() / hide_from_window_list() public on Meta.Window
const CAN_SET_WINDOW_TYPE = typeof Meta.Window.prototype.set_type === 'function';

function kabegameLog(message) {
    console.log(`[kabegame] ${message}`);
}

// The wallpaper slot from a window title; null when the window is not one of Kabegame's wallpapers
function wallpaperSlot(window) {
    const title = window ? window.get_title() : null;
    const match = title ? WALLPAPER_TITLE.exec(title) : null;
    return match ? Number(match[1]) : null;
}

// Recomputed on every placement: monitors come and go, and the primary one can change
function wallpaperMonitor(slot) {
    const primary = Main.layoutManager.primaryIndex;
    if (slot === 0)
        return primary;
    return slot < global.display.get_n_monitors() ? slot : primary;
}

function callerPid(sender) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack()[0]);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// app.kabegame.Shell1. GetWindowFrame only answers about the caller's own windows: the window must
// belong to the process behind the calling D-Bus connection.
class KabegameShellService {
    get Protocol() {
        return PROTOCOL;
    }

    async GetWindowFrameAsync([title], invocation) {
        try {
            const pid = await callerPid(invocation.get_sender());
            const window = global.display.list_all_windows().find(w =>
                w.get_title() === title && w.get_pid() === pid && !w.minimized);
            if (!window) {
                invocation.return_value(new GLib.Variant('(bdddd)', [false, 0, 0, 0, 0]));
                return;
            }
            const frame = window.get_frame_rect();
            invocation.return_value(
                new GLib.Variant('(bdddd)', [true, frame.x, frame.y, frame.width, frame.height]));
        } catch (e) {
            invocation.return_dbus_error('app.kabegame.Shell1.Error.Failed', `${e}`);
        }
    }
}

// GNOME 42–48 on X11: turn the window into a desktop window by setting its window type property.
// mutter re-reads _NET_WM_WINDOW_TYPE on change. Desktop windows sit in the desktop layer, skip the
// taskbar and are left out of Alt+Tab and the overview.
function markX11Desktop(window) {
    if (window.get_client_type() !== Meta.WindowClientType.X11)
        return;
    // X11 windows are described as "0x<xid>"
    const xid = /^0x[0-9a-fA-F]+/.exec(window.get_description() || '');
    if (!xid)
        return;
    try {
        Gio.Subprocess.new(['xprop', '-id', xid[0], '-f', '_NET_WM_WINDOW_TYPE', '32a',
            '-set', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_DESKTOP'], Gio.SubprocessFlags.NONE);
    } catch (e) {
        kabegameLog(`xprop failed, the wallpaper stays a normal window: ${e}`);
    }
}

class KabegameManagedWindow {
    constructor(window) {
        this.window = window;
        this.signals = [
            window.connect_after('raised', () => this.window.lower()),
            window.connect('position-changed', () => this.place()),
            window.connect('size-changed', () => this.place()),
            window.connect('notify::minimized', () => {
                if (this.window.minimized)
                    this.window.unminimize();
            }),
        ];
        this.apply();
    }

    apply() {
        const window = this.window;
        if (CAN_SET_WINDOW_TYPE) {
            window.set_type(Meta.WindowType.DESKTOP);
            window.hide_from_window_list();
        } else {
            markX11Desktop(window);
        }
        window.stick();
        if (window.minimized)
            window.unminimize();
        this.place();
        window.lower();
    }

    place() {
        const slot = wallpaperSlot(this.window);
        if (slot === null)
            return;
        const rect = global.display.get_monitor_geometry(wallpaperMonitor(slot));
        const frame = this.window.get_frame_rect();
        if (frame.x !== rect.x || frame.y !== rect.y || frame.width !== rect.width || frame.height !== rect.height)
            this.window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    }

    release() {
        for (const id of this.signals)
            this.window.disconnect(id);
        this.signals = [];
    }
}

// GNOME 42–48: keep wallpaper windows that are still normal windows (Wayland) out of Alt+Tab and
// the overview. Every override checks that the method exists, and disable() restores the original.
class KabegameListFilter {
    constructor(isWallpaper) {
        this.isWallpaper = isWallpaper;
        this.restorers = [];
        this.disabled = false;
    }

    enable() {
        const isWallpaper = this.isWallpaper;
        this.override(Meta.Display.prototype, 'get_tab_list', original => function (...args) {
            return original.apply(this, args).filter(window => !isWallpaper(window));
        });
        // The overview takes a Meta.Window in workspace.js and a window actor in some versions of
        // workspaceThumbnail.js
        const overviewFilter = original => function (window, ...rest) {
            const metaWindow = window && typeof window.get_meta_window === 'function'
                ? window.get_meta_window() : window;
            return !isWallpaper(metaWindow) && original.call(this, window, ...rest);
        };
        loadShellModules().then(modules => {
            if (this.disabled)
                return;
            this.override(modules.workspace?.Workspace?.prototype, '_isOverviewWindow', overviewFilter);
            this.override(modules.workspaceThumbnail?.WorkspaceThumbnail?.prototype, '_isOverviewWindow',
                overviewFilter);
        }).catch(e => kabegameLog(`cannot patch the overview: ${e}`));
    }

    override(target, name, wrap) {
        if (!target || typeof target[name] !== 'function')
            return;
        const original = target[name];
        target[name] = wrap(original);
        this.restorers.push(() => {
            target[name] = original;
        });
    }

    disable() {
        this.disabled = true;
        for (const restore of this.restorers.reverse())
            restore();
        this.restorers = [];
    }
}

class KabegameExtension {
    enable() {
        this.managed = new Map();
        this.watched = new Map();
        this.listFilter = CAN_SET_WINDOW_TYPE ? null : new KabegameListFilter(window => this.managed.has(window));
        this.listFilter?.enable();

        this.mapId = global.window_manager.connect_after('map', (_wm, actor) => this.consider(actor.get_meta_window()));
        // Titles can arrive after the window is created
        this.createdId = global.display.connect('window-created', (_display, window) => this.watch(window));
        for (const actor of global.get_window_actors()) {
            this.watch(actor.get_meta_window());
            this.consider(actor.get_meta_window());
        }
        // Resolution changes, hotplug, primary monitor changes
        this.monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            for (const managed of this.managed.values())
                managed.place();
        });

        this.service = Gio.DBusExportedObject.wrapJSObject(SHELL_IFACE, new KabegameShellService());
        this.service.export(Gio.DBus.session, OBJECT_PATH);
        this.nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
            null, null);
        kabegameLog(`enabled (protocol ${PROTOCOL}, ${CAN_SET_WINDOW_TYPE ? 'desktop window type' : 'kept at the bottom'})`);
    }

    disable() {
        Gio.bus_unown_name(this.nameId);
        this.service.unexport();
        this.service = null;
        Main.layoutManager.disconnect(this.monitorsId);
        global.window_manager.disconnect(this.mapId);
        global.display.disconnect(this.createdId);
        for (const [window, ids] of this.watched) {
            for (const id of ids)
                window.disconnect(id);
        }
        this.watched.clear();
        for (const managed of this.managed.values())
            managed.release();
        this.managed.clear();
        this.listFilter?.disable();
        this.listFilter = null;
    }

    // Follows title changes (and forgets the window when it goes away)
    watch(window) {
        if (!window || this.watched.has(window))
            return;
        this.watched.set(window, [
            window.connect('notify::title', () => this.consider(window)),
            window.connect('unmanaged', () => this.forget(window)),
        ]);
    }

    forget(window) {
        for (const id of this.watched.get(window) ?? [])
            window.disconnect(id);
        this.watched.delete(window);
        this.managed.get(window)?.release();
        this.managed.delete(window);
    }

    consider(window) {
        if (!window || this.managed.has(window) || wallpaperSlot(window) === null || !window.get_compositor_private())
            return;
        kabegameLog(`managing "${window.get_title()}" (pid ${window.get_pid()})`);
        this.watch(window);
        this.managed.set(window, new KabegameManagedWindow(window));
    }
}
