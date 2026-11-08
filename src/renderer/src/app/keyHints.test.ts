import type { KeyBinding, PanelCommand } from "@shared/keyboard";
import { DEFAULT_SAVED_KEYMAP, resolveBindings } from "@shared/keymap";
import { describe, expect, it } from "vitest";
import { panelKeys } from "./keyHints";

/**
 * A panel's `keys` (docs/keyboard.md, "Key hints"): the keys its own
 * commands have in the installed map, read the way every key hint reads
 * them, by the command's id in the panel's manifest.
 */

const command = (id: PanelCommand["id"], keys: PanelCommand["keys"] = []): PanelCommand => ({
  id,
  label: id,
  panel: "Tasks",
  keys,
});

const panels = [
  command("panel:now/board", [{ key: "b", meta: true }]),
  command("panel:now/board-find"),
  command("panel:now/board-backlog"),
  command("panel:now/board-move"),
  command("panel:notes/find", [{ key: "j", meta: true }]),
];

function keymapWith(keys: Record<string, KeyBinding[]>) {
  const saved = { ...DEFAULT_SAVED_KEYMAP, keys: { ...keys } };
  return { bindings: resolveBindings(saved, panels), panels };
}

describe("a panel's keys", () => {
  it("lists its own commands that have a key, by manifest id, and leaves out the rest and other panels'", () => {
    const keymap = keymapWith({
      "panel:now/board-find": [{ key: "j", meta: true, ctrl: true }],
      "panel:now/board-backlog": [{ key: "F8" }],
    });
    expect(panelKeys("now", keymap)).toEqual({
      board: { keys: "⌘B", "aria-keyshortcuts": "Meta+B" },
      "board-find": { keys: "⌃⌘J", "aria-keyshortcuts": "Control+Meta+J" },
      "board-backlog": { keys: "F8", "aria-keyshortcuts": "F8" },
    });
    expect(panelKeys("notes", keymap)).toEqual({
      find: { keys: "⌘J", "aria-keyshortcuts": "Meta+J" },
    });
    expect(panelKeys("activity", keymap)).toEqual({});
  });

  it("draws each key as this computer does, and follows a key changed or removed", () => {
    const given = keymapWith({ "panel:now/board-move": [{ key: "m", ctrl: true, shift: true }] });
    expect(panelKeys("now", given, "mac")["board-move"]?.keys).toBe("⌃⇧M");
    expect(panelKeys("now", given, "ctrl")["board-move"]).toEqual({
      keys: "Ctrl+Shift+M",
      "aria-keyshortcuts": "Control+Shift+M",
    });
    const changed = keymapWith({ "panel:now/board-move": [{ key: "F9" }] });
    expect(panelKeys("now", changed)["board-move"]).toEqual({
      keys: "F9",
      "aria-keyshortcuts": "F9",
    });
    const removed = keymapWith({ "panel:now/board": [] });
    expect(panelKeys("now", removed)).toEqual({});
  });

  it("names no aria-keyshortcuts for a two-key shortcut, whose drawn keys it still shows", () => {
    const keymap = keymapWith({
      "panel:now/board-find": [{ key: "k", meta: true, second: { key: "f", meta: true } }],
    });
    expect(panelKeys("now", keymap)["board-find"]).toEqual({ keys: "⌘K ⌘F" });
  });
});
