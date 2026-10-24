import { available } from "../../app/focusRecovery";
import { hearOut } from "../../app/presses";
import type { FrameController } from "./frameController";
import { GESTURE_FOCUS_FRAMES } from "./gestureFocusFrames";

export { GESTURE_FOCUS_FRAMES } from "./gestureFocusFrames";

/**
 * Focus and the frames (docs/keyboard.md, "Cards and frames"). A card's or
 * a panel's frame is a document of its own: the shell can give the frame
 * focus, but not the field inside it, and the frame's own scripts can say
 * anything. Two rules follow.
 *
 * - Giving focus back: when an overlay over the window closes (command
 *   search, the picture viewer), focus goes back to what had it. When that
 *   was a frame, the shell focuses the frame and tells its bridge, which
 *   puts focus back on the field, link or picture it last held, with the
 *   caret where it was.
 * - Counting a gesture: a frame's message that would open something over
 *   the window or in the browser, or move the captain's focus (a picture, a
 *   task, a link, leaving the body), counts only while that frame holds the
 *   window's focus, which the captain's own click or key gives it and its
 *   own script cannot take (FRAME_ALLOW). A message a script sends while
 *   focus is elsewhere opens nothing.
 */

type Tracked = { frame: React.RefObject<HTMLIFrameElement | null>; controller: FrameController };

const tracked = new Set<Tracked>();

/** Keeps a frame's controller findable by its iframe while it is attached; the result lets go. */
export function trackFrame(
  frame: React.RefObject<HTMLIFrameElement | null>,
  controller: FrameController,
): () => void {
  const entry = { frame, controller };
  tracked.add(entry);
  return () => {
    tracked.delete(entry);
  };
}

function controllerOf(frame: HTMLIFrameElement): FrameController | null {
  for (const entry of tracked) if (entry.frame.current === frame) return entry.controller;
  return null;
}

/**
 * The captain pointed from `frame`: a press begun there since may still
 * be on its way to the window until the frame answers (app/presses.ts).
 */
export function hearFrameOut(frame: HTMLIFrameElement | null): void {
  const controller = frame ? controllerOf(frame) : null;
  if (controller) hearOut(controller.heard());
}

/**
 * Gives focus back to `target`, which had it before an overlay took it: an
 * element of the shell, or a frame, whose bridge then puts focus back on
 * the element inside it that had it. Returns whether focus landed there.
 */
export function giveFocusBack(target: Element | null): boolean {
  if (!(target instanceof HTMLElement) || target === document.body || !available(target))
    return false;
  target.focus({ preventScroll: true });
  if (document.activeElement !== target) return false;
  if (target instanceof HTMLIFrameElement) controllerOf(target)?.returnFocus();
  return true;
}

/**
 * Gives `frame` back the focus the captain's own click or key had put in
 * it, the way his click had: through the frame's own window. Focus the
 * page puts on the frame element stays the page's active element when he
 * next clicks into another frame, so the page would go on naming this
 * frame while the other holds focus, and the window's guards and keys
 * would read focus where it is not. Returns whether focus landed there.
 */
function giveClickedFocusBack(frame: HTMLIFrameElement): boolean {
  if (!available(frame)) return false;
  frame.contentWindow?.focus();
  if (document.activeElement !== frame) return false;
  controllerOf(frame)?.returnFocus();
  return true;
}

/**
 * Gives `frame` the window's focus, as a click on it would, before the shell
 * asks its document to put focus somewhere inside, which the frame's own
 * script may do only while its frame holds focus (FRAME_ALLOW). Focus that
 * moved from this frame straight to another passes the page by, so the
 * page may still name this frame as its active element, and focusing it
 * again then moves nothing: the page lets go of it first.
 */
export function focusFrame(frame: HTMLIFrameElement | null): void {
  if (!frame) return;
  if (document.activeElement === frame) frame.blur();
  frame.focus({ preventScroll: true });
}

