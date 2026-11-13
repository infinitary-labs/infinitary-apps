import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcuts,
  type Bindings,
  bindingLabel,
  boundCommand,
  COMMAND_IDS,
  type CommandId,
  type CommandScope,
  chordAccelerator,
  chordLabel,
  chordMatches,
  commandFor,
  DEFAULT_BINDINGS,
  isMoveCommand,
  isShellCommand,
  isWindowCommand,
  KEYBOARD_COMMANDS,
  type KeyboardCommand,
  type KeyChord,
  type KeyContext,
  type KeyPress,
  keyHint,
  MAIN_COMMAND_IDS,
  menuAccelerator,
  nextKeys,
  panelCommandId,
  runsOnPress,
  SHELL_COMMAND_IDS,
  scopeIsActive,
  secondKeyCommand,
  startsTwoKeys,
} from "./keyboard";

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  composing: false,
  repeat: false,
  ...held,
});

const CONTEXTS: readonly KeyContext[] = [{}, { field: "main-message" }, { field: "reply" }];

/** Two scopes overlap when some place a key is pressed has both. */
const overlaps = (a: CommandScope, b: CommandScope) =>
  CONTEXTS.some((context) => scopeIsActive(a, context) && scopeIsActive(b, context));

describe("the command catalog", () => {
  it("gives every command its words, and a key to all but a window command chosen by name", () => {
    for (const id of COMMAND_IDS) {
      const command = KEYBOARD_COMMANDS[id];
      expect(command.label.length).toBeGreaterThan(0);
      if (command.scope !== "window") expect(command.keys.length).toBeGreaterThan(0);
      expect(isWindowCommand(id)).toBe(command.scope === "window");
    }
    expect(COMMAND_IDS.filter((id) => KEYBOARD_COMMANDS[id].keys.length === 0)).toEqual([
      "focus.card-body",
      "focus.card-actions",
      // INF-3547's accepted plan, piece 2: no default keys in Legacy.
      "regions.left",
      "regions.down",
      "regions.up",
      "regions.right",
      "move.left",
      "move.down",
      "move.up",
      "move.right",
      "move.first",
      "move.last",
      "move.page-up",
      "move.page-down",
      "cancel",
      "computers.previous",
      "computers.next",
      "project-focus.clear",
      "cards.done",
      "cards.decline",
      "cards.maximize",
      "cards.next-revision",
      "cards.unanswered-question", // INF-3963's plan: chosen by name.
      "cards.thread-new",
      "cards.show-info",
      "cards.show-cards",
      "cards.show-activity",
      "cards.show-crewmate",
      "browser.control",
      "task.move-computer",
      "task.close-done",
      "cards.show-browser",
      "cards.next-tab",
      "cards.previous-tab",
      "settings.keyboard",
      "settings.panels", // INF-2344: Arrange panels is chosen by name.
      "updates.show", // INF-640: the update notice is also chosen by name.
      "updates.later", // INF-2245: Update later is chosen by name while work saves.
      "updates.check", // INF-2073: Check for updates is chosen by name.
      "whats-new.show",
      "firstmate.reply",
      // INF-1988: the approved Runbooks tab and folder are chosen by name.
      "settings.runbooks",
      "runbooks.open-folder",
      "settings.usage",
      "settings.automation",
      "settings.integrations",
      "settings.secrets",
      "automation.pause-all",
      "usage.unit",
      "allowance.recheck",
      "devices.try-again",
    ]);
  });

  // INF-3547's accepted plan, piece 2: a key bound to Move down "does what
  // the down arrow does", and a held arrow key moves again as it repeats.
  it("never repeats a command that opens, closes or moves focus while its key is held, but a step's movement", () => {
    for (const id of COMMAND_IDS) {
      const { risk, repeat } = KEYBOARD_COMMANDS[id];
      if ((risk === "navigate" || risk === "close") && !isMoveCommand(id))
        expect(repeat).toBe(false);
    }
    expect(COMMAND_IDS.filter((id) => isMoveCommand(id) && KEYBOARD_COMMANDS[id].repeat)).toEqual([
      "move.left",
      "move.down",
      "move.up",
      "move.right",
      "move.page-up",
      "move.page-down",
    ]);
  });

  it("names who runs each window command, and gives the shell page only its own", () => {
    for (const id of COMMAND_IDS) {
      const command: KeyboardCommand = KEYBOARD_COMMANDS[id];
      if (command.scope === "window") expect(["main", "shell"]).toContain(command.runs);
      else expect(command.runs).toBeUndefined();
      expect(isShellCommand(id)).toBe(command.runs === "shell");
    }
    expect(SHELL_COMMAND_IDS).toEqual([
      "commands.search",
      "focus.main-message",
      "focus.card-reply",
      "focus.card-body",
      "focus.card-actions",
      "cards.choice-1",
      "cards.choice-2",
      "cards.choice-3",
      "cards.choice-4",
      "regions.next",
      "regions.previous",
      "regions.left",
      "regions.down",
      "regions.up",
      "regions.right",
      "computers.previous",
      "computers.next",
      "project-focus.open",
      "project-focus.clear",
      "cards.previous",
      "cards.next",
      "cards.minimize",
      "cards.minimize-all",
      "cards.done",
      "cards.decline",
      "cards.maximize",
      "cards.next-revision",
      // INF-3963's approved plan: the footer's stepper through a card's questions.
      "cards.next-question",
      "cards.previous-question",
      "cards.unanswered-question",
      // The approved annotation plan adds Point at to the shell's command catalog.
      "cards.point-at",
      "cards.thread",
      "cards.thread-new",
      "cards.show-info",
      "cards.show-cards",
      "cards.show-activity",
      "cards.show-crewmate",
      "browser.control",
      "task.move-computer",
      "task.close-done",
      "cards.show-browser",
      "cards.next-tab",
      "cards.previous-tab",
      "settings.open",
      "settings.keyboard",
      "settings.panels", // INF-2344: the shell opens Settings → Panels.
      "updates.show",
      "updates.later",
      "updates.check",
      "whats-new.show",
      "firstmate.reply",
      // INF-1988: the shell opens the approved Runbooks tab and folder.
      "settings.runbooks",
      "runbooks.open-folder",
      "settings.usage",
      "settings.automation",
      "settings.integrations",
      "settings.secrets",
      "automation.pause-all",
      "usage.unit",
      "allowance.recheck",
      "devices.try-again",
    ]);
    expect(MAIN_COMMAND_IDS).toEqual([
      "move.left",
      "move.down",
      "move.up",
      "move.right",
      "move.first",
      "move.last",
      "move.page-up",
      "move.page-down",
      "cancel",
      "size.larger",
      "size.smaller",
      "size.reset",
    ]);
  });

  it("never gives one default key to two commands that can work in the same place", () => {
    const same = (a: KeyChord, b: KeyChord) =>
      a.key === b.key &&
      !a.meta === !b.meta &&
      !a.ctrl === !b.ctrl &&
      !a.alt === !b.alt &&
      !a.shift === !b.shift;
    for (const [index, a] of COMMAND_IDS.entries()) {
      for (const b of COMMAND_IDS.slice(index + 1)) {
        if (!overlaps(KEYBOARD_COMMANDS[a].scope, KEYBOARD_COMMANDS[b].scope)) continue;
        for (const chord of DEFAULT_BINDINGS[a])
          expect(DEFAULT_BINDINGS[b].some((other) => same(chord, other))).toBe(false);
      }
    }
  });
});

