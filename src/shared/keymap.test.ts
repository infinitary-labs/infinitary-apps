import { describe, expect, it } from "vitest";
import {
  bindingLabel,
  COMMAND_IDS,
  commandFor,
  DEFAULT_BINDINGS,
  type KeyBinding,
  type KeyPress,
  keyHint,
  keysOf,
  menuAccelerator,
  panelCommandFor,
  panelCommandId,
} from "./keyboard";
import {
  bindingProblem,
  chordOfPress,
  chordsOverlap,
  clashesWith,
  clashWords,
  DEFAULT_SAVED_KEYMAP,
  isChanged,
  keymapRefusal,
  keymapSnapshot,
  readSavedKeymap,
  resolveBindings,
  type SavedKeymap,
  sharedPlace,
  unknownCommands,
  withAllCatalogKeys,
  withCatalogKeys,
  withKeyMoved,
  withKeys,
} from "./keymap";

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

const saved = (keys: SavedKeymap["keys"]): SavedKeymap => ({ version: 1, keys });

describe("reading what is saved", () => {
  it("reads nothing saved as nothing changed, and an unreadable value as the catalog's keys, said so", () => {
    expect(readSavedKeymap(undefined)).toEqual({ saved: DEFAULT_SAVED_KEYMAP, unreadable: false });
    expect(readSavedKeymap({ version: 2, keys: {} })).toEqual({
      saved: DEFAULT_SAVED_KEYMAP,
      unreadable: true,
    });
    expect(readSavedKeymap({ version: 1, keys: { "cards.next": [{ key: 7 }] } }).unreadable).toBe(
      true,
    );
    const kept = saved({ "commands.search": [{ key: "p", meta: true }] });
    expect(readSavedKeymap(kept)).toEqual({ saved: kept, unreadable: false });
  });

  it("INF-1879: drops a saved Close binding without assigning its old effect elsewhere", () => {
    const before = saved({
      "cards.close": [{ key: "w", meta: true, shift: true }],
      "cards.minimize": [{ key: "m", meta: true, shift: true }],
    });
    expect(readSavedKeymap(before).saved.keys).toEqual({
      "cards.minimize": before.keys["cards.minimize"],
    });
  });

  it("carries a key saved under a retired command to the panel command that took it over", () => {
    // The catalog's `tasks.*` are the Tasks panel folder's own commands now.
    const before = saved({
      "tasks.board": [{ key: "k", ctrl: true, alt: true }],
      "tasks.board-find": [],
      "tasks.find": [{ key: "j", meta: true }],
      "panel:now/find": [{ key: "g", meta: true }],
      "cards.next": [{ key: "n", meta: true }],
    });
    expect(readSavedKeymap(before).saved.keys).toEqual({
      "panel:now/board": [{ key: "k", ctrl: true, alt: true }],
      "panel:now/board-find": [],
      // A key saved under the new id already wins over the old one's.
      "panel:now/find": [{ key: "g", meta: true }],
      "cards.next": [{ key: "n", meta: true }],
    });
    const board = {
      id: "panel:now/board" as const,
      label: "Open task board",
      panel: "Tasks",
      keys: [{ key: "b", meta: true }],
    };
    const bindings = resolveBindings(readSavedKeymap(before).saved, [board]);
    expect(keysOf(bindings, board.id)).toEqual([{ key: "k", ctrl: true, alt: true }]);
  });

  it("keeps a command this version does not know, and runs nothing for it", () => {
    const later = saved({ "panes.split": [{ key: "j", meta: true }] });
    expect(unknownCommands(later)).toEqual(["panes.split"]);
    expect(resolveBindings(later)).toEqual(DEFAULT_BINDINGS);
    expect(commandFor(press("j", { meta: true }), {}, resolveBindings(later))).toBeUndefined();
  });
});

