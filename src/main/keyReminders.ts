import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivate } from "@core/devices/identity";
import type { AnyCommandId, Bindings } from "@shared/keyboard";
import {
  DEFAULT_KEY_REMINDERS,
  type KeyReminders,
  keyRemindersSchema,
  withPressed,
} from "@shared/keyReminders";

/**
 * The key reminder's switch and the keys a person pressed (docs/keyboard.md,
 * "The key reminder"), kept in one file of this computer's own, whichever
 * first mate its window follows: a reminder teaches the keyboard in front of
 * the person. The one writer of that file. A file that cannot be read is a
 * new profile's, and the next change saves over it.
 */
export class KeyReminderStore {
  private value: KeyReminders;
  private readonly listeners = new Set<(value: KeyReminders) => void>();

  constructor(private readonly path: string) {
    this.value = read(path);
  }

  current(): KeyReminders {
    return this.value;
  }

  /** Turns every reminder on or off. */
  setOn(on: boolean): KeyReminders {
    if (this.value.on !== on) this.save({ ...this.value, on });
    return this.value;
  }

  /** A key of `id` was pressed under `bindings`: its reminder stops until its keys change. */
  pressed(id: AnyCommandId, bindings: Bindings): void {
    const next = withPressed(this.value, bindings, id);
    if (JSON.stringify(next.pressed) !== JSON.stringify(this.value.pressed)) this.save(next);
  }

  subscribe(listener: (value: KeyReminders) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private save(next: KeyReminders): void {
    this.value = next;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writePrivate(this.path, JSON.stringify(next));
    } catch (error) {
      // The window still follows the change for this run.
      console.warn(`[key reminders] could not save: ${(error as Error).message}`);
    }
    for (const listener of this.listeners) listener(next);
  }
}

function read(path: string): KeyReminders {
  try {
    return keyRemindersSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_KEY_REMINDERS;
  }
}
