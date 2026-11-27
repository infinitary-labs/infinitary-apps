import { join } from "node:path";
import { cardOverlayArgument, overlayBounds, overlayRunsCommand } from "@shared/cardOverlay";
import {
  COMMAND_IDS,
  isWindowCommand,
  SHELL_COMMAND_IDS,
  type WindowCommandId,
} from "@shared/keyboard";
import {
  app,
  BrowserWindow,
  globalShortcut,
  powerMonitor,
  type Rectangle,
  screen,
  type WebContents,
} from "electron";
import {
  CardOverlayController,
  cardOverlayFile,
  carriedKeys,
  type OverlayPanel,
} from "./cardOverlay";
import {
  followWindowCommands,
  type InstalledKeymap,
  moveCommands,
  shellCommands,
} from "./keyboard";
import { assertSecurityBaseline, REQUIRED_WEB_PREFERENCES } from "./security/baseline";
import { lockdownNavigation } from "./security/navigation";
import type { RendererSourceOptions } from "./security/rendererSource";
import { markOverlayWindow } from "./windows";

/**
 * The card overlay's Electron half (docs/card-overlay.md): the system
 * shortcut and the one panel window, made on each summon and destroyed on
 * each leave, so nothing of it runs while it is hidden. The rules live in
 * `CardOverlayController` (./cardOverlay.ts).
 */

export type CardOverlayWindowOptions = {
  mainDir: string;
  rendererSource: RendererSourceOptions;
  keymap: Pick<InstalledKeymap, "bindings" | "panels">;
  /** The main window's page arguments: its desktop, language and the computer's languages. */
  pageArguments: () => string[];
  /** Whether the window's language runs right to left: the panel then sits at the left edge. */
  rightToLeft: () => boolean;
  /** The file this computer keeps the switch and key in. */
  file: string;
  supported: boolean;
  isDev: boolean;
  devTools: boolean;
  /** One line per open, for a timing check (`INFINITARY_OVERLAY_MARKS`). */
  mark?: (line: string) => void;
};

export type CardOverlayHost = {
  controller: CardOverlayController;
  /** The overlay's panel when `sender` is its page now, for the channels only it may use. */
  panelOf(sender: WebContents): OverlayPanel | null;
  /** The pointer moved onto the card or off it: elsewhere, clicks go to the app behind. */
  pointer(sender: WebContents, over: boolean): void;
  /** The card was made large or restored: the panel spans the display's width while it is large. */
  wide(sender: WebContents, wide: boolean): void;
};

/** The Mac menu's keys the overlay holds back: ⌘Q and ⌘W send it away, and none quits, hides or opens the app. */
const MENU_KEYS = new Set(["q", "w", "h", "m", ","]);

