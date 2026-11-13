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
  moveCommands,
  offerWindowKey,
  recordWindowKeys,
  shellCommands,
  type WindowCommandHandlers,
} from "./keyboard";

/**
 * A window whose page reports keys the way Electron does before the page
 * sees them, and records what the main process sends it.
 */
function windowWithKeys() {
  const sent: unknown[][] = [];
  const pressed: unknown[] = [];
  let destroyed = false;
  const mainFrame = { name: "" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame,
    focusedFrame: mainFrame as { name: string; parent?: unknown },
    isDestroyed: () => destroyed,
    send: (...message: unknown[]) => sent.push(message),
    sendInputEvent: (event: unknown) => pressed.push(event),
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
    pressed,
    blur: () => events.emit("blur"),
    focusFrame: (name: string, parent?: string) => {
      contents.focusedFrame =
        parent === undefined ? { name } : { name, parent: { name: parent, parent: mainFrame } };
    },
    focusPage: () => {
      contents.focusedFrame = mainFrame;
    },
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
    keys: [{ key: "e", meta: true }],
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
    expect(type({ key: "e", code: "KeyE", meta: true })).toBe(true);
    expect(type({ key: "e", code: "KeyE", meta: true, isAutoRepeat: true })).toBe(true);
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
        ...DEFAULT_SAVED_KEYMAP,
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

  // Accepted layers plan, piece 3: the next-keys hint replaces the timed wait.
  it("stops waiting on Escape, the window losing focus and composition, and never on time alone", () => {
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
    expect(ran).toEqual([]);
    type({ key: "j", code: "KeyJ", meta: true });
    vi.advanceTimersByTime(60_000);
    expect(type({ key: "s", code: "KeyS" })).toBe(true);
    expect(ran).toEqual(["settings.keyboard"]);
  });

  // Accepted layers plan, piece 3: the hint lists each next key while the window waits.
  it("tells the page each pair that may follow while it waits, and null once it stops", () => {
    const { win, type, sent } = windowWithKeys();
    const { handlers } = recordingHandlers();
    followWindowCommands(win, handlers, keys);
    type({ key: "j", code: "KeyJ", meta: true });
    const pair = { key: "j", meta: true, second: { key: "s" } };
    expect(sent.filter(([channel]) => channel === "inf:keyboard:next")).toEqual([
      ["inf:keyboard:next", { next: [{ id: "settings.keyboard", binding: pair }] }],
    ]);
    type({ key: "s", code: "KeyS" });
    type({ key: "j", code: "KeyJ", meta: true });
    type({ key: "Escape", code: "Escape" });
    type({ key: "j", code: "KeyJ", meta: true });
    // An unlisted key ends the wait.
    type({ key: "x", code: "KeyX" });
    expect(
      sent.filter(([channel]) => channel === "inf:keyboard:next").map(([, body]) => body),
    ).toEqual([
      { next: [{ id: "settings.keyboard", binding: pair }] },
      { next: null },
      { next: [{ id: "settings.keyboard", binding: pair }] },
      { next: null },
      { next: [{ id: "settings.keyboard", binding: pair }] },
      { next: null },
    ]);
  });

  it("runs a pair whose second key is an arrow, and an unlisted key after a first acts as usual", () => {
    const { win, type } = windowWithKeys();
    const { ran, handlers } = recordingHandlers();
    followWindowCommands(win, handlers, {
      bindings: () =>
        resolveBindings({
          ...DEFAULT_SAVED_KEYMAP,
          keys: {
            "cards.next": [{ key: "k", meta: true, second: { key: "ArrowRight", meta: true } }],
          },
        }),
      panels: () => [],
    });
    type({ key: "k", code: "KeyK", meta: true });
    expect(type({ key: "ArrowRight", code: "ArrowRight", meta: true })).toBe(true);
    expect(ran).toEqual(["cards.next"]);
    type({ key: "k", code: "KeyK", meta: true });
    // ⌘L is not listed after ⌘K here: it ends the wait and goes to the main message as ever.
    expect(type({ key: "l", code: "KeyL", meta: true })).toBe(true);
    expect(ran).toEqual(["cards.next", "focus.main-message"]);
  });
});