describe("the keys a command may take", () => {
  it("takes a chord that holds ⌘ or ⌃, or a function key", () => {
    expect(bindingProblem({ key: "p", meta: true }, "commands.search")).toBeNull();
    expect(bindingProblem({ key: "j", ctrl: true, shift: true }, "cards.next")).toBeNull();
    expect(bindingProblem({ key: "F6" }, "focus.main-message")).toBeNull();
    expect(bindingProblem({ key: "]", meta: true, alt: true }, "cards.next")).toBeNull();
  });

  it("refuses a key that types, alone or with only ⇧ or ⌥", () => {
    for (const binding of [
      { key: "k" },
      { key: "k", shift: true },
      { key: "k", alt: true },
      { key: " " },
    ])
      expect(bindingProblem(binding, "commands.search")).toBe(
        "A shortcut holds ⌘ or ⌃, so typing never runs it",
      );
  });

  it("refuses the keys that keep their own jobs, and says which job", () => {
    expect(bindingProblem({ key: "Enter", meta: true }, "commands.search")).toMatch(/^Enter sends/);
    expect(bindingProblem({ key: "Tab", ctrl: true }, "commands.search")).toMatch(/^Tab moves/);
    expect(bindingProblem({ key: "Escape" }, "commands.search")).toMatch(/^Escape closes/);
    expect(bindingProblem({ key: "ArrowUp", meta: true }, "message.recall")).toMatch(/arrow keys/);
    expect(bindingProblem({ key: "Dead", alt: true }, "commands.search")).toMatch(/accent/);
    expect(bindingProblem({ key: "q", meta: true }, "commands.search")).toBe("⌘Q quits Infinitary");
    expect(bindingProblem({ key: "w", meta: true }, "cards.maximize")).toBe("⌘W closes the window");
    expect(bindingProblem({ key: "z", meta: true, shift: true }, "cards.next")).toBe("⇧⌘Z redoes");
    expect(bindingProblem({ key: "a", ctrl: true }, "message.delete-to-line-start")).toBe(
      "⌃A moves to the start of the line",
    );
  });

  it("takes two keys only for a window command, the first holding ⌘ or ⌃", () => {
    expect(
      bindingProblem({ key: "k", meta: true, second: { key: "s" } }, "settings.keyboard"),
    ).toBeNull();
    expect(bindingProblem({ key: "F6", second: { key: "s" } }, "settings.keyboard")).toBe(
      "A two-key shortcut starts with ⌘ or ⌃",
    );
    expect(
      bindingProblem({ key: "k", ctrl: true, second: { key: "u" } }, "message.delete-word-before"),
    ).toBe("Only a command that works anywhere in the window takes two keys");
    expect(
      bindingProblem({ key: "k", meta: true, second: { key: "Escape" } }, "settings.keyboard"),
    ).toMatch(/^Escape/);
  });

  it("records a press as the chord it is, the letter in lower case and Shift as held", () => {
    expect(chordOfPress(press("L", { meta: true, shift: true }))).toEqual({
      key: "l",
      meta: true,
      shift: true,
    });
    expect(chordOfPress(press("]", { meta: true, shift: true, code: "BracketRight" }))).toEqual({
      key: "]",
      meta: true,
      shift: true,
    });
    // A layout without Latin letters records the physical key's letter.
    expect(chordOfPress(press("л", { ctrl: true, code: "KeyK" }))).toEqual({
      key: "k",
      ctrl: true,
    });
    expect(chordOfPress(press("F6"))).toEqual({ key: "F6" });
  });

  it("finds two chords the same press would run", () => {
    expect(chordsOverlap({ key: "k", meta: true }, { key: "K", meta: true })).toBe(true);
    expect(chordsOverlap({ key: "k", meta: true }, { key: "k", meta: true, shift: true })).toBe(
      false,
    );
    // A typed character without Shift in its chord is that character, Shift or not.
    expect(chordsOverlap({ key: "+", ctrl: true }, { key: "+", ctrl: true, shift: true })).toBe(
      true,
    );
    expect(chordsOverlap({ key: "]", meta: true, shift: true }, { key: "]", meta: true })).toBe(
      true,
    );
    expect(chordsOverlap({ key: "F6" }, { key: "F6", shift: true })).toBe(false);
  });
});

