import { type AnyCommandId, isPanelCommandId, panelCommandId } from "@shared/keyboard";
import { DEFAULT_KEY_REMINDERS, type KeyReminders } from "@shared/keyReminders";
import { useSyncExternalStore } from "react";

/**
 * The key reminder's switch and the keys pressed, as the main process last
 * said them (docs/keyboard.md, "The key reminder"): the reminder and Keyboard
 * settings' switch read them. Until the first reading arrives, a new
 * profile's.
 */

let current: KeyReminders = DEFAULT_KEY_REMINDERS;
let following = false;
const listeners = new Set<() => void>();

function take(value: KeyReminders): void {
  current = value;
  for (const listener of listeners) listener();
}

function follow(): void {
  if (following || typeof window === "undefined" || !window.infinitary) return;
  following = true;
  window.infinitary.keyboard.onReminders(take);
  void window.infinitary.keyboard
    .reminders()
    .then(take)
    .catch(() => {});
}

export function keyReminders(): KeyReminders {
  follow();
  return current;
}

function subscribe(listener: () => void): () => void {
  follow();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKeyReminders(): KeyReminders {
  return useSyncExternalStore(subscribe, keyReminders, keyReminders);
}

/** Turns every key reminder on or off; the main process's push follows. */
export async function setKeyReminders(on: boolean): Promise<void> {
  take(await window.infinitary.keyboard.setReminders(on));
}

const panelClicks = new Set<(id: AnyCommandId) => void>();

/**
 * A panel's page heard a mouse click on one of its controls marked with
 * `command`, one of its own commands (`keys.clicked`, docs/keyboard.md "The
 * key reminder"): the window's page does not hear a click inside a frame,
 * so the reminder hears it here. The id is built from the panel the page
 * belongs to, so a page names only its own panel's commands.
 */
export function remindOfPanelClick(panel: string, command: string): void {
  const id = panelCommandId(panel, command);
  if (!isPanelCommandId(id)) return;
  for (const listener of panelClicks) listener(id);
}

export function onPanelKeyClick(listener: (id: AnyCommandId) => void): () => void {
  panelClicks.add(listener);
  return () => {
    panelClicks.delete(listener);
  };
}
