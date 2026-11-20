import { prefersReducedMotion } from "./reducedMotion";

/**
 * Whether the home character has finished fading behind the card stack.
 * The loops keep their clocks, state, signals and agents; they skip canvas
 * drawing and label writes only after the fade (docs/renderer.md).
 */
let hidden = false;

export function setCharacterPaintHidden(next: boolean): void {
  hidden = next;
}

/**
 * Whether a loop's frame skips its drawing: only after the fade, and only a
 * moving frame on a canvas that already holds a picture. A canvas that
 * mounted or was resized behind the stack draws once, and the reduced-motion
 * still always draws: it has no next frame to catch up on when the character
 * shows again.
 */
export function skipHiddenPaint(holdsPicture: boolean): boolean {
  return hidden && holdsPicture && !prefersReducedMotion();
}