describe("clashes", () => {
  it("names both commands, the key, and where both work", () => {
    const [clash] = clashesWith(DEFAULT_BINDINGS, "cards.next", { key: "k", meta: true });
    expect(clash).toEqual({
      id: "commands.search",
      binding: { key: "k", meta: true },
      kind: "same",
    });
    expect(clash && clashWords("cards.next", clash)).toBe(
      "⌘K already runs “Search commands” anywhere in the window",
    );
    const [field] = clashesWith(DEFAULT_BINDINGS, "settings.open", { key: "k", ctrl: true });
    expect(field && clashWords("settings.open", field)).toBe(
      "⌃K already runs “Delete to the end of the line” in the main message and a card's reply",
    );
    expect(sharedPlace("message-field", "main-message")).toBe("in the main message");
  });

  it("refuses a whole key that starts another command's two keys, and the other way round", () => {
    const [prefix] = clashesWith(DEFAULT_BINDINGS, "settings.keyboard", {
      key: "k",
      meta: true,
      second: { key: "s" },
    });
    expect(prefix?.kind).toBe("prefix");
    expect(prefix && clashWords("settings.keyboard", prefix)).toBe(
      "⌘K runs “Search commands” anywhere in the window, so it can't start two keys",
    );
    const twoKeys = resolveBindings(
      saved({ "settings.keyboard": [{ key: "j", meta: true, second: { key: "s" } }] }),
    );
    const [starts] = clashesWith(twoKeys, "commands.search", { key: "j", meta: true });
    expect(starts && clashWords("commands.search", starts)).toBe(
      "⌘J S runs “Open Keyboard settings” anywhere in the window, and starts with this key",
    );
    // Two two-key shortcuts may share their first key.
    expect(
      clashesWith(twoKeys, "cards.maximize", { key: "j", meta: true, second: { key: "w" } }),
    ).toEqual([]);
  });
});

describe("the installed map", () => {
  it("runs a changed command on its new key, and no longer on its old one", () => {
    const bindings = resolveBindings(saved({ "commands.search": [{ key: "p", meta: true }] }));
    expect(commandFor(press("p", { meta: true }), {}, bindings)).toBe("commands.search");
    expect(commandFor(press("k", { meta: true }), {}, bindings)).toBeUndefined();
    expect(keyHint("commands.search", bindings)).toBe("⌘P");
    expect(menuAccelerator("commands.search", bindings)).toBe("Command+P");
  });

  it("tells an explicit no key from the catalog's keys", () => {
    const none = saved({ "settings.open": [] });
    expect(isChanged(none, "settings.open")).toBe(true);
    expect(resolveBindings(none)["settings.open"]).toEqual([]);
    expect(menuAccelerator("settings.open", resolveBindings(none))).toBeUndefined();
    expect(isChanged(DEFAULT_SAVED_KEYMAP, "settings.open")).toBe(false);
  });

  it("keeps a person's key when a catalog key clashes with it, and drops keys no command may take", () => {
    // As if a newer catalog gave ⌘K's search a key a person already uses.
    const mine = saved({ "cards.next": [{ key: "k", meta: true }] });
    const bindings = resolveBindings(mine);
    expect(bindings["cards.next"]).toEqual([{ key: "k", meta: true }]);
    expect(bindings["commands.search"]).toEqual([]);
    expect(
      resolveBindings(saved({ "cards.next": [{ key: "q", meta: true }] }))["cards.next"],
    ).toEqual([]);
  });

  it("gives a menu the first key it can show, never two keys, and a hint every kind", () => {
    const bindings = resolveBindings(
      saved({
        "settings.open": [{ key: "j", meta: true, second: { key: "s" } }, { key: "F7" }],
      }),
    );
    expect(keyHint("settings.open", bindings)).toBe("⌘J S");
    expect(menuAccelerator("settings.open", bindings)).toBe("F7");
  });

  it("numbers each install", () => {
    const snapshot = keymapSnapshot({ saved: DEFAULT_SAVED_KEYMAP, unreadable: false }, 3);
    expect(snapshot).toEqual({
      version: 3,
      saved: DEFAULT_SAVED_KEYMAP,
      bindings: DEFAULT_BINDINGS,
      unreadable: false,
      panels: [],
    });
  });
});

