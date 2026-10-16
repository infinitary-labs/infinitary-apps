import { EventEmitter } from "node:events";
import {
  COMMAND_IDS,
  isWindowCommand,
  keysOf,
  panelCommandId,
  SHELL_COMMAND_IDS,
} from "@shared/keyboard";
import { DEFAULT_SAVED_KEYMAP, resolveBindings, type SavedKeymap } from "@shared/keymap";
import type { BrowserWindow, Input, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followWindowCommands,
  InstalledKeymap,
  recordWindowKeys,
  SECOND_KEY_WAIT_MS,
  shellCommands,
  type WindowCommandHandlers,
} from "./keyboard";

/**
 * A window whose page reports keys the way Electron does before the page
 * sees them, and records what the main process sends it.
 */
function windowWithKeys() {
  const sent: unknown[][] = [];
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    send: (...message: unknown[]) => sent.push(message),
  });
  const events = new EventEmitter();
  const win = Object.assign(events, {
    webContents: contents,
    isDestroyed: () => destroyed,
  }) as unknown as BrowserWindow;
  const type = (input: Partial<Input>) => {
    let prevented = false;
    contents.emit(
      "before-input-event",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      {
        type: "keyDown",
        key: "",
        code: "",
        meta: false,
        control: false,
        alt: false,
        shift: false,
        isComposing: false,
        isAutoRepeat: false,
        ...input,
      },
    );
    return prevented;
  };
  return {
    win,
    contents: contents as unknown as WebContents,
    type,
    sent,
    blur: () => events.emit("blur"),
    close: () => (destroyed = true),
  };
}

function recordingHandlers() {
  const ran: string[] = [];
  const handlers = Object.fromEntries(
    COMMAND_IDS.filter(isWindowCommand).map((id) => [id, () => ran.push(id)]),
  ) as unknown as WindowCommandHandlers;
  return { ran, handlers };
}

describe("followWindowCommands", () => {
  it("runs a window command once and keeps its key from the page and the menu", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    expect(type({ key: "+", meta: true })).toBe(true);
    expect(type({ key: "=", control: true })).toBe(true);
    expect(type({ key: "-", meta: true, isAutoRepeat: true })).toBe(true);
    expect(type({ key: "0", meta: true })).toBe(true);
    expect(ran).toEqual(["size.larger", "size.larger", "size.smaller", "size.reset"]);
  });

  it("keeps a held window key from the page, and runs it again only when the command repeats", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    expect(type({ key: "l", code: "KeyL", meta: true })).toBe(true);
    expect(type({ key: "l", code: "KeyL", meta: true, isAutoRepeat: true })).toBe(true);
    expect(type({ key: "l", code: "KeyL", meta: true, isAutoRepeat: true })).toBe(true);
    expect(type({ key: "=", meta: true, isAutoRepeat: true })).toBe(true);
    expect(ran).toEqual(["focus.main-message", "size.larger"]);
  });

  it("leaves every other key, a key's release and a message field's keys to the page", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    expect(type({ key: "a" })).toBe(false);
    expect(type({ type: "keyUp", key: "+", meta: true })).toBe(false);
    expect(type({ key: "u", code: "KeyU", control: true })).toBe(false);
    expect(type({ key: "ArrowUp", code: "ArrowUp" })).toBe(false);
    expect(type({ key: "+", meta: true, isComposing: true })).toBe(false);
    expect(type({ key: "l", code: "KeyL", control: true })).toBe(false);
    expect(type({ key: "l", code: "KeyL", meta: true, isComposing: true })).toBe(false);
    expect(ran).toEqual([]);
  });

  it("takes the shell's own keys wherever focus is: search, the reply, the cards, Settings", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    expect(type({ key: "k", code: "KeyK", meta: true })).toBe(true);
    expect(type({ key: "L", code: "KeyL", meta: true, shift: true })).toBe(true);
    expect(type({ key: "[", code: "BracketLeft", meta: true, shift: true })).toBe(true);
    expect(type({ key: "]", code: "BracketRight", meta: true, shift: true })).toBe(true);
    expect(type({ key: ",", code: "Comma", meta: true })).toBe(true);
    expect(type({ key: "\\", code: "Backslash", meta: true })).toBe(true);
    // A held key runs none of them again, and is still the window's.
    expect(
      type({ key: "]", code: "BracketRight", meta: true, shift: true, isAutoRepeat: true }),
    ).toBe(true);
    expect(ran).toEqual([
      "commands.search",
      "focus.card-reply",
      "cards.previous",
      "cards.next",
      "settings.open",
      "cards.thread",
    ]);
  });
});

