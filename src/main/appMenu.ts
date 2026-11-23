import { onLanguageChange } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import {
  type Bindings,
  menuAccelerator,
  type ShellCommandId,
  type SizeCommandId,
} from "@shared/keyboard";
import { withAllCatalogKeys } from "@shared/keymap";
import { PRESET_LABELS } from "@shared/keyPresets";
import {
  type BrowserWindow,
  dialog,
  Menu,
  type MenuItem,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import type { InstalledKeymap, SizeCommandHandlers } from "./keyboard";

/**
 * The app menu (docs/keyboard.md, "The app menu"): Electron's own, its
 * About, Hide and Quit naming the app as macOS does (`nameAppMenu`), without
 * developer roles in the release, with the
 * View menu's zoom items running the size commands, after About the
 * Check for Updates… item (greyed out on a copy that cannot check), then
 * Settings…, Keyboard Settings… and Reset All Keys…, and a Help menu
 * whose What’s New in Infinitary opens the newest release note again
 * (docs/release-notes.md "Reading a note again"). Every item that runs a
 * command shows that command's first key from the installed map, and the
 * menu is built again at every install, so it never shows a key the window
 * no longer takes. The window takes a command's key before the menu does,
 * so an accelerator here only shows it. The app's own items are worded in
 * the app's language, and the menu is built again when it changes. Keyboard Settings…, Reset All Keys…
 * and What’s New stay whatever keys a person removes: the way back is never
 * a key.
 */

export type AppMenuActions = {
  /** The size commands' handlers (./windowSize.ts), the same steps their keys take. */
  size: SizeCommandHandlers;
  /** Tells the focused window's page a shell command, as its key would. */
  shell: (command: ShellCommandId) => void;
  /** Asks first, then puts every key back to the catalog's. */
  resetAllKeys: () => void;
  /** Whether a release note was shown: What’s New is greyed out until one was. */
  whatsNew: () => boolean;
  /** Whether this copy can check for updates: Check for Updates… is greyed out on one that cannot. */
  checksUpdates: () => boolean;
};

const DEVELOPER_ROLES = new Set(["reload", "forcereload", "toggledevtools"]);

const SIZE_ROLES: Readonly<Record<string, SizeCommandId>> = {
  zoomin: "size.larger",
  zoomout: "size.smaller",
  resetzoom: "size.reset",
};

const SIZE_ITEM_IDS: Readonly<Record<SizeCommandId, string>> = {
  "size.larger": "appearance-size-in",
  "size.smaller": "appearance-size-out",
  "size.reset": "appearance-size-reset",
};

/** The items after About, each command's key read from `bindings`. */
function settingsItems(bindings: Bindings, actions: AppMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      id: "updates-check",
      label: m.menuCheckUpdates(),
      accelerator: menuAccelerator("updates.check", bindings),
      enabled: actions.checksUpdates(),
      click: () => actions.shell("updates.check"),
    },
    { type: "separator" },
    {
      id: "settings-open",
      label: m.menuSettings(),
      accelerator: menuAccelerator("settings.open", bindings),
      click: () => actions.shell("settings.open"),
    },
    {
      id: "settings-keyboard",
      label: m.menuKeyboardSettings(),
      accelerator: menuAccelerator("settings.keyboard", bindings),
      click: () => actions.shell("settings.keyboard"),
    },
    { id: "keyboard-reset-all", label: m.menuResetAllKeys(), click: () => actions.resetAllKeys() },
  ];
}

/** The Help menu's What’s New, which tells the page the same command its key would. */
function whatsNewItem(bindings: Bindings, actions: AppMenuActions): MenuItemConstructorOptions {
  return {
    id: "whats-new",
    label: m.menuWhatsNew(),
    accelerator: menuAccelerator("whats-new.show", bindings),
    enabled: actions.whatsNew(),
    click: () => actions.shell("whats-new.show"),
  };
}

/**
 * The items Electron words with `app.name`: the app menu's own title, About,
 * Hide and Quit. That is the package's lowercase name, which stays as it is
 * (docs/architecture.md, "Where state lives"), while macOS shows the bundle's
 * name in the Dock and the menu bar.
 */
const NAMED_ROLES = new Set(["appmenu", "about", "hide", "quit"]);

export type AppMenuNames = {
  /** `app.name`, which Electron's own items are worded with. */
  electron: string;
  /** The bundle's name (`APP_IDENTITIES`): Infinitary, or Infinitary Dev for a development build. */
  app: string;
};