describe("a change, installed whole or not at all", () => {
  it("installs a change whose every key holds", () => {
    expect(
      keymapRefusal(saved({ "commands.search": [{ key: "p", meta: true }] }), DEFAULT_SAVED_KEYMAP),
    ).toBeNull();
  });

  it("refuses a key no command may take", () => {
    expect(
      keymapRefusal(saved({ "commands.search": [{ key: "c", meta: true }] }), DEFAULT_SAVED_KEYMAP),
    ).toBe("Search commands: ⌘C copies");
  });

  it("refuses to take another command's key without changing that command too", () => {
    expect(
      keymapRefusal(saved({ "cards.next": [{ key: "k", meta: true }] }), DEFAULT_SAVED_KEYMAP),
    ).toBe("⌘K runs “Show the next card” now, so “Search commands” can't have it too");
    expect(
      keymapRefusal(
        saved({
          "cards.next": [{ key: "j", meta: true }],
          "cards.previous": [{ key: "j", meta: true }],
        }),
        DEFAULT_SAVED_KEYMAP,
      ),
    ).toBe("Show the next card: ⌘J already runs “Show the previous card” anywhere in the window");
  });

  it("installs a moved key, the command it left keeping its others", () => {
    const moved = withKeyMoved(
      DEFAULT_SAVED_KEYMAP,
      DEFAULT_BINDINGS,
      "cards.next",
      { key: "=", meta: true },
      "replace",
    );
    expect(moved.keys).toEqual({
      "cards.next": [{ key: "=", meta: true }],
      "size.larger": [
        { key: "+", meta: true },
        { key: "+", ctrl: true },
        { key: "=", ctrl: true },
      ],
    });
    expect(keymapRefusal(moved, DEFAULT_SAVED_KEYMAP)).toBeNull();
    const added = withKeyMoved(
      DEFAULT_SAVED_KEYMAP,
      DEFAULT_BINDINGS,
      "cards.next",
      { key: "j", meta: true },
      "add",
    );
    expect(added.keys["cards.next"]?.map((binding) => bindingLabel(binding))).toEqual([
      "⇧⌘]",
      "⇧⌘}",
      "⌘J",
    ]);
  });

  it("still installs a change after a newer catalog gave away a key a person holds", () => {
    const mine = saved({ "cards.next": [{ key: "k", meta: true }] });
    expect(
      keymapRefusal(withKeys(mine, "settings.open", [{ key: "j", meta: true }]), mine),
    ).toBeNull();
  });

  it("refuses the same key twice on one command", () => {
    expect(
      keymapRefusal(
        saved({
          "commands.search": [
            { key: "p", meta: true },
            { key: "P", meta: true },
          ],
        }),
        DEFAULT_SAVED_KEYMAP,
      ),
    ).toBe("Search commands lists ⌘P twice");
  });
});

describe("changes Keyboard settings makes", () => {
  it("saves the catalog's own keys as no change at all", () => {
    const changed = withKeys(DEFAULT_SAVED_KEYMAP, "commands.search", [{ key: "p", meta: true }]);
    expect(isChanged(changed, "commands.search")).toBe(true);
    expect(withKeys(changed, "commands.search", [{ key: "k", meta: true }])).toEqual(
      DEFAULT_SAVED_KEYMAP,
    );
    expect(withCatalogKeys(changed, "commands.search")).toEqual(DEFAULT_SAVED_KEYMAP);
    // A command chosen by name has no key to remove.
    expect(withKeys(DEFAULT_SAVED_KEYMAP, "cards.maximize", [])).toEqual(DEFAULT_SAVED_KEYMAP);
  });

  it("resets every command it knows and keeps the ones it does not", () => {
    const later = saved({
      "commands.search": [{ key: "p", meta: true }],
      "panes.split": [{ key: "j", meta: true }],
    });
    expect(withAllCatalogKeys(later)).toEqual(saved({ "panes.split": [{ key: "j", meta: true }] }));
  });

  it("saves only a key's own fields", () => {
    const extra = { key: "p", meta: true, shift: false, label: "x" } as unknown as KeyBinding;
    expect(withKeys(DEFAULT_SAVED_KEYMAP, "commands.search", [extra]).keys).toEqual({
      "commands.search": [{ key: "p", meta: true }],
    });
  });

  it("covers every command", () => {
    expect(Object.keys(resolveBindings(DEFAULT_SAVED_KEYMAP))).toEqual(COMMAND_IDS);
  });
});

