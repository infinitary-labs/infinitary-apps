import {
  type Bindings,
  type MainCommandId,
  menuAccelerator,
  type ShellCommandId,
} from "@shared/keyboard";
import { withAllCatalogKeys } from "@shared/keymap";
import {
  type BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import type { InstalledKeymap, MainCommandHandlers } from "./keyboard";

/**
 * The app menu (docs/keyboard.md, "The app menu"): Electron's own, without
 * developer roles in the release, with the
 * View menu's zoom items running the size commands, after About the
 * Settings…, Keyboard Settings… and Reset All Keys… items, and a Help menu
 * whose What’s New in Infinitary opens the newest release note again
 * (docs/release-notes.md "Reading a note again"). Every item that runs a
 * command shows that command's first key from the installed map, and the
 * menu is built again at every install, so it never shows a key the window
 * no longer takes. The window takes a command's key before the menu does,
 * so an accelerator here only shows it. Keyboard Settings…, Reset All Keys…
 * and What’s New stay whatever keys a person removes: the way back is never
 * a key.
 */

export type AppMenuActions = {
  /** The size commands' handlers (./windowSize.ts), the same steps their keys take. */
  size: MainCommandHandlers;
  /** Tells the focused window's page a shell command, as its key would. */
  shell: (command: ShellCommandId) => void;
  /** Asks first, then puts every key back to the catalog's. */
  resetAllKeys: () => void;
  /** Whether a release note was shown: What’s New is greyed out until one was. */
  whatsNew: () => boolean;
};

const DEVELOPER_ROLES = new Set(["reload", "forcereload", "toggledevtools"]);

const SIZE_ROLES: Readonly<Record<string, MainCommandId>> = {
  zoomin: "size.larger",
  zoomout: "size.smaller",
  resetzoom: "size.reset",
};

const SIZE_ITEM_IDS: Readonly<Record<MainCommandId, string>> = {
  "size.larger": "appearance-size-in",
  "size.smaller": "appearance-size-out",
  "size.reset": "appearance-size-reset",
};

/** The items after About, each command's key read from `bindings`. */
function settingsItems(bindings: Bindings, actions: AppMenuActions): MenuItemConstructorOptions[] {
  return [
    { type: "separator" },
    {
      id: "settings-open",
      label: "Settings…",
      accelerator: menuAccelerator("settings.open", bindings),
      click: () => actions.shell("settings.open"),
    },
    {
      id: "settings-keyboard",
      label: "Keyboard Settings…",
      accelerator: menuAccelerator("settings.keyboard", bindings),
      click: () => actions.shell("settings.keyboard"),
    },
    { id: "keyboard-reset-all", label: "Reset All Keys…", click: () => actions.resetAllKeys() },
  ];
}

/** The Help menu's What’s New, which tells the page the same command its key would. */
function whatsNewItem(bindings: Bindings, actions: AppMenuActions): MenuItemConstructorOptions {
  return {
    id: "whats-new",
    label: "What’s New in Infinitary",
    accelerator: menuAccelerator("whats-new.show", bindings),
    enabled: actions.whatsNew(),
    click: () => actions.shell("whats-new.show"),
  };
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
      return [
        {
          role: item.role,
          label: item.label,
          type: item.type,
          accelerator: item.accelerator ?? undefined,
          submenu,
          click: (menuItem, window, event) => item.click(menuItem, window, event),
        },
      ];
    });
  const menu = copy(base);
  // Electron's own menu has no Help menu; a later one that does keeps it.
  const help = menu.find((item) => item.role?.toLowerCase() === "help");
  if (help && Array.isArray(help.submenu))
    help.submenu.unshift(whatsNewItem(bindings, actions), { type: "separator" });
  else menu.push({ role: "help", label: "Help", submenu: [whatsNewItem(bindings, actions)] });
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
  return () => build(keymap.bindings());
}

/**
 * Reset All Keys…: asks first, on the window when there is one, then puts
 * every key this version knows back to the catalog's, as Keyboard
 * settings' Reset all keys does.
 */
export function resetAllKeysAfterAsking(
  keymap: Pick<InstalledKeymap, "current" | "save">,
  win: BrowserWindow | undefined,
): void {
  const options: MessageBoxOptions = {
    type: "question",
    message: "Reset every key to Infinitary's own?",
    detail:
      "Every shortcut you changed in Keyboard settings goes back to the one Infinitary came with.",
    buttons: ["Reset All Keys", "Cancel"],
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