describe("commandFor: the size keys, anywhere in the window", () => {
  it("takes Cmd or Ctrl with +, =, - and 0 wherever focus is", () => {
    for (const context of CONTEXTS) {
      for (const held of [{ meta: true }, { ctrl: true }]) {
        expect(commandFor(press("+", held), context)).toBe("size.larger");
        expect(commandFor(press("=", held), context)).toBe("size.larger");
        expect(commandFor(press("-", held), context)).toBe("size.smaller");
        expect(commandFor(press("0", held), context)).toBe("size.reset");
      }
    }
  });

  it("reads + as one key whether or not the layout needs Shift to type it, and repeats while held", () => {
    expect(commandFor(press("+", { meta: true, shift: true }), {})).toBe("size.larger");
    expect(commandFor(press("=", { meta: true, repeat: true }), {})).toBe("size.larger");
  });

  it("takes nothing without Cmd or Ctrl, with Option or both held, or during composition", () => {
    expect(commandFor(press("+"), {})).toBeUndefined();
    expect(commandFor(press("+", { meta: true, alt: true }), {})).toBeUndefined();
    expect(commandFor(press("-", { meta: true, ctrl: true }), {})).toBeUndefined();
    expect(commandFor(press("0", { meta: true, composing: true }), {})).toBeUndefined();
    expect(commandFor(press("_", { meta: true, shift: true }), {})).toBeUndefined();
  });
});