describe("a panel's commands (docs/keyboard.md, \"A panel's commands\")", () => {
  const open = {
    id: panelCommandId("reading-list", "open"),
    label: "Open reading",
    panel: "Reading list",
    keys: [{ key: "j", meta: true }],
  } as const;
  const keys = {
    bindings: () => resolveBindings(DEFAULT_SAVED_KEYMAP, [open]),
    panels: () => [open],
  };

  it("runs a panel's command once on its key, a held key's repeats reaching nothing", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    const told: string[] = [];
    followWindowCommands(win, handlers, keys, (id) => told.push(id));
    expect(type({ key: "j", code: "KeyJ", meta: true })).toBe(true);
    expect(type({ key: "j", code: "KeyJ", meta: true, isAutoRepeat: true })).toBe(true);
    expect(told).toEqual([open.id]);
    expect(ran).toEqual([]);
    // The catalog's keys stay the catalog's.
    expect(type({ key: "l", code: "KeyL", meta: true })).toBe(true);
    expect(ran).toEqual(["focus.main-message"]);
    expect(told).toEqual([open.id]);
  });
});

describe("shellCommands", () => {
  it("tells the page the command's id alone, and nothing once the window is gone", () => {
    const { win, sent, close } = windowWithKeys();
    const { panel, ...commands } = shellCommands(win);
    expect(Object.keys(commands)).toEqual(SHELL_COMMAND_IDS);
    commands["focus.main-message"]();
    expect(sent).toEqual([["inf:keyboard:command", { command: "focus.main-message" }]]);
    // A panel's command is told the same way, by its id alone.
    panel("panel:reading-list/open");
    expect(sent).toEqual([
      ["inf:keyboard:command", { command: "focus.main-message" }],
      ["inf:keyboard:command", { command: "panel:reading-list/open" }],
    ]);
    close();
    commands["focus.main-message"]();
    panel("panel:reading-list/open");
    expect(sent).toHaveLength(2);
  });

  it("is told by the window's own key, which the page never sees", () => {
    const { win, type, sent } = windowWithKeys();
    followWindowCommands(win, { ...recordingHandlers().handlers, ...shellCommands(win) });
    expect(type({ key: "l", code: "KeyL", meta: true })).toBe(true);
    expect(type({ key: "x", code: "KeyX" })).toBe(false);
    expect(sent).toEqual([
      ["inf:keyboard:taken", {}],
      ["inf:keyboard:command", { command: "focus.main-message" }],
    ]);
  });
});

describe("two-key shortcuts", () => {
  afterEach(() => vi.useRealTimers());
  const keys = {
    bindings: () =>
      resolveBindings({
        version: 1,
        keys: { "settings.keyboard": [{ key: "j", meta: true, second: { key: "s" } }] },
      }),
    panels: () => [],
  };

  it("takes the first key, runs the pair once, and lets another second key reach the page", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers, keys);
    expect(type({ key: "j", code: "KeyJ", meta: true })).toBe(true);
    expect(type({ key: "Meta", code: "MetaLeft", meta: true })).toBe(false);
    expect(type({ key: "s", code: "KeyS" })).toBe(true);
    expect(ran).toEqual(["settings.keyboard"]);
    expect(type({ key: "j", code: "KeyJ", meta: true })).toBe(true);
    // Not the second key of any: typed as it was.
    expect(type({ key: "x", code: "KeyX" })).toBe(false);
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    expect(ran).toEqual(["settings.keyboard"]);
  });

  it("stops waiting on Escape, the window losing focus, composition and time", () => {
    vi.useFakeTimers();
    const { win, type, blur } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers, keys);
    type({ key: "j", code: "KeyJ", meta: true });
    expect(type({ key: "Escape", code: "Escape" })).toBe(true);
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    type({ key: "j", code: "KeyJ", meta: true });
    blur();
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    type({ key: "j", code: "KeyJ", meta: true });
    expect(type({ key: "s", code: "KeyS", isComposing: true })).toBe(false);
    type({ key: "j", code: "KeyJ", meta: true });
    vi.advanceTimersByTime(SECOND_KEY_WAIT_MS);
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("recording a key", () => {
  it("sends every key but a lone modifier to the page alone, and runs nothing, until it stops", () => {
    const { win, contents, type, sent } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    recordWindowKeys(contents, true);
    expect(type({ key: "k", code: "KeyK", meta: true })).toBe(true);
    expect(type({ key: "Shift", code: "ShiftLeft", shift: true })).toBe(false);
    expect(type({ key: "k", code: "KeyK", meta: true, isAutoRepeat: true })).toBe(true);
    expect(type({ key: "q", code: "KeyQ", meta: true })).toBe(true);
    expect(type({ key: "a", code: "KeyA", isComposing: true })).toBe(false);
    expect(ran).toEqual([]);
    expect(sent).toEqual([
      [
        "inf:keyboard:recorded",
        { key: "k", code: "KeyK", meta: true, ctrl: false, alt: false, shift: false },
      ],
      [
        "inf:keyboard:recorded",
        { key: "q", code: "KeyQ", meta: true, ctrl: false, alt: false, shift: false },
      ],
    ]);
    recordWindowKeys(contents, false);
    expect(type({ key: "k", code: "KeyK", meta: true })).toBe(true);
    expect(ran).toEqual(["commands.search"]);
  });

  it("stops when the window loses focus", () => {
    const { win, contents, type, blur } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers);
    recordWindowKeys(contents, true);
    blur();
    type({ key: "k", code: "KeyK", meta: true });
    expect(ran).toEqual(["commands.search"]);
  });
});

