import { execFile } from "node:child_process";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import {
  cardOverlayArgument,
  overlayBounds,
  overlayRunsCommand,
  type SavedCardOverlay,
} from "@shared/cardOverlay";
import {
  COMMAND_IDS,
  isWindowCommand,
  SHELL_COMMAND_IDS,
  type WindowCommandId,
} from "@shared/keyboard";
import { isMacOwnKey, type SymbolicHotKey, systemHotKeys } from "@shared/macSystemShortcuts";
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
import { onNoticedCard } from "./notifiedCard";
import { DraftRelay } from "./overlayDraft";
import { assertSecurityBaseline, REQUIRED_WEB_PREFERENCES } from "./security/baseline";
import { lockdownNavigation } from "./security/navigation";
import type { RendererSourceOptions } from "./security/rendererSource";
import { followWindowSize, type PreferenceSource } from "./windowSize";
import { markOverlayWindow, openMainWindows } from "./windows";

/**
 * The card overlay's Electron half (docs/card-overlay.md): the system
 * shortcut and the one panel window, made on each summon or card
 * notification and destroyed on each leave, so nothing of it runs while it
 * is hidden past a notification's wait. The rules live in
 * `CardOverlayController` (./cardOverlay.ts).
 */

export type CardOverlayWindowOptions = {
  mainDir: string;
  rendererSource: RendererSourceOptions;
  keymap: Pick<InstalledKeymap, "bindings" | "panels">;
  /** The main window's page arguments: its desktop, language and the computer's languages. */
  pageArguments: () => string[];
  /** The Size setting the window follows: the panel's page follows it too, and the panel grows with it. */
  preferences: PreferenceSource;
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
  /** A person's change of the switch or key, checked against macOS's own shortcuts as they are now. */
  set(next: SavedCardOverlay): Promise<ReturnType<CardOverlayController["set"]>>;
  /** The overlay's panel when `sender` is its page now, for the channels only it may use. */
  panelOf(sender: WebContents): OverlayPanel | null;
  /** The pointer moved onto the card or off it: elsewhere, clicks go to the app behind. */
  pointer(sender: WebContents, over: boolean): void;
  /** The card was made large or restored: the panel spans the display's width while it is large. */
  wide(sender: WebContents, wide: boolean): void;
  /** The window's unsent message, lent to the overlay as it opens and handed back as it goes. */
  drafts: DraftRelay<WebContents>;
};

/** The Mac menu's keys the overlay holds back: ⌘Q and ⌘W send it away, and none quits, hides or opens the app. */
const MENU_KEYS = new Set(["q", "w", "h", "m", ","]);