describe("commandFor: the way back to the main message, anywhere in the window", () => {
  it("takes Cmd+L wherever focus is, on any layout, and nothing else", () => {
    for (const context of CONTEXTS) {
      expect(commandFor(press("l", { meta: true }), context)).toBe("focus.main-message");
      expect(commandFor(press("д", { meta: true, code: "KeyL" }), context)).toBe(
        "focus.main-message",
      );
    }
    expect(commandFor(press("l", { ctrl: true }), {})).toBeUndefined();
    // Shift makes it another command: the shown card's reply.
    expect(commandFor(press("L", { meta: true, shift: true }), {})).not.toBe("focus.main-message");
    expect(commandFor(press("l", { meta: true, alt: true }), {})).toBeUndefined();
    expect(commandFor(press("l", { meta: true, composing: true }), {})).toBeUndefined();
  });

  it("runs once while the key is held, though the held key is still its own", () => {
    const held = press("l", { meta: true, repeat: true });
    expect(commandFor(held, {})).toBeUndefined();
    expect(boundCommand(held, {})).toBe("focus.main-message");
    expect(runsOnPress("focus.main-message", held)).toBe(false);
    expect(runsOnPress("size.larger", press("=", { meta: true, repeat: true }))).toBe(true);
    expect(boundCommand(press("l", { meta: true, repeat: true, composing: true }), {})).toBe(
      undefined,
    );
  });
});

describe("commandFor: the shell's other window keys", () => {
  it("takes search, the reply, the cards and Settings wherever focus is", () => {
    for (const context of CONTEXTS) {
      expect(commandFor(press("k", { meta: true }), context)).toBe("commands.search");
      expect(commandFor(press("L", { meta: true, shift: true }), context)).toBe("focus.card-reply");
      // A Mac reports ⇧⌘[ while ⌘ is down as the key's own character, with Shift.
      expect(commandFor(press("[", { meta: true, shift: true }), context)).toBe("cards.previous");
      expect(commandFor(press("]", { meta: true, shift: true }), context)).toBe("cards.next");
      // ⇧⌘F is the Tasks panel's own command now, a panel's, not the catalog's.
      expect(commandFor(press("F", { meta: true, shift: true }), context)).toBeUndefined();
      expect(commandFor(press(",", { meta: true }), context)).toBe("settings.open");
      expect(commandFor(press("\\", { meta: true }), context)).toBe("cards.thread");
    }
  });

  it("keeps Control+K a message field's own, and takes nothing for a near miss", () => {
    expect(commandFor(press("k", { ctrl: true }), { field: "main-message" })).toBe(
      "message.delete-to-line-end",
    );
    expect(commandFor(press("k", { ctrl: true }), {})).toBeUndefined();
    expect(commandFor(press("f", { meta: true }), {})).toBeUndefined();
    expect(commandFor(press("[", { meta: true }), {})).toBeUndefined();
    expect(commandFor(press("{", { meta: true }), {})).toBeUndefined();
    // The shifted character other input reports is the same chord.
    expect(commandFor(press("}", { meta: true, shift: true }), {})).toBe("cards.next");
    expect(commandFor(press(",", { meta: true, alt: true }), {})).toBeUndefined();
    expect(commandFor(press("\\", { ctrl: true }), {})).toBeUndefined();
    const held = press("]", { meta: true, shift: true, repeat: true });
    expect(commandFor(held, {})).toBeUndefined();
    expect(boundCommand(held, {})).toBe("cards.next");
  });
});

describe("commandFor: the window's parts on F6", () => {
  it("takes F6 and Shift+F6 wherever focus is, a message field included", () => {
    for (const context of CONTEXTS) {
      expect(commandFor(press("F6", { code: "F6" }), context)).toBe("regions.next");
      expect(commandFor(press("F6", { code: "F6", shift: true }), context)).toBe(
        "regions.previous",
      );
    }
  });

  it("takes nothing for F6 with another modifier, during composition, or while held", () => {
    expect(commandFor(press("F6", { meta: true }), {})).toBeUndefined();
    expect(commandFor(press("F6", { ctrl: true }), {})).toBeUndefined();
    expect(commandFor(press("F6", { alt: true }), {})).toBeUndefined();
    expect(commandFor(press("F6", { composing: true }), {})).toBeUndefined();
    expect(commandFor(press("F7"), {})).toBeUndefined();
    const held = press("F6", { repeat: true });
    expect(commandFor(held, {})).toBeUndefined();
    expect(boundCommand(held, {})).toBe("regions.next");
  });

  it("shows F6 as its hint and names both keys for assistive technology", () => {
    expect(keyHint("regions.next")).toBe("F6");
    expect(keyHint("regions.previous")).toBe("⇧F6");
    expect(ariaKeyShortcuts("regions.next")).toBe("F6");
    expect(ariaKeyShortcuts("regions.previous")).toBe("Shift+F6");
  });
});

