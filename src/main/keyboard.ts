import {
  type Bindings,
  boundCommand,
  DEFAULT_BINDINGS,
  type DesktopKeyAction,
  desktopKeyAction,
  hasNotTypingKeys,
  isWindowCommand,
  type KeyPress,
  type MainCommandId,
  MOVE_KEYS,
  type MoveCommandId,
  type MoveKey,
  type NextKey,
  nextKeys,
  type PanelCommand,
  type PanelCommandId,
  panelCommandFor,
  runsOnPress,
  SHELL_COMMAND_IDS,
  type ShellCommandId,
  type SizeCommandId,
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

/** The size commands' handlers, one set for every window (./windowSize.ts). */
export type SizeCommandHandlers = Readonly<Record<SizeCommandId, () => void>>;

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

/** The installed keys of one place: the not-typing keys, or the anywhere ones. */
function inPlace(installed: Bindings, notTyping: boolean): Bindings {
  return {
    ...installed,
    ...Object.fromEntries(
      Object.entries(installed).map(([id, own]) => [
        id,
        (own ?? []).filter((binding) => (binding.when === "not-typing") === notTyping),
      ]),
    ),
  };
}

/**
 * A key the window let reach a document, kept until that document offers it
 * back (docs/keyboard.md, "Keys used when not typing"): the native press, the
 * map installed then and the frame that held focus.
 */
type Witness = {
  press: KeyPress;
  bindings: Bindings;
  frame: WebContents["focusedFrame"];
};

/**
 * The most witnesses a window keeps. A key typed into a text field is
 * witnessed but never offered, so without a bound the list would grow with
 * every key typed while focus stays in one document.
 */
const WITNESSES_MAX = 256;

/** Whether two presses are the same key with the same modifiers, held or not. */
function samePress(a: KeyPress, b: KeyPress): boolean {
  return (Object.keys(a) as (keyof KeyPress)[]).every((key) => a[key] === b[key]);
}

/** Each window's native-press witnesses, reached only through its trusted page. */
const offers = new WeakMap<WebContents, (press: KeyPress, frame?: string) => void>();

/** The trusted shell forwards only its own unused key or one from the focused frame. */
export function offerWindowKey(contents: WebContents, press: KeyPress, frame?: string): void {
  offers.get(contents)?.(press, frame);
}

/** The name Electron's `sendInputEvent` gives each key a movement command presses. */
const MOVE_KEY_CODES: Readonly<Record<MoveKey, string>> = {
  ArrowLeft: "Left",
  ArrowDown: "Down",
  ArrowUp: "Up",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
};

/**
 * The keys the window pressed for a movement command and has not yet heard
 * back: each reaches the page as a key pressed there, and never runs a
 * command itself, so a key of a person's own on Home or End can never press
 * another movement in turn.
 */
const pressedForMoves = new WeakMap<WebContents, MoveKey[]>();

/**
 * A movement command (docs/keyboard.md, "Moving by a key of your own"):
 * presses its key where focus is. In the window's own page the key is a
 * real one, so it does there all the key does, a field's caret included.
 * Electron presses keys only into that page, never into a card's or a
 * panel's frame, so focus in a frame has the page hand the key to that
 * frame's bridge, named by the frame the main process saw holding focus.
 */
export function pressMoveKey(contents: WebContents, id: MoveCommandId): void {
  if (contents.isDestroyed()) return;
  const key = MOVE_KEYS[id];
  const focused = contents.focusedFrame;
  if (!focused || focused === contents.mainFrame) {
    const pressed = pressedForMoves.get(contents) ?? [];
    pressed.push(key);
    pressedForMoves.set(contents, pressed);
    contents.sendInputEvent({ type: "keyDown", keyCode: MOVE_KEY_CODES[key] });
    contents.sendInputEvent({ type: "keyUp", keyCode: MOVE_KEY_CODES[key] });
    return;
  }
  // A frame inside a card's frame is that card's to move in.
  let frame = focused;
  while (frame.parent && frame.parent !== contents.mainFrame) frame = frame.parent;
  if (frame.name) contents.send("inf:keyboard:move", { key, frame: frame.name });
}

/** The movement commands' handlers for one window. */
export function moveCommands(contents: WebContents): Readonly<Record<MoveCommandId, () => void>> {
  return Object.fromEntries(
    (Object.keys(MOVE_KEYS) as MoveCommandId[]).map((id) => [id, () => pressMoveKey(contents, id)]),
  ) as Record<MoveCommandId, () => void>;
}

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
 * for the second with no time limit, telling the page each key that may
 * follow (`inf:keyboard:next`), which it shows as the next-keys hint: a
 * listed key runs its pair's command and reaches nothing else, and any other
 * key ends the wait and acts as it would have. Escape, the window losing
 * focus, a navigation, recording and an input method's composition end it.
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
  let waiting: {
    first: KeyPress;
    notTyping: boolean;
    /** The frame that held focus at the first key: a not-typing wait ends once focus moves. */
    frame: WebContents["focusedFrame"];
  } | null = null;
  const tellNext = (next: NextKey[] | null) => {
    if (!contents.isDestroyed()) contents.send("inf:keyboard:next", { next });
  };
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = null;
    tellNext(null);
  };
  /**
   * The keys that reached a document and are not yet offered back, oldest
   * first. The page offers a key only after a timer and a round trip, so the
   * next key is often pressed before the last one's offer lands.
   */
  let witnessed: Witness[] = [];
  const stop = () => {
    witnessed = [];
    recording = false;
    stopWaiting();
  };
  recorders.set(contents, (on) => {
    witnessed = [];
    stopWaiting();
    recording = on;
  });
  win.on("blur", () => {
    stop();
    pressedForMoves.delete(contents);
  });
  contents.on("did-start-navigation", (details) => {
    witnessed = [];
    if (details.isMainFrame) stop();
  });
  const take = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!contents.isDestroyed()) contents.send("inf:keyboard:taken", {});
  };

  const resolve = (event: { preventDefault: () => void }, press: KeyPress, notTyping: boolean) => {
    const bindings = inPlace(keys.bindings(), notTyping);
    const context = { notTyping };
    const panels = keys.panels();
    const id = boundCommand(press, context, bindings);
    if (id !== undefined && isWindowCommand(id)) {
      take(event);
      if (runsOnPress(id, press)) handlers[id]();
      return;
    }
    const panel = panelCommandFor({ ...press, repeat: false }, bindings, panels, context);
    if (panel !== undefined) {
      take(event);
      if (!press.repeat) onPanelCommand(panel);
      return;
    }
    if (!press.repeat && startsTwoKeys(press, context, bindings, panels)) {
      take(event);
      waiting = { first: press, notTyping, frame: contents.focusedFrame };
      tellNext(nextKeys(press, context, bindings, panels));
    }
  };

  /**
   * A key pressed while the window waits for a second key, heard here before
   * the page in either place: true when the wait used it, false when the key
   * goes on as it would have with no wait. Only a key the hint lists runs a
   * pair; a not-typing wait ends once focus moved to another document.
   */
  const second = (event: { preventDefault: () => void }, press: KeyPress): boolean => {
    if (!waiting || MODIFIER_KEYS.has(press.key)) return false;
    const { first, notTyping, frame } = waiting;
    if (press.repeat && press.key === first.key) {
      take(event);
      return true;
    }
    stopWaiting();
    if (press.composing) return false;
    if (press.key === "Escape") {
      take(event);
      return true;
    }
    if (notTyping && contents.focusedFrame !== frame) return false;
    const bindings = inPlace(keys.bindings(), notTyping);
    const context = { notTyping };
    const id = secondKeyCommand(first, press, context, bindings);
    if (id !== undefined && isWindowCommand(id)) {
      take(event);
      handlers[id]();
      return true;
    }
    const panel = secondKeyPanelCommand(first, press, bindings, keys.panels(), context);
    if (panel !== undefined) {
      take(event);
      onPanelCommand(panel);
      return true;
    }
    return false;
  };
  offers.set(contents, (press, frame) => {
    if (recording || press.composing) return;
    const focused = contents.focusedFrame;
    if (!focused) return;
    if (frame ? focused.name !== frame : focused !== contents.mainFrame) return;
    const bindings = keys.bindings();
    // A document offers its keys in the order they were pressed: the oldest
    // match is this offer's press, and any older witness will never be offered.
    const index = witnessed.findIndex(
      (seen) =>
        seen.frame === focused && seen.bindings === bindings && samePress(seen.press, press),
    );
    const seen = witnessed[index];
    if (!seen) return;
    witnessed = witnessed.slice(index + 1);
    const offered = { preventDefault: () => {} };
    // A not-typing wait began at an earlier key's offer, which dropped every
    // older witness: this key was pressed after that first key, before its
    // offer landed, so the wait hears it as a second key would be heard.
    if (waiting?.notTyping && second(offered, seen.press)) return;
    // Resolve only installed not-typing bindings, once, against the original native press.
    resolve(offered, seen.press, true);
  });

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // A key the window pressed for a movement command is the page's alone.
    const pressed = pressedForMoves.get(contents);
    if (pressed?.[0] === input.key) {
      pressed.shift();
      return;
    }
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
    const frame = contents.focusedFrame;
    // A witness for another document or an earlier map can never be offered
    // back, and an input method's composition ends every one.
    witnessed = press.composing
      ? []
      : witnessed.filter((seen) => seen.frame === frame && seen.bindings === bindings);
    let witness: Witness | null = null;
    if (!press.composing && !MODIFIER_KEYS.has(press.key) && hasNotTypingKeys(bindings)) {
      witness = { press, bindings, frame };
      witnessed = [...witnessed, witness].slice(-WITNESSES_MAX);
    }
    // A key the window takes reaches no document, which therefore never offers it.
    const forget = () => {
      witnessed = witnessed.filter((seen) => seen !== witness);
    };
    if (second(event, press)) {
      forget();
      return;
    }
    const action = desktopKeyAction(press, desktop.system);
    if (action !== undefined) {
      forget();
      take(event);
      if (!press.repeat) desktop.run(action);
      return;
    }
    resolve(
      {
        preventDefault: () => {
          forget();
          event.preventDefault();
        },
      },
      press,
      false,
    );
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
