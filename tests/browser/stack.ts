/**
 * The card stack as a browser test reads it (docs/renderer.md, the stage):
 * the shown entry is the only one the captain can act on, while the stage may
 * also hold, inert and hidden, the successor it prepares and the drawing that
 * is leaving.
 */

import { expect } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import type { Answers, FakeBridge } from "./bridge";

/** A selector for the shown stack entry, once it is ready to read. */
export const SHOWN_ENTRY = '[data-card-layer] [data-stage-entry="shown"]:not([aria-hidden])';

export const shownEntry = () => document.querySelector<HTMLElement>(SHOWN_ENTRY);

export function inShown(selector: string): HTMLElement {
  const part = document.querySelector<HTMLElement>(`${SHOWN_ENTRY} ${selector}`);
  if (!part) throw new Error(`The shown card drew no ${selector}`);
  return part;
}

const shownFrame = (frameTitle: string) =>
  document.querySelector<HTMLIFrameElement>(
    `${SHOWN_ENTRY} iframe[title=${JSON.stringify(frameTitle)}]`,
  );

export const cardBodyFrame = (title: string) => shownFrame(`${title} body`);

/** The frame the shown card's settle facts draw in beside its buttons, or null when it has none. */
export const cardFactsFrame = (title: string) => shownFrame(`${title} facts`);

/**
 * Returns once the shown card titled `title` has drawn its body: its title
 * shows while the frame still holds the empty document it was born with
 * (docs/renderer.md), and loading the body replaces that document.
 */
export async function bodyDrawn(title: string): Promise<HTMLIFrameElement> {
  await expect.poll(() => cardBodyFrame(title)?.hasAttribute("data-frame-drawn")).toBe(true);
  return cardBodyFrame(title) as HTMLIFrameElement;
}

/**
 * Runs `read`, which closes over nothing, inside the frame titled
 * `frameTitle` with `argument`, and answers what it returns: a card draws its
 * body and its facts in sandboxed frames the page cannot script, so the
 * browser runs it there.
 */
export function inFrameTitled<T, A = null>(
  frameTitle: string,
  read: (argument: A) => T,
  argument?: A,
): Promise<Awaited<T>> {
  return commands.evaluateInFrame({ title: frameTitle }, read.toString(), argument) as Promise<
    Awaited<T>
  >;
}

export const inCardBody = <T, A = null>(title: string, read: (argument: A) => T, argument?: A) =>
  inFrameTitled(`${title} body`, read, argument);

/** INF-1879: read the shown card's shared minus through its chrome owner. */
export const cardLeave = (): HTMLElement => inShown("[data-card-leave]");

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
 * Pages to the card titled `title` with the next arrow, as the captain walks
 * the pager. The arrows go round past either end (INF-4541), so it walks at
 * most once round the pager, by its count, and the card must be in the stack.
 */
export async function showCard(title: string): Promise<void> {
  const region = page.getByRole("region", { name: title, exact: true });
  await expect.poll(() => document.querySelector(SHOWN_ENTRY)).not.toBeNull();
  const count = Number(
    document.querySelector("[data-card-pager]")?.getAttribute("data-pager-count") ?? "1",
  );
  for (let step = 1; step < count && !region.query(); step++) {
    await userEvent.click(page.getByRole("button", { name: "Next card", exact: true }));
    await stageAtRest();
  }
  await expect.element(region).toBeVisible();
  await stageAtRest();
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
