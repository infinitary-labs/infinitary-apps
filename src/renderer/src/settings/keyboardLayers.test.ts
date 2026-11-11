import {
  COMMAND_IDS,
  commandFor,
  KEYBOARD_COMMANDS,
  type KeyBinding,
  type KeyPress,
  keysOf,
  menuAccelerator,
} from "@shared/keyboard";
import {
  bindingProblem,
  bindingWarning,
  DEFAULT_SAVED_KEYMAP,
  keymapRefusal,
  readSavedKeymap,
  resolveBindings,
  withKeys,
} from "@shared/keymap";
import { describe, expect, it } from "vitest";
import { keysAfterPress, recorderVerdict, savedAfterRecording } from "./keyRecorder";

// Intent: the accepted layers plan, piece 1. Real recorder/native key readings and saved version-1 keys.
const press: KeyPress = {
  key: "s",
  code: "KeyS",
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  composing: false,
  repeat: false,
};
const bare: KeyBinding = { key: press.key, when: "not-typing" };

describe("keys used when not typing", () => {
  it("records a bare key as not-typing, persists it and never resolves it in a field", () => {
    const bindings = resolveBindings(DEFAULT_SAVED_KEYMAP);
    const recorded = keysAfterPress("settings.open", null, press);
    expect(recorded).toEqual(bare);
    const saved = savedAfterRecording(
      DEFAULT_SAVED_KEYMAP,
      bindings,
      "settings.open",
      recorded,
      "replace",
    );
    expect(saved).not.toBeNull();
    const read = readSavedKeymap(saved);
    expect(read.unreadable).toBe(false);
    const installed = resolveBindings(read.saved);
    expect(keysOf(installed, "settings.open")).toEqual([bare]);
    expect(commandFor(press, {}, installed)).toBeUndefined();
    expect(commandFor(press, { field: "main-message" }, installed)).toBeUndefined();
    expect(commandFor(press, { field: "reply" }, installed)).toBeUndefined();
    expect(commandFor(press, { notTyping: true }, installed)).toBe("settings.open");
    expect(
      commandFor({ ...press, composing: true }, { notTyping: true }, installed),
    ).toBeUndefined();
    expect(menuAccelerator("settings.open", installed)).toBeUndefined();
  });

  // Captain's revised safety rule: warn about one-press answers, never block their selection.
  it("warns without refusing a plain or function key for every close-risk command", () => {
    const closeCommands = COMMAND_IDS.filter((id) => KEYBOARD_COMMANDS[id].risk === "close");
    expect(closeCommands.length).toBeGreaterThan(0);
    const bindings = resolveBindings(DEFAULT_SAVED_KEYMAP);
    for (const id of closeCommands) {
      for (const binding of [bare, { ...bare, shift: true }, { key: "F13" }]) {
        expect(bindingProblem(binding, id)).toBeNull();
        expect(bindingWarning(binding, id)).toBe(
          "One press of this key can answer or close a card. This can also happen while typing inside a card if Infinitary does not recognize its text field.",
        );
        expect(recorderVerdict(id, binding, bindings).kind).toBe("free");
        const saved = savedAfterRecording(DEFAULT_SAVED_KEYMAP, bindings, id, binding, "replace");
        expect(saved).not.toBeNull();
        if (!saved) throw new Error("A warned key must remain saveable");
        expect(keymapRefusal(saved, DEFAULT_SAVED_KEYMAP)).toBeNull();
        expect(keysOf(resolveBindings(saved), id)).toContainEqual(binding);
      }
      expect(bindingProblem({ key: "j", ctrl: true }, id)).toBeNull();
      expect(bindingWarning({ key: "j", ctrl: true }, id)).toBeNull();
    }
    expect(bindingWarning(bare, "settings.open")).toBeNull();
  });

  // Review regression: keys allowed by older versions must load and not poison other saves.
  it("loads earlier function-key answers and still saves an unrelated command", () => {
    const closeCommands = COMMAND_IDS.filter((id) => KEYBOARD_COMMANDS[id].risk === "close");
    const functionKey = { key: "F13" };
    for (const id of closeCommands) {
      const legacy = { version: 1 as const, keys: { [id]: [functionKey] } };
      const read = readSavedKeymap(legacy);
      expect(read).toEqual({ saved: legacy, unreadable: false });
      const installed = resolveBindings(read.saved);
      expect(commandFor({ ...press, key: "F13", code: "F13" }, {}, installed)).toBe(id);
      const changed = withKeys(read.saved, "settings.open", [
        { key: "s", meta: true, shift: true },
      ]);
      expect(keymapRefusal(changed, read.saved)).toBeNull();
      expect(keysOf(resolveBindings(changed), id)).toEqual([functionKey]);
    }
  });

  it("lets a modified window key share a field's editing key only outside typing", () => {
    const binding: KeyBinding = { key: "u", ctrl: true, when: "not-typing" };
    const saved = withKeys(DEFAULT_SAVED_KEYMAP, "settings.open", [binding]);
    expect(keymapRefusal(saved, DEFAULT_SAVED_KEYMAP)).toBeNull();
    const installed = resolveBindings(saved);
    const controlU = { ...press, key: "u", code: "KeyU", ctrl: true };
    expect(commandFor(controlU, { field: "main-message" }, installed)).toBe(
      "message.delete-to-line-start",
    );
    expect(commandFor(controlU, { notTyping: true }, installed)).toBe("settings.open");
    expect(menuAccelerator("settings.open", installed)).toBeUndefined();
  });

  it("keeps reserved controls and bare first chords out, and leaves old saved keys unchanged", () => {
    for (const key of [
      " ",
      "Enter",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ])
      expect(bindingProblem({ key, when: "not-typing" }, "settings.open")).not.toBeNull();
    // Piece 3 lets a bare first chord start two keys only when not typing.
    expect(bindingProblem({ ...bare, second: { key: "s" } }, "settings.open")).toBeNull();
    expect(
      bindingProblem({ key: press.key, second: { key: "s" } }, "settings.open"),
    ).not.toBeNull();
    expect(bindingProblem(bare, "message.recall")).not.toBeNull();
    const legacy = { version: 1 as const, keys: { "settings.open": [{ key: "p", meta: true }] } };
    expect(readSavedKeymap(legacy)).toEqual({ saved: legacy, unreadable: false });
    expect(
      commandFor({ ...press, key: "p", code: "KeyP", meta: true }, {}, resolveBindings(legacy)),
    ).toBe("settings.open");
  });
});
