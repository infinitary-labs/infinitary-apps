/**
 * The captain's presses, counted (docs/keyboard.md, "Cards and frames"). A
 * card he pointed at takes the window's focus once it appears (`focusCard`),
 * unless he began another click or key since: that press decides where
 * focus goes, and a card that took focus in the middle of it would turn
 * away the click it ends in, such as one on the next Tasks row (INF-551).
 *
 * A press counts as it begins - a pointer going down, or a key that is not
 * a held key repeating - on the window's own page and inside every frame.
 * The page does not hear a press inside a frame, so each frame's bridge
 * says when one begins in its own window (`pressed`).
 */

let presses = 0;

/** How many presses the captain has begun in this window so far. */
export function pressesSoFar(): number {
  return presses;
}

/** Whether a frame's bridge says a press began in its window. */
function pressNotice(event: MessageEvent): boolean {
  const data: unknown = event.data;
  return typeof data === "object" && data !== null && "type" in data && data.type === "pressed";
}

/**
 * Counts every press the captain begins. Started before the window's first
 * render, so it is the first of the window's own listeners and counts a
 * press before any handler that press runs points at a card.
 */
export function countPresses(): () => void {
  const pointer = () => {
    presses += 1;
  };
  const key = (event: KeyboardEvent) => {
    if (!event.repeat) presses += 1;
  };
  const notice = (event: MessageEvent) => {
    if (pressNotice(event)) presses += 1;
  };
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("message", notice);
  return () => {
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("message", notice);
  };
}
