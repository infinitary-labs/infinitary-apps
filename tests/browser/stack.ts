/**
 * The card stack as a browser test reads it (docs/renderer.md, the stage):
 * the shown entry is the only one the captain can act on, while the stage may
 * also hold, inert and hidden, the successor it prepares and the drawing that
 * is leaving.
 */

import type { Answers, FakeBridge } from "./bridge";

/** A selector for the shown stack entry, once it is ready to read. */
export const SHOWN_ENTRY = '[data-card-layer] [data-stage-entry="shown"]:not([aria-hidden])';

/** The shown stack entry, or null while none is ready. */
export const shownEntry = () => document.querySelector<HTMLElement>(SHOWN_ENTRY);

/** The shown card's part `selector`; it throws when the shown card drew none. */
export function inShown(selector: string): HTMLElement {
  const part = document.querySelector<HTMLElement>(`${SHOWN_ENTRY} ${selector}`);
  if (!part) throw new Error(`The shown card drew no ${selector}`);
  return part;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Returns once the stage has finished what a change of the shown entry
 * starts: nothing is leaving and nothing on it moves, then two frames, the
 * first drawing the stage at rest and the second starting after it.
 */
export async function stageAtRest(): Promise<void> {
  const moving = () =>
    document.querySelector('[data-card-layer] [data-stage-entry="outgoing"]') !== null ||
    [
      ...document.querySelectorAll(
        "[data-card-layer] :is([data-stage-entry], [data-card-peek], [data-card-presentation])",
      ),
    ].some((part) => part.getAnimations().some((animation) => animation.playState === "running"));
  while (moving()) await nextFrame();
  await nextFrame();
  await nextFrame();
}

/**
 * Answers the stack's own requests as the core does, over the cards the
 * seeded `home` read: a closed card leaves the stack and the window is told
 * the stack the core holds now, and each drawn update is accepted.
 */
export function answerStack(bridge: FakeBridge, home: Answers): void {
  const listed = home["inf:cards:list"];
  if (!Array.isArray(listed)) throw new Error("The seeded home read no cards");
  let cards = listed;
  bridge.answer("inf:cards:close", (id) => {
    cards = cards.filter((card) => card.id !== id);
    const held = cards;
    setTimeout(() => bridge.push("inf:cards", held));
    return { ok: true };
  });
  bridge.answer("inf:cards:seen-update", { ok: true });
}