// Accepted layers plan, piece 3: a first key may be plain while not typing, and the second an arrow.
describe("a plain first key when not typing", () => {
  const g = {
    key: "g",
    code: "KeyG",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    composing: false,
    repeat: false,
  };
  function fixture() {
    const window = windowWithKeys();
    const recording = recordingHandlers();
    const bindings = resolveBindings({
      ...DEFAULT_SAVED_KEYMAP,
      keys: {
        "settings.open": [{ key: "g", second: { key: "s" }, when: "not-typing" }],
        "cards.next": [{ key: "g", second: { key: "ArrowDown" }, when: "not-typing" }],
      },
    });
    followWindowCommands(window.win, recording.handlers, {
      bindings: () => bindings,
      panels: () => [],
    });
    // The page heard g outside typing and offered it, as the shell does.
    const startWait = () => {
      window.type({ key: g.key, code: g.code });
      offerWindowKey(window.contents, g);
    };
    return { ...window, ...recording, startWait };
  }

  it("waits after an offered first key, and its listed second keys run before the page hears them", () => {
    const { type, ran, sent, startWait } = fixture();
    // Typed in a field, g is never offered: nothing waits and s reaches the field.
    type({ key: g.key, code: g.code });
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    expect(ran).toEqual([]);
    startWait();
    expect(sent.at(-1)).toEqual([
      "inf:keyboard:next",
      {
        // In the catalog's order.
        next: [
          {
            id: "cards.next",
            binding: { key: "g", second: { key: "ArrowDown" }, when: "not-typing" },
          },
          { id: "settings.open", binding: { key: "g", second: { key: "s" }, when: "not-typing" } },
        ],
      },
    ]);
    // A list would use the arrow itself; the window takes it first for the pair.
    expect(type({ key: "ArrowDown", code: "ArrowDown" })).toBe(true);
    startWait();
    expect(type({ key: "s", code: "KeyS" })).toBe(true);
    expect(ran).toEqual(["cards.next", "settings.open"]);
  });

  it("ends on an unlisted key, which reaches the page, and once focus moves to another document", () => {
    const { type, ran, startWait, focusFrame } = fixture();
    startWait();
    expect(type({ key: "x", code: "KeyX" })).toBe(false);
    expect(type({ key: "s", code: "KeyS" })).toBe(false);
    startWait();
    focusFrame("project-note");
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
    const next = {
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "commands.search": [{ key: "p", meta: true }] },
    };
    expect(keymap.save(next).bindings["commands.search"]).toEqual([{ key: "p", meta: true }]);
    expect(kept.setKeymap).toHaveBeenCalledWith(next);
    expect(installs).toEqual([2]);
  });

  it("refuses a change with its reason and keeps the installed map", () => {
    const kept = source();
    const keymap = new InstalledKeymap(kept);
    expect(() =>
      keymap.save({
        ...DEFAULT_SAVED_KEYMAP,
        keys: { "commands.search": [{ key: "q", meta: true }] },
      }),
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
      keys: [{ key: "e", meta: true }],
    } as const;
    const snapshot = keymap.setPanels([open]);
    expect(snapshot.version).toBe(2);
    expect(snapshot.panels).toEqual([open]);
    expect(keysOf(snapshot.bindings, open.id)).toEqual([{ key: "e", meta: true }]);
    expect(keymap.setPanels([open]).version).toBe(2);
    // A person's change keeps the panels'.
    keymap.save({ ...DEFAULT_SAVED_KEYMAP, keys: { "settings.open": [] } });
    expect(keymap.panels()).toEqual([open]);
    expect(keysOf(keymap.bindings(), open.id)).toEqual([{ key: "e", meta: true }]);
  });

  it("installs again when what it follows switches, and not for an unchanged read", () => {
    const kept = source();
    const keymap = new InstalledKeymap(kept);
    kept.replace(DEFAULT_SAVED_KEYMAP);
    expect(keymap.current().version).toBe(1);
    kept.replace({ ...DEFAULT_SAVED_KEYMAP, keys: { "settings.open": [] } });
    expect(keymap.current().version).toBe(2);
    expect(keymap.bindings()["settings.open"]).toEqual([]);
  });
});

