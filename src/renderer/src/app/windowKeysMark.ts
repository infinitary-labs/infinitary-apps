/**
 * What the window's keys do now, as a hidden mark on the document
 * (`data-window-keys`) that the end-to-end tests wait on before they press a
 * key (docs/keyboard.md, "Who runs a window command"). A person never sees
 * it, and nothing in the app reads it.
 *
 * - absent: the shell does not follow the window's commands yet, so the key
 *   of a command the shell runs would do nothing;
 * - `commands`: the shell follows them (`followShellCommands`);
 * - `recording`: the main process records a key for Keyboard settings, so
 *   every key goes to the recorder alone.
 */
export type WindowKeysMark = "commands" | "recording";

export function markWindowKeys(mark: WindowKeysMark | null): void {
  const root = document.documentElement;
  if (mark === null) root.removeAttribute("data-window-keys");
  else root.setAttribute("data-window-keys", mark);
}
