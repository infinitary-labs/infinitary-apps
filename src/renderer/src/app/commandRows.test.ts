import {
  APP_PANEL_COMMANDS_BEFORE,
  COMMAND_IDS,
  DEFAULT_BINDINGS,
  KEYBOARD_COMMANDS,
  keyHint,
  panelCommandId,
} from "@shared/keyboard";
import { DEFAULT_SAVED_KEYMAP, resolveBindings } from "@shared/keymap";
import { describe, expect, it } from "vitest";
import { commandMatches, commandRows, SEARCHED_COMMANDS, stepSelection } from "./commandRows";

describe("command search's list", () => {
  it("lists every window command but search itself, in the catalog's order", () => {
    expect(SEARCHED_COMMANDS).toEqual(
      COMMAND_IDS.filter(
        (id) => KEYBOARD_COMMANDS[id].scope === "window" && id !== "commands.search",
      ),
    );
  });

  it("finds the thread's command by the words a person might use for it", () => {
    for (const words of ["collapse", "chat"])
      expect(commandRows(words, () => null, DEFAULT_BINDINGS).map((row) => row.id)).toEqual([
        "cards.thread",
      ]);
    // "thread" also names the thread's jump down (INF-3124), after the thread itself.
    expect(commandRows("thread", () => null, DEFAULT_BINDINGS).map((row) => row.id)).toEqual([
      "cards.thread",
      "cards.thread-new",
    ]);
  });

  // INF-1690's accepted answer: no Secrets tab, and so no Open Secrets, until storage is enabled.
  it("lists Open Secrets only where this build keeps protected storage", () => {
    const ids = (secrets: boolean) =>
      commandRows("open secrets", () => null, DEFAULT_BINDINGS, { secrets }).map((row) => row.id);
    expect(ids(true)).toEqual(["settings.secrets"]);
    expect(ids(false)).toEqual([]);
  });

  it("lists a command that acts in Devices only where this build offers Devices", () => {
    const ids = (devices: boolean) =>
      commandRows("reach your macs", () => null, DEFAULT_BINDINGS, { devices }).map(
        (row) => row.id,
      );
    expect(ids(true)).toEqual(["devices.try-again"]);
    expect(ids(false)).toEqual([]);
    // A person who still says Mac finds it too.
    expect(
      commandRows("reach your computers", () => null, DEFAULT_BINDINGS, { devices: true }).map(
        (row) => row.id,
      ),
    ).toEqual(["devices.try-again"]);
    expect(commandRows("", () => null, DEFAULT_BINDINGS).map((row) => row.id)).not.toContain(
      "devices.try-again",
    );
  });

  it("keeps a command whose words hold every typed word, in any order and case", () => {
    expect(commandMatches("Show the next card", "CARD next")).toBe(true);
    expect(commandMatches("Show the next card", "  ")).toBe(true);
    expect(commandMatches("Show the next card", "previous")).toBe(false);
  });

  it("finds a command by the other words it names, as well as its label's", () => {
    const words = ["release", "notes"];
    expect(commandMatches("Show what's new", "release notes", words)).toBe(true);
    expect(commandMatches("Show what's new", "new notes", words)).toBe(true);
    expect(commandMatches("Show what's new", "release card", words)).toBe(false);
    expect(commandRows("release notes", () => null, DEFAULT_BINDINGS)).toEqual([
      { id: "whats-new.show", label: "Show what's new", keys: undefined, refusal: null },
    ]);
    for (const typed of ["new", "changes", "version"])
      expect(commandRows(typed, () => null, DEFAULT_BINDINGS).map((row) => row.id)).toContain(
        "whats-new.show",
      );
  });

  it("gives each row its key and its reason, read as the rows are drawn", () => {
    const rows = commandRows(
      "card",
      (id) => (id === "cards.previous" ? "This is the first card" : null),
      DEFAULT_BINDINGS,
    );
    expect(rows).toEqual([
      { id: "focus.card-reply", label: "Go to the card's reply", keys: "⇧⌘L", refusal: null },
      { id: "focus.card-body", label: "Go to the card's body", keys: undefined, refusal: null },
      {
        id: "focus.card-actions",
        label: "Go to the card's buttons",
        keys: undefined,
        refusal: null,
      },
      { id: "cards.choice-1", label: "Press the recommended choice", keys: "⌘1", refusal: null },
      { id: "cards.choice-2", label: "Press the second choice", keys: "⌘2", refusal: null },
      { id: "cards.choice-3", label: "Press the third choice", keys: "⌘3", refusal: null },
      { id: "cards.choice-4", label: "Press the fourth choice", keys: "⌘4", refusal: null },
      {
        id: "cards.previous",
        label: "Show the previous card",
        keys: "⇧⌘[",
        refusal: "This is the first card",
      },
      { id: "cards.next", label: "Show the next card", keys: "⇧⌘]", refusal: null },
      { id: "cards.minimize", label: "Put card aside", keys: "⇧⌘M", refusal: null },
      {
        id: "cards.done",
        label: "Press the note's Done or Got it",
        keys: undefined,
        refusal: null,
      },
      {
        id: "cards.decline",
        label: "Decline every choice on the card",
        keys: undefined,
        refusal: null,
      },
      { id: "cards.maximize", label: "Maximize or restore card", keys: undefined, refusal: null },
      // The approved desktop annotation plan makes Point at a searchable keyboard command.
      {
        id: "cards.point-at",
        label: KEYBOARD_COMMANDS["cards.point-at"].label,
        keys: keyHint("cards.point-at", DEFAULT_BINDINGS),
        refusal: null,
      },
      {
        id: "cards.thread",
        label: "Show or hide the card's thread",
        keys: "⌘\\",
        refusal: null,
      },
      // INF-2261: a task card's Cards tab is a command too ("tab_order: Info, Cards, ...").
      { id: "cards.show-cards", label: "Show Cards", keys: undefined, refusal: null },
    ]);
  });

  it("shows the keys the window has installed, a changed one and a removed one", () => {
    const bindings = resolveBindings({
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "cards.next": [{ key: "j", meta: true }], "focus.card-reply": [] },
    });
    expect(commandRows("card", () => null, bindings).map((row) => [row.id, row.keys])).toEqual([
      ["focus.card-reply", undefined],
      ["focus.card-body", undefined],
      ["focus.card-actions", undefined],
      ["cards.choice-1", "⌘1"],
      ["cards.choice-2", "⌘2"],
      ["cards.choice-3", "⌘3"],
      ["cards.choice-4", "⌘4"],
      ["cards.previous", "⇧⌘["],
      ["cards.next", "⌘J"],
      ["cards.minimize", "⇧⌘M"],
      ["cards.done", undefined],
      ["cards.decline", undefined],
      ["cards.maximize", undefined],
      ["cards.point-at", keyHint("cards.point-at", bindings)],
      ["cards.thread", "⌘\\"],
      ["cards.show-cards", undefined],
    ]);
    expect(commandRows("keyboard", () => null, bindings).map((row) => row.label)).toEqual([
      "Open Keyboard settings",
    ]);
  });

  it("moves the chosen row with the arrows, wrapping at either end", () => {
    expect(stepSelection(3, 0, 1)).toBe(1);
    expect(stepSelection(3, 2, 1)).toBe(0);
    expect(stepSelection(3, 0, -1)).toBe(2);
    expect(stepSelection(0, 0, 1)).toBe(-1);
    expect(stepSelection(3, -1, -1)).toBe(2);
  });
});