describe("commandFor: scopes", () => {
  it("runs a message field's commands only in a message field, and recall only in the main message", () => {
    const killLine = press("u", { ctrl: true });
    const up = press("ArrowUp");
    expect(commandFor(killLine, {})).toBeUndefined();
    expect(commandFor(killLine, { field: "reply" })).toBe("message.delete-to-line-start");
    expect(commandFor(killLine, { field: "main-message" })).toBe("message.delete-to-line-start");
    expect(commandFor(up, {})).toBeUndefined();
    expect(commandFor(up, { field: "reply" })).toBeUndefined();
    expect(commandFor(up, { field: "main-message" })).toBe("message.recall");
  });

  it("repeats a held key only for a command that allows it", () => {
    expect(commandFor(press("ArrowUp", { repeat: true }), { field: "main-message" })).toBe(
      undefined,
    );
    expect(commandFor(press("u", { ctrl: true, repeat: true }), { field: "reply" })).toBe(
      "message.delete-to-line-start",
    );
  });
});

describe("chordMatches", () => {
  it("matches a letter in either case, with Shift only when the chord holds it", () => {
    expect(chordMatches({ key: "u", ctrl: true }, press("U", { ctrl: true }))).toBe(true);
    expect(chordMatches({ key: "u", ctrl: true }, press("u", { ctrl: true, shift: true }))).toBe(
      false,
    );
    expect(
      chordMatches({ key: "u", ctrl: true, shift: true }, press("U", { ctrl: true, shift: true })),
    ).toBe(true);
  });

  it("reads the physical key when the layout or a modifier types no Latin letter", () => {
    expect(chordMatches({ key: "u", ctrl: true }, press("г", { ctrl: true, code: "KeyU" }))).toBe(
      true,
    );
    expect(chordMatches({ key: "k", alt: true }, press("˚", { alt: true, code: "KeyK" }))).toBe(
      true,
    );
    expect(chordMatches({ key: "u", ctrl: true }, press("u", { ctrl: true, code: "KeyF" }))).toBe(
      true,
    );
  });

  it("matches a character with Shift exactly when the chord holds Shift, as a Mac reports it under ⌘", () => {
    const next = { key: "]", meta: true, shift: true };
    expect(chordMatches(next, press("]", { meta: true, shift: true }))).toBe(true);
    expect(chordMatches(next, press("]", { meta: true }))).toBe(false);
    expect(chordMatches({ key: "=", meta: true }, press("=", { meta: true, shift: true }))).toBe(
      true,
    );
  });

  it("matches a named key by its name, with Shift only when the chord holds it", () => {
    expect(chordMatches({ key: "ArrowUp" }, press("ArrowUp"))).toBe(true);
    expect(chordMatches({ key: "ArrowUp" }, press("ArrowUp", { shift: true }))).toBe(false);
    expect(chordMatches({ key: "F6", shift: true }, press("F6", { shift: true }))).toBe(true);
  });
});

describe("commandFor with changed keys", () => {
  it("follows the bindings it is given, in the command's own scope", () => {
    const bindings: Bindings = {
      ...DEFAULT_BINDINGS,
      "message.recall": [{ key: "r", ctrl: true }],
      "size.reset": [],
    };
    expect(commandFor(press("ArrowUp"), { field: "main-message" }, bindings)).toBeUndefined();
    expect(commandFor(press("r", { ctrl: true }), { field: "main-message" }, bindings)).toBe(
      "message.recall",
    );
    expect(commandFor(press("r", { ctrl: true }), { field: "reply" }, bindings)).toBeUndefined();
    expect(commandFor(press("0", { meta: true }), {}, bindings)).toBeUndefined();
  });
});