// Accepted layers plan, piece 1: the main process witnesses a key, never a command supplied by a document.
describe("not-typing offers", () => {
  const press = {
    key: "s",
    code: "KeyS",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    composing: false,
    repeat: false,
  };
  function fixture() {
    const window = windowWithKeys();
    const recording = recordingHandlers();
    let bindings = resolveBindings({
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "settings.open": [{ key: press.key, when: "not-typing" }] },
    });
    followWindowCommands(window.win, recording.handlers, {
      bindings: () => bindings,
      panels: () => [],
    });
    return {
      ...window,
      ...recording,
      install: () => {
        bindings = resolveBindings(DEFAULT_SAVED_KEYMAP);
      },
    };
  }

  it("leaves the key to its document, then resolves a matching offer only once", () => {
    const { contents, type, ran } = fixture();
    offerWindowKey(contents, press);
    expect(ran).toEqual([]);
    expect(type({ key: press.key, code: press.code })).toBe(false);
    expect(ran).toEqual([]);
    offerWindowKey(contents, press);
    offerWindowKey(contents, press);
    expect(ran).toEqual(["settings.open"]);
  });

  it("refuses another key, another press, composition, repeats and a replaced map", () => {
    const { contents, type, ran, install } = fixture();
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, { ...press, ctrl: true });
    offerWindowKey(contents, { ...press, key: "a", code: "KeyA" });
    expect(ran).toEqual([]);
    // Offers come back in the order their keys went: once a later key's offer
    // arrives, an earlier key's never will.
    type({ key: press.key, code: press.code });
    type({ key: "a", code: "KeyA" });
    offerWindowKey(contents, { ...press, key: "a", code: "KeyA" });
    offerWindowKey(contents, press);
    expect(ran).toEqual([]);
    type({ key: press.key, code: press.code, isComposing: true });
    offerWindowKey(contents, press);
    type({ key: press.key, code: press.code, isAutoRepeat: true });
    offerWindowKey(contents, { ...press, repeat: true });
    type({ key: press.key, code: press.code });
    install();
    offerWindowKey(contents, press);
    expect(ran).toEqual([]);
  });

  // INF-3693: an offer reaches the main process after a timer and a round trip, so a fast typist's next key is pressed before it lands.
  it("keeps each key's witness when an earlier key's offer lands after a later press", () => {
    const { contents, type, ran } = fixture();
    const other = { ...press, key: "x", code: "KeyX" };
    type({ key: other.key, code: other.code });
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, other);
    offerWindowKey(contents, press);
    expect(ran).toEqual(["settings.open"]);
    type({ key: press.key, code: press.code });
    type({ key: other.key, code: other.code });
    offerWindowKey(contents, press);
    offerWindowKey(contents, other);
    expect(ran).toEqual(["settings.open", "settings.open"]);
    type({ key: press.key, code: press.code });
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, press);
    offerWindowKey(contents, press);
    offerWindowKey(contents, press);
    expect(ran).toEqual(["settings.open", "settings.open", "settings.open", "settings.open"]);
  });

  it("keeps a key's witness past a modifier pressed before its offer lands", () => {
    const { contents, type, ran } = fixture();
    const shift = { ...press, key: "Shift", code: "ShiftLeft", shift: true };
    type({ key: press.key, code: press.code });
    type({ key: shift.key, code: shift.code, shift: true });
    offerWindowKey(contents, press);
    offerWindowKey(contents, shift);
    expect(ran).toEqual(["settings.open"]);
  });

  // INF-3693: a quick press's offer lands after the next press, and paging the
  // cards starts the next card's frame loading in between; that load is only
  // its own frame's new document (docs/keyboard.md, "Keys used when not typing").
  it("keeps the window page's keys while a card's frame starts loading, and drops only that frame's", () => {
    const { contents, type, focusFrame, focusPage, ran } = fixture();
    const navigate = (frame: unknown) =>
      (contents as unknown as EventEmitter).emit("did-start-navigation", {
        isMainFrame: false,
        isSameDocument: false,
        frame,
      });
    focusFrame("card-body");
    const card = contents.focusedFrame;
    type({ key: press.key, code: press.code });
    navigate(card);
    offerWindowKey(contents, press, "card-body");
    expect(ran).toEqual([]);
    focusPage();
    type({ key: press.key, code: press.code });
    type({ key: press.key, code: press.code });
    navigate(card);
    offerWindowKey(contents, press);
    offerWindowKey(contents, press);
    expect(ran).toEqual(["settings.open", "settings.open"]);
  });

  // INF-3693: a plain key pressed right after another starts or finishes its pair however late the offers land.
  describe("a pair typed before its first key's offer lands", () => {
    const g = { ...press, key: "g", code: "KeyG" };
    const x = { ...press, key: "x", code: "KeyX" };
    function pairFixture() {
      const window = windowWithKeys();
      const recording = recordingHandlers();
      const bindings = resolveBindings({
        ...DEFAULT_SAVED_KEYMAP,
        keys: {
          "settings.open": [{ key: "g", when: "not-typing", second: { key: "s" } }],
          "commands.search": [{ key: "x", when: "not-typing" }],
          "settings.keyboard": [{ key: "j", meta: true, second: { key: "s" } }],
        },
      });
      followWindowCommands(window.win, recording.handlers, {
        bindings: () => bindings,
        panels: () => [],
      });
      const next = () =>
        window.sent.filter(([channel]) => channel === "inf:keyboard:next").map(([, body]) => body);
      return { ...window, ...recording, next };
    }

    it("runs the pair when both keys were pressed before the first key's offer", () => {
      const { contents, type, ran, next } = pairFixture();
      type({ key: x.key, code: x.code });
      type({ key: g.key, code: g.code });
      type({ key: press.key, code: press.code });
      offerWindowKey(contents, x);
      offerWindowKey(contents, g);
      expect(ran).toEqual(["commands.search"]);
      offerWindowKey(contents, press);
      expect(ran).toEqual(["commands.search", "settings.open"]);
      expect(next().at(-1)).toEqual({ next: null });
      // Used once: a later key acts as itself.
      expect(type({ key: press.key, code: press.code })).toBe(false);
      expect(ran).toEqual(["commands.search", "settings.open"]);
    });

    it("ends the wait on an unlisted key typed before the offer, which then acts as itself", () => {
      const { contents, type, ran, next } = pairFixture();
      type({ key: g.key, code: g.code });
      type({ key: x.key, code: x.code });
      type({ key: press.key, code: press.code });
      offerWindowKey(contents, g);
      offerWindowKey(contents, x);
      offerWindowKey(contents, press);
      expect(ran).toEqual(["commands.search"]);
      expect(next().at(-1)).toEqual({ next: null });
    });

    // INF-3547's later piece 5: Emacs on Linux's Ctrl+X Ctrl+B, whose Ctrl+X
    // works only when not typing while Ctrl+B also moves left anywhere.
    it("finishes a pair whose second key is also an anywhere key, pressed before the first key's offer", () => {
      const window = windowWithKeys();
      const { ran, handlers } = recordingHandlers();
      const bindings = resolveBindings({
        ...DEFAULT_SAVED_KEYMAP,
        keys: {
          "settings.open": [
            { key: "x", ctrl: true, when: "not-typing", second: { key: "b", ctrl: true } },
          ],
          "move.left": [{ key: "b", ctrl: true }],
        },
      });
      followWindowCommands(window.win, handlers, {
        bindings: () => bindings,
        panels: () => [],
      });
      const ctrlX = { ...press, key: "x", code: "KeyX", ctrl: true };
      const ctrlB = { ...press, key: "b", code: "KeyB", ctrl: true };
      expect(window.type({ key: "x", code: "KeyX", control: true })).toBe(false);
      // Ctrl+B reaches the document behind Ctrl+X instead of moving left now.
      expect(window.type({ key: "b", code: "KeyB", control: true })).toBe(false);
      expect(ran).toEqual([]);
      offerWindowKey(window.contents, ctrlX);
      offerWindowKey(window.contents, ctrlB);
      expect(ran).toEqual(["settings.open"]);
      // Pressed on its own, Ctrl+B moves left.
      expect(window.type({ key: "b", code: "KeyB", control: true })).toBe(true);
      expect(ran).toEqual(["settings.open", "move.left"]);
    });

    it("never finishes a pair with a key pressed before the pair's first key", () => {
      const { contents, type, ran } = pairFixture();
      type({ key: press.key, code: press.code });
      // ⌘J starts an anywhere pair at its press, after S reached its document.
      expect(type({ key: "j", code: "KeyJ", meta: true })).toBe(true);
      offerWindowKey(contents, press);
      expect(ran).toEqual([]);
      expect(type({ key: press.key, code: press.code })).toBe(true);
      expect(ran).toEqual(["settings.keyboard"]);
    });
  });

  it("binds a frame offer to native focus at the press and at the offer, never another document", () => {
    const { contents, type, focusFrame, ran } = fixture();
    type({ key: press.key, code: press.code });
    focusFrame("project-note");
    offerWindowKey(contents, press, "project-note");
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, press);
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, press, "another-note");
    expect(ran).toEqual([]);
    type({ key: press.key, code: press.code });
    offerWindowKey(contents, press, "project-note");
    expect(ran).toEqual(["settings.open"]);
  });

  it("forgets witnessed keys on blur, navigation and recording, and leaves Legacy unchanged", () => {
    const { contents, type, blur, ran } = fixture();
    type({ key: press.key, code: press.code });
    blur();
    offerWindowKey(contents, press);
    type({ key: press.key, code: press.code });
    (contents as unknown as EventEmitter).emit("did-start-navigation", { isMainFrame: true });
    offerWindowKey(contents, press);
    type({ key: press.key, code: press.code });
    recordWindowKeys(contents, true);
    offerWindowKey(contents, press);
    expect(type({ key: press.key, code: press.code })).toBe(true);
    recordWindowKeys(contents, false);
    offerWindowKey(contents, press);
    expect(ran).toEqual([]);
    const legacy = windowWithKeys();
    followWindowCommands(legacy.win, recordingHandlers().handlers);
    expect(legacy.type({ key: press.key, code: press.code })).toBe(false);
    offerWindowKey(legacy.contents, press);
    expect(legacy.sent).toEqual([]);
  });
});