describe("InstalledKeymap", () => {
  function source(initial: SavedKeymap = DEFAULT_SAVED_KEYMAP) {
    let saved = initial;
    const listeners = new Set<() => void>();
    return {
      keymap: () => ({ saved, unreadable: false }),
      setKeymap: vi.fn((next: SavedKeymap) => {
        saved = next;
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      replace: (next: SavedKeymap) => {
        saved = next;
        for (const listener of listeners) listener();
      },
    };
  }

  it("installs a change whole, numbered, and tells every follower", () => {
    const kept = source();
    const keymap = new InstalledKeymap(kept);
    const installs: number[] = [];
    keymap.subscribe((snapshot) => installs.push(snapshot.version));
    const next = { version: 1 as const, keys: { "commands.search": [{ key: "p", meta: true }] } };
    expect(keymap.save(next).bindings["commands.search"]).toEqual([{ key: "p", meta: true }]);
    expect(kept.setKeymap).toHaveBeenCalledWith(next);
    expect(installs).toEqual([2]);
  });

  it("refuses a change with its reason and keeps the installed map", () => {
    const kept = source();
    const keymap = new InstalledKeymap(kept);
    expect(() =>
      keymap.save({ version: 1, keys: { "commands.search": [{ key: "q", meta: true }] } }),
    ).toThrow("Search commands: ⌘Q quits Infinitary");
    expect(kept.setKeymap).not.toHaveBeenCalled();
    expect(keymap.current().version).toBe(1);
  });

  it("installs the panels' commands with the catalog's, and the same list again installs nothing", () => {
    const keymap = new InstalledKeymap(source());
    const open = {
      id: panelCommandId("reading-list", "open"),
      label: "Open reading",
      panel: "Reading list",
      keys: [{ key: "j", meta: true }],
    } as const;
    const snapshot = keymap.setPanels([open]);
    expect(snapshot.version).toBe(2);
    expect(snapshot.panels).toEqual([open]);
    expect(keysOf(snapshot.bindings, open.id)).toEqual([{ key: "j", meta: true }]);
    expect(keymap.setPanels([open]).version).toBe(2);
    // A person's change keeps the panels'.
    keymap.save({ version: 1, keys: { "settings.open": [] } });
    expect(keymap.panels()).toEqual([open]);
    expect(keysOf(keymap.bindings(), open.id)).toEqual([{ key: "j", meta: true }]);
  });

  it("installs again when what it follows switches, and not for an unchanged read", () => {
    const kept = source();
    const keymap = new InstalledKeymap(kept);
    kept.replace(DEFAULT_SAVED_KEYMAP);
    expect(keymap.current().version).toBe(1);
    kept.replace({ version: 1, keys: { "settings.open": [] } });
    expect(keymap.current().version).toBe(2);
    expect(keymap.bindings()["settings.open"]).toEqual([]);
  });
});