describe("two-key shortcuts", () => {
  const twoKeys: Bindings = {
    ...DEFAULT_BINDINGS,
    "settings.keyboard": [{ key: "k", ctrl: true, second: { key: "s" } }],
    "message.delete-to-line-end": [],
  };

  it("are never one press, and start where their command works", () => {
    expect(boundCommand(press("k", { ctrl: true }), {}, twoKeys)).toBeUndefined();
    expect(startsTwoKeys(press("k", { ctrl: true }), {}, twoKeys)).toBe(true);
    expect(startsTwoKeys(press("k", { ctrl: true }), { field: "reply" }, twoKeys)).toBe(true);
    expect(startsTwoKeys(press("k", { meta: true }), {}, twoKeys)).toBe(false);
    expect(startsTwoKeys(press("k", { ctrl: true, composing: true }), {}, twoKeys)).toBe(false);
  });

  it("run their command on the second key, and nothing on another", () => {
    const first = press("k", { ctrl: true });
    expect(secondKeyCommand(first, press("s"), {}, twoKeys)).toBe("settings.keyboard");
    expect(secondKeyCommand(first, press("x"), {}, twoKeys)).toBeUndefined();
    expect(secondKeyCommand(first, press("s", { composing: true }), {}, twoKeys)).toBeUndefined();
  });

  // Accepted layers plan, piece 3: the next-keys hint lists each pair that may follow, where it works.
  it("list every pair a first key starts in that place, the panels' after the catalog's", () => {
    const panel = {
      id: panelCommandId("reading-list", "open"),
      label: "Open reading",
      panel: "Reading list",
      keys: [],
    } as const;
    const pairs: Bindings = {
      ...twoKeys,
      "cards.next": [{ key: "k", ctrl: true, second: { key: "ArrowRight" } }],
      "settings.open": [{ key: "k", ctrl: true, second: { key: "o" }, when: "not-typing" }],
      [panel.id]: [{ key: "k", ctrl: true, second: { key: "r" } }],
    };
    const first = press("k", { ctrl: true });
    expect(
      nextKeys(first, {}, pairs, [panel]).map(({ id, binding }) => [id, binding.second.key]),
    ).toEqual([
      ["cards.next", "ArrowRight"],
      ["settings.keyboard", "s"],
      [panel.id, "r"],
    ]);
    expect(nextKeys(first, { notTyping: true }, pairs, [panel]).map(({ id }) => id)).toContain(
      "settings.open",
    );
    expect(nextKeys(press("j", { ctrl: true }), {}, pairs, [panel])).toEqual([]);
  });

  it("read as both keys in a hint, and stay out of a menu and assistive technology", () => {
    expect(bindingLabel({ key: "k", ctrl: true, second: { key: "s" } })).toBe("⌃K S");
    expect(keyHint("settings.keyboard", twoKeys)).toBe("⌃K S");
    expect(menuAccelerator("settings.keyboard", twoKeys)).toBeUndefined();
    expect(ariaKeyShortcuts("settings.keyboard", twoKeys)).toBeUndefined();
  });
});

describe("key hints", () => {
  it("draws a chord the way a Mac menu does: its modifiers in the Mac's order, then the key", () => {
    expect(chordLabel({ key: "l", meta: true, shift: true })).toBe("⇧⌘L");
    expect(chordLabel({ key: ",", meta: true })).toBe("⌘,");
    expect(chordLabel({ key: "[", meta: true, shift: true })).toBe("⇧⌘[");
    expect(chordLabel({ key: "u", ctrl: true })).toBe("⌃U");
    expect(chordLabel({ key: "ArrowUp" })).toBe("↑");
    expect(chordLabel({ key: "F6", shift: true, alt: true })).toBe("⌥⇧F6");
  });

  it("shows a command's first key, every key for assistive technology, and nothing without keys", () => {
    expect(keyHint("focus.card-reply")).toBe("⇧⌘L");
    expect(keyHint("size.larger")).toBe("⌘+");
    expect(keyHint("cards.maximize")).toBeUndefined();
    expect(keyHint("cards.thread")).toBe("⌘\\");
    expect(ariaKeyShortcuts("focus.card-reply")).toBe("Shift+Meta+L");
    expect(ariaKeyShortcuts("message.recall")).toBe("ArrowUp Control+P");
    expect(ariaKeyShortcuts("cards.maximize")).toBeUndefined();
    expect(
      keyHint("focus.card-reply", { ...DEFAULT_BINDINGS, "focus.card-reply": [] }),
    ).toBeUndefined();
  });
});

describe("menu accelerators", () => {
  it("writes a chord the way Electron's menu reads it", () => {
    expect(chordAccelerator({ key: "+", meta: true })).toBe("Command+Plus");
    expect(chordAccelerator({ key: "u", ctrl: true, shift: true })).toBe("Control+Shift+U");
    expect(chordAccelerator({ key: "ArrowUp", alt: true })).toBe("Alt+Up");
    expect(chordAccelerator({ key: "F6" })).toBe("F6");
  });

  it("shows each size command's first key, and nothing for a command left without keys", () => {
    const shown: Partial<Record<CommandId, string | undefined>> = {
      "size.larger": menuAccelerator("size.larger"),
      "size.smaller": menuAccelerator("size.smaller"),
      "size.reset": menuAccelerator("size.reset"),
    };
    expect(shown).toEqual({
      "size.larger": "Command+Plus",
      "size.smaller": "Command+-",
      "size.reset": "Command+0",
    });
    expect(menuAccelerator("size.reset", { ...DEFAULT_BINDINGS, "size.reset": [] })).toBe(
      undefined,
    );
  });
});
