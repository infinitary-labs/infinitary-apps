/**
 * A frame's click or key does not outlive its focus (docs/ui-plugins.md,
 * "Focus and the frames"). Chromium lets a frame's own script take focus
 * for about five seconds after the captain's last click or key inside it
 * (its user activation, which FRAME_ALLOW counts), so a script that waits
 * for focus to leave could take it straight back from the main message or
 * from another frame.
 *
 * So when focus comes back to the window's own page, by a press, a window
 * key, Tab or the shell's own move, the shell spends the page's user
 * activation, and Chromium spends it in every frame of the page at once.
 * The page hears its own focus before it tells Chromium where focus went,
 * so the frame's process learns its activation is spent before it learns
 * it lost focus: its script has nothing left to take focus with, even from
 * its own blur.
 *
 * Focus that moves from one frame straight to another passes the page by,
 * and the frame left learns it lost focus before the page can hear of the
 * move. So while a frame holds focus, the shell spends the activation as
 * soon as the pointer is over the page's own content, which it crosses on
 * its way to a click in any other frame. It spends it again when it sees
 * that focus moved from one frame to another: it reads where focus is
 * each time a frame speaks, and each frame's bridge says when its own
 * window gains or loses focus (`focused`). A script that takes focus back
 * in its very next task, before the spending reaches its frame, can still
 * win where the pointer never crossed the page: so for the activation's
 * lifespan after focus left a frame for another, focus that lands back in
 * it while no click or key of the captain's holds the page goes back to
 * the frame he moved to.
 *
 * The page's own reading of the captain's gesture survives the spending:
 * `windowGesture` still counts it for as long as it would have lasted, so a
 * press that brings focus back from a frame is still his own press to the
 * window's own gates.
 */

import { giveFocusBack } from "./frameFocus";

/** How long Chromium counts a click or key as the captain's (its transient activation's lifespan). */
const ACTIVATION_LIFESPAN_MS = 5_000;

/** Whether the page holds user activation now: a click or key of the captain's not yet spent. */
function pageActive(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

/** When the shell last spent the page's activation, or null. */
let spentAt: number | null = null;

/**
 * Spends the page's user activation, and with it every frame's: a window
 * open that the main process always refuses (src/main/security/navigation.ts)
 * is the one way the page can spend it without opening anything. Does
 * nothing while the page holds none.
 */
function spend(): void {
  if (!pageActive()) return;
  spentAt = performance.now();
  window.open("about:blank");
}

/**
 * Whether the captain's own click or key holds the window now: its page's
 * user activation, or one the shell spent less than its lifespan ago. The
 * window's own gates read this, never `navigator.userActivation` alone.
 */
export function windowGesture(): boolean {
  if (pageActive()) return true;
  return spentAt !== null && performance.now() - spentAt < ACTIVATION_LIFESPAN_MS;
}

/** The frame that holds the window's focus, or null when the window's own page does. */
function focusedFrame(): HTMLIFrameElement | null {
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement ? active : null;
}

/** What a frame's bridge says of its own window's focus: gained, lost, or nothing. */
function focusNotice(event: MessageEvent): boolean | null {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("type" in data) || !("focused" in data))
    return null;
  return data.type === "focused" && typeof data.focused === "boolean" ? data.focused : null;
}

/**
 * Spends the page's user activation each time focus comes back to the
 * window's own page, while a frame holds focus each time the pointer moves
 * over the page's own content, and each time focus moves from one frame to
 * another.
 */
export function guardFrameActivation(): () => void {
  // The frame the page last saw holding focus, or null while the page held it.
  let holder: HTMLIFrameElement | null = null;
  // Frames focus left for another frame, and when.
  const left = new Map<HTMLIFrameElement, number>();
  const leftLately = (frame: HTMLIFrameElement) => {
    const at = left.get(frame);
    if (at !== undefined && performance.now() - at < ACTIVATION_LIFESPAN_MS) return true;
    left.delete(frame);
    return false;
  };
  const focus = () => {
    holder = null;
    spend();
  };
  // The page's own move into a frame, or the captain's from the page.
  const blur = () => {
    holder = focusedFrame();
    if (holder !== null) left.delete(holder);
  };
  const pointer = () => {
    if (focusedFrame() !== null) spend();
  };
  const look = (event: MessageEvent) => {
    const now = focusedFrame();
    if (now !== null && holder !== null && now !== holder && leftLately(now) && !pageActive()) {
      // The frame the captain left took focus back with what was left of
      // his click or key in it: it goes back to the frame he moved to.
      giveFocusBack(holder);
      return;
    }
    if (now !== holder) {
      const from = holder;
      holder = now;
      if (from === null || now === null) return;
      spend();
      left.set(from, performance.now());
      return;
    }
    // A frame says it gained focus that the page does not see it hold, or
    // lost focus that the page still sees it hold: focus moved from one
    // frame to another and back before the page read where it was.
    const gained = focusNotice(event);
    if (gained === null || now === null) return;
    if (gained !== (event.source === now.contentWindow)) spend();
  };
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  window.addEventListener("pointermove", pointer, true);
  window.addEventListener("message", look);
  return () => {
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
    window.removeEventListener("pointermove", pointer, true);
    window.removeEventListener("message", look);
  };
}