export function startCardOverlay(options: CardOverlayWindowOptions): CardOverlayHost {
  let shown: { win: BrowserWindow; panel: OverlayPanel; workArea: Rectangle } | null = null;
  const boundsOn = (workArea: Rectangle, wide = false) =>
    overlayBounds(
      workArea,
      options.rightToLeft(),
      wide,
      (options.preferences.get().appearance.size ?? 100) / 100,
    );

  const openPanel = (gone: () => void): OverlayPanel => {
    // The game's display is the pointer's: a game holds the pointer on its own display.
    // A panel loaded on a notification takes its place again at the key (`summoned`).
    const displayNow = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const display = displayNow();
    const win = new BrowserWindow({
      // A nonactivating panel on every Space, full-screen ones included: it
      // takes the keys while the game stays the front app (INF-7063's plan).
      type: "panel",
      ...boundsOn(display.workArea),
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
    // Set on purpose, not left to Chromium's zoom per page address, which the window happens to share.
    followWindowSize(win, options.preferences);
    win.setAlwaysOnTop(true, "floating");
    // Until the pointer is over the card, the panel's clear area is the game's.
    win.setIgnoreMouseEvents(true, { forward: true });
    // A press on the card can make Infinitary the active app although the panel is nonactivating
    // (seen on macOS 26), and the game then has no keys once the panel goes.
    let pressed = false;
    win.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") pressed = true;
    });
    // The app in front at the press, the game: hiding Infinitary instead would activate whichever
    // app the system orders next, which after a Command-Tab is not the game.
    let behind: ReturnType<typeof frontApp> = Promise.resolve(null);
    // A panel that lost the keys first went because the person moved to another app, Infinitary's
    // own window included, which keeps them. Each way out passes here once while the panel shows.
    const handBack = () => {
      if (pressed && win.isVisible() && win.isFocused()) void behind.then(activateApp);
      pressed = false;
    };
    const panel: OverlayPanel = {
      summoned: () => {
        if (win.isDestroyed()) return;
        behind = frontApp();
        const workArea = displayNow().workArea;
        if (shown?.win === win) shown.workArea = workArea;
        win.setBounds(boundsOn(workArea));
      },
      showWithKeys: () => {
        if (!win.isDestroyed()) win.show();
      },
      showWithoutKeys: () => {
        if (!win.isDestroyed()) win.showInactive();
      },
      hide: () => {
        if (win.isDestroyed()) return;
        handBack();
        win.hide();
      },
      destroy: () => {
        if (win.isDestroyed()) return;
        handBack();
        win.destroy();
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

  // macOS's own shortcuts as last read; read again before each change of the key (`readHotKeys`).
  let hotKeys: SymbolicHotKey[] = systemHotKeys(null);
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
      systemShortcut: (chord) => isMacOwnKey(chord, hotKeys),
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
  onNoticedCard(() => controller.noticed());

  const drafts = new DraftRelay<WebContents>({
    lender: () => {
      const win = openMainWindows().find((each) => !each.webContents.isDestroyed());
      return win ? win.webContents : null;
    },
    ask: (contents, ask) => {
      if (!contents.isDestroyed()) contents.send("inf:composer:lend-ask", { ask });
    },
    handBack: (contents, lent) => {
      if (!contents.isDestroyed()) contents.send("inf:composer:hand-back", lent);
    },
    later: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  return {
    controller,
    drafts,
    set: async (next) => {
      if (options.supported) hotKeys = systemHotKeys(await readHotKeys());
      return controller.set(next);
    },
    panelOf: (sender) =>
      shown && !shown.win.isDestroyed() && shown.win.webContents === sender ? shown.panel : null,
    wide: (sender, wide) => {
      if (!shown || shown.win.isDestroyed() || shown.win.webContents !== sender) return;
      shown.win.setBounds(boundsOn(shown.workArea, wide));
    },
    pointer: (sender, over) => {
      if (!shown || shown.win.isDestroyed() || shown.win.webContents !== sender) return;
      shown.win.setIgnoreMouseEvents(!over, { forward: true });
    },
  };
}

/**
 * macOS's own shortcuts as a person set them (`AppleSymbolicHotKeys`), or null when they cannot
 * be read. `defaults` asks the preferences daemon, whose copy is newer than the file on disk.
 */
function readHotKeys(): Promise<unknown> {
  return new Promise((resolve) => {
    const options = {
      env: hostEnv(),
      encoding: "utf8" as const,
      timeout: 2_000,
      maxBuffer: 1 << 20,
    };
    const json = execFile(
      "/usr/bin/plutil",
      ["-extract", "AppleSymbolicHotKeys", "json", "-o", "-", "-"],
      options,
      (error, out) => {
        try {
          resolve(error ? null : JSON.parse(out));
        } catch {
          resolve(null);
        }
      },
    );
    const exported = execFile(
      "/usr/bin/defaults",
      ["export", "com.apple.symbolichotkeys", "-"],
      options,
      () => {},
    );
    if (exported.stdout && json.stdin) exported.stdout.pipe(json.stdin);
    else resolve(null);
  });
}

/** The app in front now, by its running instance (`asn`), or null when the system does not say. */
async function frontApp(): Promise<{ asn: string; bundle: string } | null> {
  const asn = (await lsappinfo(["front"])).trim();
  if (!asn.startsWith("ASN:")) return null;
  const bundle = await bundleOf(asn);
  return bundle ? { asn, bundle } : null;
}

/** The bundle of a running instance, null once it has quit. `-only` prints it as "CFBundleIdentifier"=, the full listing as bundleID=. */
async function bundleOf(asn: string): Promise<string | null> {
  return (
    /(?:bundleID|"CFBundleIdentifier")="([^"]+)"/.exec(
      await lsappinfo(["info", "-only", "bundleid", asn]),
    )?.[1] ?? null
  );
}

function lsappinfo(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/lsappinfo",
      args,
      { env: hostEnv(), encoding: "utf8", timeout: 2_000 },
      (error, out) => resolve(error ? "" : out),
    );
  });
}

/**
 * Makes `app` active again through Launch Services, which asks no permission, while that very
 * instance still runs: `open` would launch an app that quit meanwhile.
 */
async function activateApp(app: { asn: string; bundle: string } | null): Promise<void> {
  if (!app || (await bundleOf(app.asn)) !== app.bundle) return;
  execFile("/usr/bin/open", ["-b", app.bundle], { env: hostEnv(), timeout: 5_000 }, () => {});
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
