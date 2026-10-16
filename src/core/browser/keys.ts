/**
 * The keys a crewmate can press in its task browser (`infinitary-browser-axi press`),
 * one closed list both the command and the host read.
 */
export const BROWSER_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
] as const;

export type BrowserKey = (typeof BROWSER_KEYS)[number];
