import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { keymapSnapshot, presetKeymap } from "@shared/keymap";
import { remindsOf } from "@shared/keyReminders";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { KeyReminderStore } from "./keyReminders";

/**
 * The key reminder's switch and the keys pressed are remembered on this
 * computer across restarts (INF-4555's accepted plan, "remembered on this
 * computer across restarts"; docs/keyboard.md, "The key reminder").
 */
const vim = keymapSnapshot({ saved: presetKeymap("vim"), unreadable: false }, 1).bindings;

describe("KeyReminderStore", () => {
  it("keeps a pressed key and the switch across a restart, telling each change", () => {
    const path = join(scratchDir("key-reminders"), "key-reminders.json");
    const first = new KeyReminderStore(path);
    expect(first.current().on).toBe(true);
    const told: boolean[] = [];
    first.subscribe((value) => told.push(value.on));
    first.pressed("cards.minimize", vim);
    first.setOn(false);
    expect(told).toEqual([true, false]);

    const again = new KeyReminderStore(path);
    expect(again.current().on).toBe(false);
    expect(remindsOf({ ...again.current(), on: true }, vim, "cards.minimize")).toBe(false);
    expect(remindsOf({ ...again.current(), on: true }, vim, "settings.open")).toBe(true);
  });

  it("reads a file it cannot understand as a new profile's, on", () => {
    const path = join(scratchDir("key-reminders"), "key-reminders.json");
    writeFileSync(path, "{ not json");
    expect(new KeyReminderStore(path).current()).toEqual({ on: true, pressed: {} });
  });
});
