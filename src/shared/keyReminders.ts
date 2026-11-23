import { z } from "zod";
import { type AnyCommandId, type Bindings, keysOf } from "./keyboard";

/**
 * The key reminder (docs/keyboard.md, "The key reminder"; design skill
 * `components/core/KeyReminder.prompt.md`): after a mouse click on a control
 * whose command has a key, a quiet line at the bottom of the window names
 * the command and that key. It stops for a command once a person pressed
 * one of its keys, until its keys change. One switch in Keyboard settings
 * turns every reminder off.
 *
 * What this computer keeps: whether reminders show, and for each command
 * whose key was pressed, its keys as they were then (`keysSaid`), so a
 * change of key or preset lets the reminder show again.
 */
export const keyRemindersSchema = z.object({
  on: z.boolean(),
  pressed: z.record(z.string().min(1).max(64), z.string().max(4096)),
});
export type KeyReminders = z.infer<typeof keyRemindersSchema>;

/** A new profile's: on, with no key pressed yet. */
export const DEFAULT_KEY_REMINDERS: KeyReminders = { on: true, pressed: {} };

/**
 * The four card choice keys teach one thing, a card's answer by its number,
 * so pressing any of them stops the reminder for all four.
 */
const TAUGHT_TOGETHER: readonly (readonly AnyCommandId[])[] = [
  ["cards.choice-1", "cards.choice-2", "cards.choice-3", "cards.choice-4"],
];

export function taughtBy(id: AnyCommandId): readonly AnyCommandId[] {
  return TAUGHT_TOGETHER.find((group) => group.includes(id)) ?? [id];
}

/** A command's keys as one string, compared to say whether they changed since a press. */
export function keysSaid(bindings: Bindings, id: AnyCommandId): string {
  return JSON.stringify(keysOf(bindings, id));
}

/** Whether a click on `id`'s control shows its reminder now. */
export function remindsOf(reminders: KeyReminders, bindings: Bindings, id: AnyCommandId): boolean {
  if (!reminders.on || keysOf(bindings, id).length === 0) return false;
  return reminders.pressed[id] !== keysSaid(bindings, id);
}

/** What is kept once `id`'s key was pressed under `bindings`. */
export function withPressed(
  reminders: KeyReminders,
  bindings: Bindings,
  id: AnyCommandId,
): KeyReminders {
  const pressed = { ...reminders.pressed };
  for (const taught of taughtBy(id)) pressed[taught] = keysSaid(bindings, taught);
  return { ...reminders, pressed };
}