describe("a panel's commands (docs/keyboard.md, \"A panel's commands\")", () => {
  const open = {
    id: panelCommandId("reading-list", "open"),
    label: "Open reading",
    panel: "Reading list",
    keys: [{ key: "j", meta: true }],
  } as const;
  const greedy = {
    id: panelCommandId("notes", "new"),
    label: "New note",
    panel: "Notes",
    // ⌘L is the catalog's: Go to the main message.
    keys: [{ key: "l", meta: true }],
  } as const;
  const later = {
    id: panelCommandId("notes", "open"),
    label: "Open notes",
    panel: "Notes",
    keys: [{ key: "j", meta: true }],
  } as const;

  it("gives a suggested key only where no other command already uses it", () => {
    const bindings = resolveBindings(DEFAULT_SAVED_KEYMAP, [open, greedy]);
    expect(keysOf(bindings, open.id)).toEqual([{ key: "j", meta: true }]);
    expect(keysOf(bindings, greedy.id)).toEqual([]);
    expect(bindings["focus.main-message"]).toEqual(DEFAULT_BINDINGS["focus.main-message"]);
    // The panel added first keeps the key both asked for.
    const both = resolveBindings(DEFAULT_SAVED_KEYMAP, [open, later]);
    expect(keysOf(both, open.id)).toEqual([{ key: "j", meta: true }]);
    expect(keysOf(both, later.id)).toEqual([]);
    expect(panelCommandFor(press("j", { meta: true }), both, [open, later])).toBe(open.id);
  });

  it("takes a key of a person's own, which wins over a catalog key it moved", () => {
    const moved = withKeyMoved(
      DEFAULT_SAVED_KEYMAP,
      resolveBindings(DEFAULT_SAVED_KEYMAP, [greedy]),
      greedy.id,
      { key: "l", meta: true },
      "replace",
      [greedy],
    );
    // The key it suggested is its own, so only the command it left is a change.
    expect(moved.keys).toEqual({ "focus.main-message": [] });
    expect(keymapRefusal(moved, DEFAULT_SAVED_KEYMAP, [greedy])).toBeNull();
    const bindings = resolveBindings(moved, [greedy]);
    expect(keysOf(bindings, greedy.id)).toEqual([{ key: "l", meta: true }]);
    expect(bindings["focus.main-message"]).toEqual([]);
  });

  it("names a clash with a panel's command by its words", () => {
    const bindings = resolveBindings(DEFAULT_SAVED_KEYMAP, [open]);
    const [clash] = clashesWith(bindings, "settings.open", { key: "j", meta: true }, [open]);
    expect(clash).toMatchObject({ id: open.id, kind: "same" });
    expect(clashWords("settings.open", clash as never, [open])).toContain("Open reading");
  });

  it("keeps a key saved for a panel that is not here now, unrun, until it comes back", () => {
    const saved = { version: 1 as const, keys: { [open.id]: [{ key: "k", ctrl: true }] } };
    expect(unknownCommands(saved)).toEqual([open.id]);
    expect(unknownCommands(saved, [open])).toEqual([]);
    expect(withAllCatalogKeys(saved).keys).toEqual(saved.keys);
    expect(withAllCatalogKeys(saved, [open]).keys).toEqual({});
    // Its own suggestion is no change at all.
    expect(withKeys(DEFAULT_SAVED_KEYMAP, open.id, open.keys, [open]).keys).toEqual({});
  });

  it("installs the panels' commands with the snapshot, so every reader lists them", () => {
    const snapshot = keymapSnapshot({ saved: DEFAULT_SAVED_KEYMAP, unreadable: false }, 2, [open]);
    expect(snapshot.panels).toEqual([open]);
    expect(keyHint(open.id, snapshot.bindings)).toBe("⌘J");
  });
});