/** An item of Electron's menu as it stands, for a menu built again. */
function sameItem(
  item: MenuItem,
  submenu: MenuItemConstructorOptions[] | undefined,
): MenuItemConstructorOptions {
  return {
    role: item.role,
    label: item.label,
    type: item.type,
    accelerator: item.accelerator ?? undefined,
    submenu,
    click: (menuItem, window, event) => item.click(menuItem, window, event),
  };
}

/** Electron's own menu again, its items that carry the app's name with the bundle's name. */
export function namedMenuTemplate(base: Menu, names: AppMenuNames): MenuItemConstructorOptions[] {
  const copy = (source: Menu): MenuItemConstructorOptions[] =>
    source.items.map((item) => {
      const role = item.role?.toLowerCase();
      const same = sameItem(item, item.submenu ? copy(item.submenu) : undefined);
      if (role && NAMED_ROLES.has(role)) same.label = item.label.replace(names.electron, names.app);
      return same;
    });
  return copy(base);
}

/**
 * Names Electron's own menu as macOS names the app, once at the start of a
 * Mac process that may show it, before `installAppMenu` copies it.
 */
export function nameAppMenu(names: AppMenuNames): void {
  const base = Menu.getApplicationMenu();
  if (base) Menu.setApplicationMenu(Menu.buildFromTemplate(namedMenuTemplate(base, names)));
}

/** Electron's menu again, with the app's own items and the keys `bindings` holds. */
export function appMenuTemplate(
  base: Menu,
  bindings: Bindings,
  actions: AppMenuActions,
  release = false,
): MenuItemConstructorOptions[] {
  const copy = (source: Menu): MenuItemConstructorOptions[] =>
    source.items.flatMap((item): MenuItemConstructorOptions[] => {
      const role = item.role?.toLowerCase();
      if (release && role && DEVELOPER_ROLES.has(role)) return [];
      const size = role ? SIZE_ROLES[role] : undefined;
      // A native role would ignore a custom click and change Chromium's zoom alone.
      if (size)
        return [
          {
            id: SIZE_ITEM_IDS[size],
            label: item.label,
            accelerator: menuAccelerator(size, bindings),
            click: () => actions.size[size](),
          },
        ];
      const submenu = item.submenu ? copy(item.submenu) : undefined;
      if (submenu && role === "appmenu") {
        const at = submenu.findIndex((entry) => entry.role?.toLowerCase() === "about") + 1;
        submenu.splice(at, 0, ...settingsItems(bindings, actions));
      }
      return [sameItem(item, submenu)];
    });
  const menu = copy(base);
  // Electron's own menu has no Help menu; a later one that does keeps it.
  const help = menu.find((item) => item.role?.toLowerCase() === "help");
  if (help && Array.isArray(help.submenu))
    help.submenu.unshift(whatsNewItem(bindings, actions), { type: "separator" });
  else menu.push({ role: "help", label: m.menuHelp(), submenu: [whatsNewItem(bindings, actions)] });
  return menu;
}

/**
 * Installs the app menu now and again at every install of the window's
 * keys. Returns what builds it again with the keys installed now, for a
 * change to what an item may do (What’s New, once a note is shown).
 */
export function installAppMenu(
  keymap: Pick<InstalledKeymap, "bindings" | "subscribe">,
  actions: AppMenuActions,
  release = false,
): () => void {
  const base = Menu.getApplicationMenu();
  if (!base) return () => {};
  const build = (bindings: Bindings) =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(appMenuTemplate(base, bindings, actions, release)),
    );
  build(keymap.bindings());
  keymap.subscribe((snapshot) => build(snapshot.bindings));
  // The app's own items are worded in the app's language when built (docs/i18n.md).
  onLanguageChange(() => build(keymap.bindings()));
  return () => build(keymap.bindings());
}

/**
 * Reset All Keys…: asks first, on the window when there is one, then puts
 * every key this version knows back to the chosen preset's, as Keyboard
 * settings' Reset all keys does.
 */
export function resetAllKeysAfterAsking(
  keymap: Pick<InstalledKeymap, "current" | "save">,
  win: BrowserWindow | undefined,
): void {
  const preset = PRESET_LABELS[keymap.current().saved.preset];
  const options: MessageBoxOptions = {
    type: "question",
    message: m.resetKeysAsk({ preset }),
    detail: m.resetKeysDetail({ preset }),
    buttons: [m.resetKeysConfirm(), m.dialogCancel()],
    defaultId: 0,
    cancelId: 1,
  };
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    .then(({ response }) => {
      if (response === 0) keymap.save(withAllCatalogKeys(keymap.current().saved));
    })
    .catch(() => {
      // Nothing was reset; Keyboard settings still offers it.
    });
}
