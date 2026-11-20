import { describe, expect, it } from "vitest";
import { keyHint } from "./keyboard";
import { keymapSnapshot, presetKeymap, withPreset } from "./keymap";
import { DEFAULT_KEY_REMINDERS, remindsOf, withPressed } from "./keyReminders";

/**
 * When the key reminder shows (INF-4555's accepted plan, direction A: "it
 * stops once the person has pressed that action's key"; docs/keyboard.md,
 * "The key reminder"), read against the keys a new profile's Vim preset and
 * Legacy install.
 */
const vim = keymapSnapshot({ saved: presetKeymap("vim"), unreadable: false }, 1).bindings;
const legacy = keymapSnapshot({ saved: presetKeymap("legacy"), unreadable: false }, 1).bindings;

describe("the key reminder", () => {
  it("shows for a command with a key until that key is pressed, and never while switched off", () => {
    expect(keyHint("cards.minimize", vim)).toBe("Q");
    expect(remindsOf(DEFAULT_KEY_REMINDERS, vim, "cards.minimize")).toBe(true);
    const pressed = withPressed(DEFAULT_KEY_REMINDERS, vim, "cards.minimize");
    expect(remindsOf(pressed, vim, "cards.minimize")).toBe(false);
    // Another command still shows its own.
    expect(remindsOf(pressed, vim, "settings.open")).toBe(true);
    expect(remindsOf({ ...DEFAULT_KEY_REMINDERS, on: false }, vim, "settings.open")).toBe(false);
  });

  it("shows nothing for a command with no key", () => {
    expect(keyHint("focus.card-body", legacy)).toBeUndefined();
    expect(remindsOf(DEFAULT_KEY_REMINDERS, legacy, "focus.card-body")).toBe(false);
  });

  it("stops ⌘1 to ⌘4 together, which teach one thing", () => {
    const pressed = withPressed(DEFAULT_KEY_REMINDERS, vim, "cards.choice-2");
    for (const id of [
      "cards.choice-1",
      "cards.choice-2",
      "cards.choice-3",
      "cards.choice-4",
    ] as const)
      expect(remindsOf(pressed, vim, id)).toBe(false);
  });

  it("shows again once the command's keys change, as another preset changes them", () => {
    const pressed = withPressed(DEFAULT_KEY_REMINDERS, vim, "cards.minimize");
    expect(keyHint("cards.minimize", legacy)).not.toBe(keyHint("cards.minimize", vim));
    expect(remindsOf(pressed, legacy, "cards.minimize")).toBe(true);
    // Back on Vim, the keys it was pressed under, it stays stopped.
    const back = keymapSnapshot(
      { saved: withPreset(presetKeymap("legacy"), "vim"), unreadable: false },
      2,
    ).bindings;
    expect(remindsOf(pressed, back, "cards.minimize")).toBe(false);
  });
});
