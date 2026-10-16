import {
  type Bindings,
  boundCommand,
  DEFAULT_BINDINGS,
  type DesktopKeyAction,
  desktopKeyAction,
  isWindowCommand,
  type KeyPress,
  type MainCommandId,
  type PanelCommand,
  type PanelCommandId,
  panelCommandFor,
  runsOnPress,
  SHELL_COMMAND_IDS,
  type ShellCommandId,
  secondKeyCommand,
  secondKeyPanelCommand,
  startsTwoKeys,
  type WindowCommandId,
} from "@shared/keyboard";
import {
  type KeymapSnapshot,
  keymapRefusal,
  keymapSnapshot,
  type SavedKeymap,
  type SavedKeymapRead,
} from "@shared/keymap";
import type { KeySystem } from "@shared/platform";
import type { BrowserWindow, Input, WebContents } from "electron";

/** A key as Electron reports it before the page sees it. */
export function pressOfInput(input: Input): KeyPress {
  return {
    key: input.key,
    code: input.code,
    meta: input.meta,
    ctrl: input.control,
    alt: input.alt,
    shift: input.shift,
    composing: input.isComposing,
    repeat: input.isAutoRepeat,
  };
}

/** Each window command's handler, kept by the code that owns what it changes. */
export type WindowCommandHandlers = Readonly<Record<WindowCommandId, () => void>>;

/** The handlers of the window commands the main process runs itself. */
export type MainCommandHandlers = Readonly<Record<MainCommandId, () => void>>;

/**
 * Where the installed map reads and writes the keys a person changed: this
 * Mac's core, or its own look while it controls another (./shell.ts).
 */
export type KeymapSource = {
  keymap(): SavedKeymapRead;
  setKeymap(keymap: SavedKeymap): void;
  /** Told when what the window follows changed, a switch to another Mac's view among it. */
  subscribe(listener: () => void): () => void;
};

/**
 * The map the window has installed (docs/keyboard.md, "The installed map"):
 * the one every reader of keys reads - the window's keys here, the app
 * menu's accelerators, and the page's hints, command search and message
 * fields, which it is pushed to. Each install is numbered. A change is
 * installed whole or refused whole (`keymapRefusal`), and a refused or
 * failed one leaves the installed map as it was.
 */
export class InstalledKeymap {
  private snapshot: KeymapSnapshot;
  private readonly listeners = new Set<(snapshot: KeymapSnapshot) => void>();

  constructor(
    private readonly source: KeymapSource,
    /** Whose keys this keyboard presses: ⌘ on a Mac, Ctrl elsewhere (docs/keyboard.md, "Keys on each system"). */
    private readonly system: KeySystem = "mac",
  ) {
    this.snapshot = keymapSnapshot(source.keymap(), 1, [], system);
    source.subscribe(() => this.reload());
  }

  current(): KeymapSnapshot {
    return this.snapshot;
  }

  bindings(): Bindings {
    return this.snapshot.bindings;
  }

  /** The panels' commands installed with the catalog's (docs/keyboard.md, "A panel's commands"). */
  panels(): readonly PanelCommand[] {
    return this.snapshot.panels;
  }

  /**
   * The panels' commands the window has now, as its page last said them:
   * installed with the catalog's, each panel's suggested key taken only
   * where nothing else uses it. The same list again installs nothing.
   */
  setPanels(panels: readonly PanelCommand[]): KeymapSnapshot {
    if (JSON.stringify(panels) === JSON.stringify(this.snapshot.panels)) return this.snapshot;
    const { saved, unreadable } = this.snapshot;
    this.install({ saved, unreadable }, panels);
    return this.snapshot;
  }

  /** Saves and installs a change, or throws the reason it is refused, installing nothing. */
  save(keymap: SavedKeymap): KeymapSnapshot {
    const refusal = keymapRefusal(keymap, this.snapshot.saved, this.snapshot.panels, this.system);
    if (refusal) throw new Error(refusal);
    this.source.setKeymap(keymap);
    this.reload();
    return this.snapshot;
  }

