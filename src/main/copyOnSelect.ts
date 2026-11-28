import type { BrowserWindow, MouseInputEvent, WebContents } from "electron";

/** A pointer drag shorter than this many pixels is a click, not a selection. */
const DRAG_PIXELS = 4;

export type Press = { x: number; y: number; clicks: number; before: string };

/**
 * Whether a left-button release ends a pointer selection: a drag across words
 * that changed what is selected, or a second or third click, which select a
 * word or a paragraph. A drag that left the same words selected moved a
 * panel, a card's edge or a file chip, and never copies.
 */
export function releaseSelects(press: Press, release: { x: number; y: number }, now: string) {
  // Blank space is no words: a double-click on empty room never replaces the clipboard.
  if (now.trim() === "") return false;
  if (press.clicks >= 2) return true;
  const moved = Math.hypot(release.x - press.x, release.y - press.y) >= DRAG_PIXELS;
  return moved && now !== press.before;
}

/**
 * The words selected in the focused frame, inside a field or outside it. It
 * runs in the frame's own world, which a card's content policy does not
 * bind, and reads only the selection. A password field reads as nothing.
 */
const SELECTED_WORDS = `(() => {
  try {
    const field = document.activeElement;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (field.type === "password") return "";
      const { selectionStart: start, selectionEnd: end } = field;
      if (start !== null && end !== null && start !== end) return field.value.slice(start, end);
    }
    return String(getSelection() ?? "");
  } catch {
    return "";
  }
})()`;

async function selectedWords(contents: WebContents): Promise<string> {
  try {
    const frame = contents.focusedFrame ?? contents.mainFrame;
    const words: unknown = await frame.executeJavaScript(SELECTED_WORDS);
    return typeof words === "string" ? words : "";
  } catch {
    return "";
  }
}

/**
 * Copy on select (docs/copy-on-select.md): while the switch is on, letting go
 * of the pointer after selecting words copies them as the copy key would. It
 * hears only the person's own presses, so a card's script cannot start a copy.
 */
export function followCopyOnSelect(win: BrowserWindow, enabled: () => boolean): void {
  const contents = win.webContents;
  let press: Promise<Press> | null = null;
  contents.on("before-mouse-event", (_event, mouse: MouseInputEvent) => {
    if (mouse.button !== "left") return;
    if (mouse.type === "mouseDown") {
      if (!enabled()) {
        press = null;
        return;
      }
      const { x, y, clickCount } = mouse;
      press = selectedWords(contents).then((before) => ({ x, y, clicks: clickCount ?? 1, before }));
      return;
    }
    if (mouse.type !== "mouseUp" || !press) return;
    const pressed = press;
    press = null;
    const release = { x: mouse.x, y: mouse.y };
    void (async () => {
      const down = await pressed;
      if (contents.isDestroyed() || !enabled()) return;
      // A double-click's word is selected at its second press; a drag's words are selected by now.
      if (releaseSelects(down, release, await selectedWords(contents))) contents.copy();
    })();
  });
}