/** Whether the window's own page holds focus on nothing: no element of its own, and no frame. */
function restsOnNothing(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/**
 * The frame the window's own page took focus from by itself, onto nothing,
 * until the page gives it back: for one animation frame at most.
 */
let handedFrom: HTMLIFrameElement | null = null;

/**
 * Gives focus back to the frame the window's own page just took it from by
 * itself, while the page's focus still rests on nothing (guardFrameFocus):
 * the captain's own click or key had put it there, so it goes back the way
 * his click had (`giveClickedFocusBack`). Returns whether focus landed
 * there. The shell's way back to the main message asks this first
 * (`guardLostFocus`), so whichever runs first in that animation frame gives
 * focus back to the frame.
 */
export function giveHandedFocusBack(): boolean {
  const frame = handedFrom;
  handedFrom = null;
  return frame !== null && restsOnNothing() && giveClickedFocusBack(frame);
}

/**
 * Keeps the window's focus in the frame that holds it. Chromium keeps its
 * focus bookkeeping per renderer process, and every card's and panel's
 * frame has a process of its own. A frame born while focus is inside
 * another frame - the card the stage prepares behind the task board - has
 * not been told where focus is, so the next time the window takes focus
 * (it comes forward) that process gives the focus to the window's own
 * page, and the frame has lost the control it held, so keys reach nothing.
 *
 * Where the page's focus then rests depends on how focus went into the
 * frame. After the shell's own move it rests on the frame element: when
 * the page takes focus onto a frame and still holds it there a frame
 * later, the shell gives it back to the frame, whose bridge puts it on the
 * element it last held. After the captain's click or key inside the frame
 * it rests on nothing: the page remembers the frame focus was in when it
 * let focus go, or when that frame last spoke, and gives focus back to it
 * the same way, unless something else has taken focus by then.
 *
 * A click in the page itself is the captain's: it clears the focus off the
 * frame first, or it is a press in the page, so focus stays where the
 * click put it.
 */
export function guardFrameFocus(): () => void {
  let pageHolds = false;
  let pending: number | null = null;
  // The frame the window's focus was last seen in while the page did not hold it.
  let heldBy: HTMLIFrameElement | null = null;
  // A press in the page itself, until the next animation frame: the focus
  // it moves is the captain's, and it calls off giving focus back.
  let pressing = false;
  let released: number | null = null;
  const press = () => {
    handedFrom = null;
    pressing = true;
    released ??= requestAnimationFrame(() => {
      released = null;
      pressing = false;
    });
  };
  // Focus moves from one frame to another without the page hearing it,
  // so the page looks again whenever a frame speaks.
  const look = () => {
    const active = document.activeElement;
    if (!pageHolds && active instanceof HTMLIFrameElement) heldBy = active;
  };
  const blur = () => {
    pageHolds = false;
    handedFrom = null;
    const active = document.activeElement;
    heldBy = active instanceof HTMLIFrameElement ? active : null;
  };
  const focus = () => {
    pageHolds = true;
    const frame = document.activeElement;
    const from = heldBy;
    heldBy = null;
    if (!(frame instanceof HTMLIFrameElement)) {
      if (pressing || from === null || !restsOnNothing()) return;
      handedFrom = from;
    }
    if (pending !== null) return;
    // A shell's move, or the next control Tab reaches, takes focus a moment
    // after the page does: the frame gets it back only if nothing has by
    // the next animation frame.
    pending = requestAnimationFrame(() => {
      pending = null;
      if (!pageHolds || giveHandedFocusBack()) return;
      if (!(frame instanceof HTMLIFrameElement)) return;
      if (document.activeElement !== frame || !available(frame)) return;
      // The frame element already holds the page's focus, so focusing it
      // again moves nothing: it lets go first.
      frame.blur();
      giveFocusBack(frame);
    });
  };
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("mousedown", press, true);
  window.addEventListener("message", look);
  return () => {
    if (pending !== null) cancelAnimationFrame(pending);
    if (released !== null) cancelAnimationFrame(released);
    handedFrom = null;
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
    window.removeEventListener("pointerdown", press, true);
    window.removeEventListener("mousedown", press, true);
    window.removeEventListener("message", look);
  };
}

/**
 * Runs `then` if the frame holds the window's focus now or within
 * GESTURE_FOCUS_FRAMES animation frames; otherwise the gesture is not the
 * captain's and runs nothing, or `otherwise` when the caller does something
 * else with a gesture that is not his (a panel's card put up behind).
 */
export function whenFrameHoldsFocus(
  frame: () => HTMLIFrameElement | null,
  then: () => void,
  frames = GESTURE_FOCUS_FRAMES,
  otherwise?: () => void,
): void {
  const element = frame();
  if (element && document.activeElement === element) {
    then();
    return;
  }
  if (frames > 0)
    requestAnimationFrame(() => whenFrameHoldsFocus(frame, then, frames - 1, otherwise));
  else otherwise?.();
}

/** Whether the frame holds the window's focus now or within the gesture's few frames. */
export function frameHoldsFocus(frame: () => HTMLIFrameElement | null): Promise<boolean> {
  return new Promise((resolve) =>
    whenFrameHoldsFocus(
      frame,
      () => resolve(true),
      GESTURE_FOCUS_FRAMES,
      () => resolve(false),
    ),
  );
}