export function startCardOverlay(options: CardOverlayWindowOptions): CardOverlayHost {
  let shown: { win: BrowserWindow; panel: OverlayPanel; workArea: Rectangle } | null = null;

  const openPanel = (gone: () => void): OverlayPanel => {
    // The game's display is the pointer's: a game holds the pointer on its own display.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const win = new BrowserWindow({
      // A nonactivating panel on every Space, full-screen ones included: it
      // takes the keys while the game stays the front app (INF-7063's plan).
      type: "panel",
      ...overlayBounds(display.workArea, options.rightToLeft()),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(options.mainDir, "../preload/index.cjs"),
        additionalArguments: [...options.pageArguments(), cardOverlayArgument()],
        ...REQUIRED_WEB_PREFERENCES,
        devTools: options.devTools,
      },
    });
    markOverlayWindow(win);
    win.setAlwaysOnTop(true, "floating");
    // Until the pointer is over the card, the panel's clear area is the game's.
    win.setIgnoreMouseEvents(true, { forward: true });
    // A press on the card can make Infinitary the active app although the panel is nonactivating
    // (seen on macOS 26), and the game then has no keys once the panel goes.
    let pressed = false;
    win.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") pressed = true;
    });
    const panel: OverlayPanel = {
      showWithKeys: () => {
        if (!win.isDestroyed()) win.show();
      },
      showWithoutKeys: () => {
        if (!win.isDestroyed()) win.showInactive();
      },
      hide: () => {
        if (win.isDestroyed()) return;
        const hadKeys = win.isFocused();
        win.hide();
        // Hiding the app gives the activation back to the app behind it, the game. A panel that
        // lost the keys first went because the person moved to another app, Infinitary's own
        // window included, which keeps it.
        if (pressed && hadKeys) app.hide();
      },
      destroy: () => {
        if (!win.isDestroyed()) win.destroy();
      },
      askToLeave: () => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed())
          win.webContents.send("inf:overlay:leave", {});
      },
    };
    shown = { win, panel, workArea: display.workArea };
    win.on("closed", () => {
      if (shown?.win === win) shown = null;
      gone();
    });
    win.on("blur", () => controller.blurred(panel));
    win.webContents.on("render-process-gone", () => panel.destroy());
    win.webContents.once("did-finish-load", () => {
      void assertSecurityBaseline(win, options.isDev);
    });
    lockdownNavigation(win, options.rendererSource);
    followOverlayKeys(win, options.keymap, () => controller.leave());
    if (options.isDev && options.rendererSource.devServerUrl) {
      void win.loadURL(options.rendererSource.devServerUrl);
    } else {
      void win.loadFile(join(options.mainDir, "../renderer/index.html"));
    }
    return panel;
  };

  const controller = new CardOverlayController(
    {
      supported: options.supported,
      register: (accelerator, run) => {
        try {
          return globalShortcut.register(accelerator, run);
        } catch {
          return false;
        }
      },
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      openPanel,
      later: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => performance.now(),
      ...(options.mark ? { mark: options.mark } : {}),
    },
    cardOverlayFile(options.file),
  );

  // Every way the person leaves the game's screen sends the panel away too.
  const leave = () => controller.leave();
  powerMonitor.on("lock-screen", leave);
  powerMonitor.on("suspend", leave);
  screen.on("display-removed", leave);
  app.once("will-quit", () => controller.dispose());

  return {
    controller,
    panelOf: (sender) =>
      shown && !shown.win.isDestroyed() && shown.win.webContents === sender ? shown.panel : null,
    wide: (sender, wide) => {
      if (!shown || shown.win.isDestroyed() || shown.win.webContents !== sender) return;
      shown.win.setBounds(overlayBounds(shown.workArea, options.rightToLeft(), wide));
    },
    pointer: (sender, over) => {
      if (!shown || shown.win.isDestroyed() || shown.win.webContents !== sender) return;
      shown.win.setIgnoreMouseEvents(!over, { forward: true });
    },
  };
}

/**
 * The overlay's keys: the shown card's installed keys run as in the window,
 * every other window key does nothing, and the menu's ⌘Q, ⌘W, ⌘H, ⌘M and ⌘,
 * send the overlay away instead of quitting, closing or hiding the app.
 */
function followOverlayKeys(
  win: BrowserWindow,
  keymap: Pick<InstalledKeymap, "bindings" | "panels">,
  leave: () => void,
): void {
  // Heard before the window's commands, so neither they nor the menu see these keys.
  const held = carriedKeys();
  // The window's commands hear every input after this listener, prevented or not.
  let carriedNow = false;
  win.webContents.on("before-input-event", (event, input) => {
    carriedNow = held.carried(input);
    if (carriedNow) {
      event.preventDefault();
      return;
    }
    if (input.type !== "keyDown" || !input.meta || input.control || input.alt) return;
    const key = input.key.toLowerCase();
    if (!MENU_KEYS.has(key)) return;
    event.preventDefault();
    if (!input.isAutoRepeat && (key === "q" || key === "w")) leave();
  });
  const page = shellCommands(win);
  const handlers = Object.fromEntries(
    COMMAND_IDS.filter(isWindowCommand).map((id) => [id, () => {}]),
  ) as Record<WindowCommandId, () => void>;
  for (const id of SHELL_COMMAND_IDS) if (overlayRunsCommand(id)) handlers[id] = page[id];
  Object.assign(handlers, moveCommands(win.webContents));
  for (const id of Object.keys(handlers) as WindowCommandId[]) {
    const run = handlers[id];
    handlers[id] = () => {
      if (!carriedNow) run();
    };
  }
  followWindowCommands(win, handlers, keymap);
}