// INF-3547's accepted plan, piece 2: "a key bound to Move down does what the
// down arrow does everywhere it works today".
describe('movement commands (docs/keyboard.md, "Moving by a key of your own")', () => {
  function fixture() {
    const window = windowWithKeys();
    const recording = recordingHandlers();
    const bindings = resolveBindings({
      ...DEFAULT_SAVED_KEYMAP,
      keys: {
        "move.down": [{ key: "n", alt: true }],
        "move.last": [{ key: "e", meta: true }],
        "move.first": [{ key: "End", when: "not-typing" }],
      },
    });
    followWindowCommands(
      window.win,
      { ...recording.handlers, ...moveCommands(window.contents) },
      { bindings: () => bindings, panels: () => [] },
    );
    return { ...window, ...recording };
  }

  it("presses the key itself into the window's own page, and keeps the person's key from it", () => {
    const { type, pressed, sent } = fixture();
    expect(type({ key: "˜", code: "KeyN", alt: true })).toBe(true);
    expect(pressed).toEqual([
      { type: "keyDown", keyCode: "Down" },
      { type: "keyUp", keyCode: "Down" },
    ]);
    expect(sent.filter(([channel]) => channel === "inf:keyboard:move")).toEqual([]);
  });

  it("leaves the key it pressed to the page, so a movement never presses another", () => {
    const { contents, type, pressed } = fixture();
    expect(type({ key: "e", code: "KeyE", meta: true })).toBe(true);
    expect(pressed).toHaveLength(2);
    // The pressed End comes back through the window's keys, bound to Move to the start when not typing.
    expect(type({ key: "End", code: "End" })).toBe(false);
    offerWindowKey(contents, {
      key: "End",
      code: "End",
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
      composing: false,
      repeat: false,
    });
    expect(pressed).toHaveLength(2);
  });

  it("hands the key to the frame holding focus, named by the window's own frame around it", () => {
    const { type, pressed, sent, focusFrame } = fixture();
    focusFrame("6d4f9a52-8c1e-4e7b-9a43-2f1d0c5b7e18");
    type({ key: "˜", code: "KeyN", alt: true });
    focusFrame("inner", "0b7c2e94-3a5d-4f61-8e2a-9c4d1b6f3a70");
    type({ key: "˜", code: "KeyN", alt: true });
    expect(pressed).toEqual([]);
    expect(sent.filter(([channel]) => channel === "inf:keyboard:move")).toEqual([
      ["inf:keyboard:move", { key: "ArrowDown", frame: "6d4f9a52-8c1e-4e7b-9a43-2f1d0c5b7e18" }],
      ["inf:keyboard:move", { key: "ArrowDown", frame: "0b7c2e94-3a5d-4f61-8e2a-9c4d1b6f3a70" }],
    ]);
  });
});