describe("a panel's commands in command search (docs/keyboard.md, \"A panel's commands\")", () => {
  const open = {
    id: panelCommandId("reading", "open"),
    label: "Open reading",
    panel: "Reading list",
    keys: [{ key: "j", meta: true }],
  } as const;
  const find = {
    id: panelCommandId("reading", "find"),
    label: "Find a piece",
    panel: "Reading list",
    keys: [],
  };

  it("follows the catalog's, under its panel's title, found by its words or its panel's", () => {
    const bindings = resolveBindings({ ...DEFAULT_SAVED_KEYMAP, keys: {} }, [open, find]);
    const refused = (id: string) => (id === find.id ? "Reading list has nothing to show" : null);
    const rows = commandRows("", refused, bindings, { devices: false }, [open, find]);
    expect(rows.slice(-2)).toEqual([
      { id: open.id, label: "Open reading", panel: "Reading list", keys: "⌘J", refusal: null },
      {
        id: find.id,
        label: "Find a piece",
        panel: "Reading list",
        keys: undefined,
        refusal: "Reading list has nothing to show",
      },
    ]);
    expect(
      commandRows("reading list", refused, bindings, { devices: false }, [open, find]).map(
        (row) => row.id,
      ),
    ).toEqual([open.id, find.id]);
    expect(
      commandRows("piece", refused, bindings, { devices: false }, [open, find]).map(
        (row) => row.id,
      ),
    ).toEqual([find.id]);
  });

  it("finds a panel's command by the other words its manifest names", () => {
    const board = {
      id: panelCommandId("now", "board"),
      label: "Open task board",
      panel: "Tasks",
      keys: [],
      words: ["kanban", "columns"],
    };
    const bindings = resolveBindings({ ...DEFAULT_SAVED_KEYMAP, keys: {} }, [board]);
    const ids = (query: string) =>
      commandRows(query, () => null, bindings, { devices: false }, [board]).map((row) => row.id);
    expect(ids("kanban")).toEqual([board.id]);
    expect(ids("tasks board")).toEqual([board.id]);
    expect(ids("spreadsheet")).toEqual([]);
  });

  it("lists the app's own panels' commands as the window's own: among the catalog's, under no title", () => {
    const board = {
      id: panelCommandId("now", "board"),
      label: "Open task board",
      panel: "Tasks",
      keys: [{ key: "b", meta: true }],
      own: true as const,
    };
    const bindings = resolveBindings({ ...DEFAULT_SAVED_KEYMAP, keys: {} }, [open, board]);
    const rows = commandRows("", () => null, bindings, { devices: false }, [open, board]);
    const ids: string[] = rows.map((row) => row.id);
    // After the stage's commands, before Settings; other panels' still follow the catalog's.
    expect(ids.indexOf(board.id)).toBe(ids.indexOf(APP_PANEL_COMMANDS_BEFORE) - 1);
    expect(ids.at(-1)).toBe(open.id);
    expect(rows.find((row) => row.id === board.id)).toEqual({
      id: board.id,
      label: "Open task board",
      keys: "⌘B",
      refusal: null,
    });
    // "board" finds it before Open Keyboard settings, and its panel's title does not.
    const found = (query: string) =>
      commandRows(query, () => null, bindings, { devices: false }, [open, board]).map(
        (row) => row.id,
      );
    expect(found("board").slice(0, 2)).toEqual([board.id, "settings.keyboard"]);
    expect(found("tasks")).not.toContain(board.id);
  });
});
