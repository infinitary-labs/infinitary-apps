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

export function pressesSoFar(): number {
  return presses;
}

/**
 * A frame's `pressed` reaches the page in the order the frame sent it, but
 * apart from everything else the page does: the captain points from a
 * frame and presses there at once, and the page can read the task
 * pointed at and show its card before the press is heard, when the frame's
 * process sends it late (INF-1146). So a pointing from a frame asks the
 * frame to answer (`FrameController.heard`), and the card it brings forward
 * decides on focus once every frame asked has answered: each has said by
 * then every press it began before it answered.
 */
let unheard = 0;
const deciding: (() => void)[] = [];

/** A frame was asked to answer: presses it began may be on their way until `answered` settles. */
export function hearOut(answered: Promise<unknown>): void {
  unheard += 1;
  const heard = () => {
    unheard -= 1;
    if (unheard === 0) for (const decide of deciding.splice(0)) decide();
  };
  void answered.then(heard, heard);
}

export function oncePressesHeard(decide: () => void): void {
  if (unheard === 0) decide();
  else deciding.push(decide);
}

/**
 * Whether a frame's bridge says a press began in its window. The window reads
 * it twice: the press count here, and the key reminder, which a press inside a
 * frame takes away (./KeyReminder.tsx).
 */
export function pressNotice(event: MessageEvent): boolean {
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