  subscribe(listener: (snapshot: KeymapSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads what is saved again, installing it when it changed. */
  private reload(): void {
    const read = this.source.keymap();
    const { saved, unreadable } = this.snapshot;
    if (JSON.stringify(read) === JSON.stringify({ saved, unreadable })) return;
    this.install(read, this.snapshot.panels);
  }

  private install(read: SavedKeymapRead, panels: readonly PanelCommand[]): void {
    this.snapshot = keymapSnapshot(read, this.snapshot.version + 1, panels, this.system);
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** How long the window waits for a two-key shortcut's second key. */
export const SECOND_KEY_WAIT_MS = 2_000;

/** Keys that only modify another: never a key of their own to record or to wait past. */
const MODIFIER_KEYS = new Set([
  "Meta",
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "OS",
]);

/** Each window's recording switch, by its page, for the page's own request. */
const recorders = new WeakMap<WebContents, (recording: boolean) => void>();

/**
 * Keyboard settings records a key (docs/keyboard.md, "Recording a key"):
 * until it stops, the window's keys run nothing and each one pressed goes
 * to the page alone, as `before-input-event` reported it.
 */
export function recordWindowKeys(contents: WebContents, recording: boolean): void {
  recorders.get(contents)?.(recording);
}

/**
 * The window's commands (docs/keyboard.md): the main process hears their
 * keys before the page, so they work wherever focus is in the window, card
 * and panel frames included. A window command's key is the window's, held
 * or not: it reaches neither the page, a frame nor the menu, so the command
 * runs once, and a held key runs it again only when it repeats.
 *
 * A two-key shortcut's first key is the window's too, and the window waits
 * a moment for the second: the pair runs its command, and any other key
 * reaches the page as it was typed. Escape, the window losing focus, an
 * input method's composition and the wait running out end the wait.
 *
 * While Keyboard settings records a key the window runs nothing: every key
 * but a lone modifier goes to the page as `inf:keyboard:recorded`, and to
 * nothing else, the menu included.
 *
 * On a Ctrl system, which has no menu bar, the window also takes the keys a
 * Mac's menu holds (`desktop`): Ctrl+Q quits and Ctrl+W closes the window.
 *
 * Every key the window takes, the page is told it took one, never which
 * (`inf:keyboard:taken`): Chromium then holds back every key's release until
 * the next key goes down, so the page would otherwise never learn that its
 * dictation key was pressed with another (docs/composer.md, "Voice").
 */
export function followWindowCommands(
  win: BrowserWindow,
  handlers: WindowCommandHandlers,
  keys: Pick<InstalledKeymap, "bindings" | "panels"> = {
    bindings: () => DEFAULT_BINDINGS,
    panels: () => [],
  },
  /** A panel's command whose keys were pressed (docs/keyboard.md, "A panel's commands"). */
  onPanelCommand: (id: PanelCommandId) => void = () => {},
  /** This system's own window keys and what runs them (docs/keyboard.md, "Keys on each system"). */
  desktop: { system: KeySystem; run: (action: DesktopKeyAction) => void } = {
    system: "mac",
    run: () => {},
  },
): void {
  const contents = win.webContents;
  let recording = false;
  let waiting: { first: KeyPress; timer: ReturnType<typeof setTimeout> } | null = null;
  const stopWaiting = () => {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
  };
  const stop = () => {
    recording = false;
    stopWaiting();
  };
  recorders.set(contents, (on) => {
    stopWaiting();
    recording = on;
  });
  win.on("blur", stop);
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) stop();
  });
  const take = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!contents.isDestroyed()) contents.send("inf:keyboard:taken", {});
  };

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const press = pressOfInput(input);
    if (recording) {
      if (press.composing || MODIFIER_KEYS.has(press.key)) return;
      event.preventDefault();
      if (press.repeat || contents.isDestroyed()) return;
      const { key, code, meta, ctrl, alt, shift } = press;
      contents.send("inf:keyboard:recorded", { key, code, meta, ctrl, alt, shift });
      return;
    }
    const bindings = keys.bindings();
    const panels = keys.panels();
    if (waiting) {
      const { first } = waiting;
      if (MODIFIER_KEYS.has(press.key)) return;
      if (press.repeat && press.key === first.key) {
        take(event);
        return;
      }
      stopWaiting();
      if (press.composing) return;
      if (press.key === "Escape") {
        take(event);
        return;
      }
      const id = secondKeyCommand(first, press, {}, bindings);
      if (id !== undefined && isWindowCommand(id)) {
        take(event);
        handlers[id]();
        return;
      }
      const panel = secondKeyPanelCommand(first, press, bindings, panels);
      if (panel !== undefined) {
        take(event);
        onPanelCommand(panel);
        return;
      }
      // Not the second key of any: it is ordinary input again.
    }
    const id = boundCommand(press, {}, bindings);
    if (id !== undefined && isWindowCommand(id)) {
      take(event);
      if (runsOnPress(id, press)) handlers[id]();
      return;
    }
    // A panel's command never repeats, and a held key of one reaches nothing.
    const panel = panelCommandFor({ ...press, repeat: false }, bindings, panels);
    if (panel !== undefined) {
      take(event);
      if (!press.repeat) onPanelCommand(panel);
      return;
    }
    const action = desktopKeyAction(press, desktop.system);
    if (action !== undefined) {
      take(event);
      if (!press.repeat) desktop.run(action);
      return;
    }
    if (!press.repeat && startsTwoKeys(press, {}, bindings, panels)) {
      take(event);
      waiting = { first: press, timer: setTimeout(stopWaiting, SECOND_KEY_WAIT_MS) };
    }
  });
}

/**
 * The shell's window commands: heard here, run by the shell page. The page
 * is told the command's id alone, never the key or anything typed, and
 * checks for itself whether the command may run now. Frames hear nothing:
 * only the page's own preload listens on this channel.
 */
export function shellCommands(
  win: BrowserWindow,
): Readonly<Record<ShellCommandId, () => void>> &
  Readonly<{ panel: (id: PanelCommandId) => void }> {
  const tell = (command: ShellCommandId | PanelCommandId) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("inf:keyboard:command", { command });
  };
  return {
    ...(Object.fromEntries(
      SHELL_COMMAND_IDS.map((command) => [command, () => tell(command)]),
    ) as Record<ShellCommandId, () => void>),
    // A panel's command is the shell page's too, told by its id alone.
    panel: tell,
  };
}
