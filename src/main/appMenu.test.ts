import { DEFAULT_BINDINGS } from "@shared/keyboard";
import { resolveBindings } from "@shared/keymap";
import type { Menu, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { type AppMenuActions, appMenuTemplate } from "./appMenu";

vi.mock("electron", () => ({ Menu: {}, dialog: {} }));

/**
 * The app menu (docs/keyboard.md, "The app menu"), built from a stand-in
 * for Electron's own: the Help menu's What's New in Infinitary
 * (docs/release-notes.md "Reading a note again").
 */

type Item = { role?: string; label: string; submenu?: { items: Item[] } };
const item = (fields: Item) => ({
  type: "normal",
  accelerator: null,
  click: () => {},
  ...fields,
});
/** Electron 43's own menu, in brief: an app menu and a Window menu, no Help menu. */
const ELECTRON_MENU = {
  items: [
    item({
      role: "appMenu",
      label: "Infinitary",
      submenu: {
        items: [item({ role: "about", label: "About" }), item({ role: "quit", label: "Quit" })],
      },
    }),
    item({
      role: "windowMenu",
      label: "Window",
      submenu: { items: [item({ role: "minimize", label: "Minimize" })] },
    }),
  ],
} as unknown as Menu;

function actions(whatsNew: boolean, checksUpdates = true) {
  const shell = vi.fn();
  const menuActions: AppMenuActions = {
    size: { "size.larger": vi.fn(), "size.smaller": vi.fn(), "size.reset": vi.fn() },
    shell,
    resetAllKeys: vi.fn(),
    whatsNew: () => whatsNew,
    checksUpdates: () => checksUpdates,
  };
  return { shell, menuActions };
}

const submenu = (entry: MenuItemConstructorOptions | undefined) =>
  (entry?.submenu ?? []) as MenuItemConstructorOptions[];

describe("the Help menu", () => {
  it("comes last, with What's New greyed out until a release note was shown", () => {
    const menu = appMenuTemplate(ELECTRON_MENU, DEFAULT_BINDINGS, actions(false).menuActions);
    const help = menu.at(-1);
    expect(help).toMatchObject({ role: "help", label: "Help" });
    expect(submenu(help)).toEqual([
      expect.objectContaining({
        id: "whats-new",
        label: "What’s New in Infinitary",
        enabled: false,
        accelerator: undefined,
      }),
    ]);
    // The app menu keeps its own items.
    expect(submenu(menu[0]).map((entry) => entry.id ?? entry.role)).toEqual([
      "about",
      "updates-check",
      undefined,
      "settings-open",
      "settings-keyboard",
      "keyboard-reset-all",
      "quit",
    ]);
  });

  it("tells the page What's new once a note was shown, as its key would", () => {
    const { shell, menuActions } = actions(true);
    const [whatsNew] = submenu(
      appMenuTemplate(ELECTRON_MENU, DEFAULT_BINDINGS, menuActions).at(-1),
    );
    expect(whatsNew?.enabled).toBe(true);
    const click = whatsNew?.click as (() => void) | undefined;
    if (!click) throw new Error("What's New runs nothing");
    click();
    expect(shell).toHaveBeenCalledWith("whats-new.show");
  });

  it("shows a key a person gave it in Keyboard settings", () => {
    const bindings = resolveBindings({
      version: 1,
      keys: { "whats-new.show": [{ key: "n", meta: true, alt: true }] },
    });
    const [whatsNew] = submenu(
      appMenuTemplate(ELECTRON_MENU, bindings, actions(true).menuActions).at(-1),
    );
    expect(whatsNew?.accelerator).toBe("Command+Alt+N");
  });

  it("joins a Help menu Electron already has, first in it", () => {
    const withHelp = {
      items: [
        ...ELECTRON_MENU.items,
        item({ role: "help", label: "Help", submenu: { items: [item({ label: "Learn More" })] } }),
      ],
    } as unknown as Menu;
    const menu = appMenuTemplate(withHelp, DEFAULT_BINDINGS, actions(true).menuActions);
    expect(menu.filter((entry) => entry.role === "help")).toHaveLength(1);
    expect(submenu(menu.at(-1)).map((entry) => entry.id ?? entry.type ?? entry.label)).toEqual([
      "whats-new",
      "separator",
      "normal",
    ]);
  });
});

// The captain's INF-2670 answer: Check for Updates… under About, running the
// same command as command search, greyed out on a copy that cannot check.
describe("Check for Updates…", () => {
  const checkItem = (menuActions: AppMenuActions) =>
    submenu(appMenuTemplate(ELECTRON_MENU, DEFAULT_BINDINGS, menuActions)[0]).find(
      (entry) => entry.id === "updates-check",
    );

  it("sits right after About and tells the page Check for updates, as its command would", () => {
    const { shell, menuActions } = actions(true);
    const check = checkItem(menuActions);
    expect(check).toMatchObject({ label: "Check for Updates…", enabled: true });
    const click = check?.click as (() => void) | undefined;
    if (!click) throw new Error("Check for Updates… runs nothing");
    click();
    expect(shell).toHaveBeenCalledWith("updates.check");
  });

  it("is greyed out on a copy that cannot check", () => {
    expect(checkItem(actions(true, false).menuActions)?.enabled).toBe(false);
  });
});

// The View boundary preserves the size handlers and platform full-screen item.
const viewBase = {
  items: [
    item({
      role: "viewMenu",
      label: "View",
      submenu: {
        items: [
          item({ role: "reload", label: "Reload" }),
          item({ role: "forceReload", label: "Force Reload" }),
          item({ role: "toggleDevTools", label: "Toggle Developer Tools" }),
          item({ role: "resetZoom", label: "Actual Size" }),
          item({ role: "zoomIn", label: "Zoom In" }),
          item({ role: "zoomOut", label: "Zoom Out" }),
          item({ role: "togglefullscreen", label: "Toggle Full Screen" }),
        ],
      },
    }),
  ],
} as unknown as Menu;

it.each([false, true])("View menu release=%s removes only developer roles", (release) => {
  const { menuActions } = actions(false);
  const view = submenu(appMenuTemplate(viewBase, DEFAULT_BINDINGS, menuActions, release)[0]);
  expect(view.map((entry) => entry.id ?? entry.role)).toEqual([
    ...(release ? [] : ["reload", "forceReload", "toggleDevTools"]),
    "appearance-size-reset",
    "appearance-size-in",
    "appearance-size-out",
    "togglefullscreen",
  ]);
  const reset = view.find((entry) => entry.id === "appearance-size-reset");
  if (!reset?.click) throw new Error("Missing size reset handler");
  (reset.click as () => void)();
  expect(menuActions.size["size.reset"]).toHaveBeenCalledOnce();
});
