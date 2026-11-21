import type { ElementHandle, FrameLocator, Locator, Page } from "@playwright/test";
import { GESTURE_FOCUS_FRAMES } from "../../src/renderer/src/plugins/frames/gestureFocusFrames";

/**
 * Waits out messages a frame sent while focus was elsewhere before a
 * journey checks that nothing opened or gives the frame the captain's focus.
 * Use after the script has finished sending, so no pending synthetic gesture
 * can borrow the real press's focus during the app's grace frames.
 */
export async function frameGesturesDecided(page: Page): Promise<void> {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const next = () => {
          if (--frames === 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    GESTURE_FOCUS_FRAMES + 1,
  );
}

/**
 * The one door to a card's or panel's frame (docs/e2e-contracts.md, "Frames
 * are read through the door"). A frame's title shows while its page still
 * holds the empty first document, and a one-shot read of that document
 * (a count, a text, a size) answers "nothing there" once in a few runs. The
 * app marks a frame `data-frame-drawn` when its page has drawn, so every
 * frame a journey reads is selected through that mark: whatever the journey
 * then asks of it waits for the drawing, or fails loudly because it never
 * came. A journey that is about the frame's own states (not drawn yet,
 * held while the next draws) reads the element with the `…Element` helpers,
 * which carry no mark.
 *
 * Nothing under `tests/e2e/*.spec.ts` names an `iframe` or a
 * `frameLocator`; the `e2e-frame-door` lint refuses both. Panel- and
 * card-specific doors live beside their subjects (`rails.ts`, `stack.ts`,
 * `panelCards.ts`) and are built here.
 */

const DRAWN = "[data-frame-drawn]";

type Scope = Page | Locator;

/** The frame matching `selector`, once its page has drawn; `selector` names an `iframe`. */
export function drawnFrame(scope: Scope, selector: string): FrameLocator {
  return scope.frameLocator(`${selector}${DRAWN}`);
}

/**
 * The window's state while the rails are folded: a wide card, a card with
 * its thread beside it, a maximized card or the main message at a larger
 * Size takes their width (`data-rails-folded` on the document, `foldRails`),
 * and every panel on them sits outside the window.
 */
// biome-ignore lint/plugin/e2e-layout-state: Readiness must reach an offscreen rail before it can paint; this does not assert its layout.
const RAILS_FOLDED = "[data-rails-folded]";

/**
 * A rail panel's frame matching `selector`, once its page has drawn, or as
 * it stands while the rails are folded. Chromium runs no animation frame in
 * a frame outside the window, so a panel whose page mounted after the fold
 * (the window reloaded with a card's thread open) draws, and is marked,
 * only once the rails unfold. Its page still holds what it rendered: a
 * locator in it waits for its element as usual, while a one-shot read of a
 * folded panel can still meet the empty first document.
 */
export function railFrame(scope: Page, selector: string): FrameLocator {
  return scope.frameLocator(`${selector}${DRAWN}, ${RAILS_FOLDED} ${selector}`);
}

/** The iframe element matching `selector`, drawn or not: for a journey about the frame's own states. */
export function frameElement(scope: Scope, selector: string): Locator {
  return scope.locator(selector);
}

/** The iframe element the card titled `title` draws its body in. */
export function cardBodyElement(page: Scope, title: string): Locator {
  return frameElement(page, cardBodySelector(title));
}

/** The body of the card titled `title`, once drawn. */
export function cardBody(page: Scope, title: string): FrameLocator {
  return drawnFrame(page, cardBodySelector(title));
}

/**
 * The page in the card titled `title` whatever the frame holds: drawn or not.
 * For a journey about a frame that stops drawing (a body that navigates
 * itself away), where `cardBody` would wait for a mark that never returns.
 */
export function cardBodyAsHeld(page: Scope, title: string): FrameLocator {
  return page.frameLocator(cardBodySelector(title));
}

/** The selector of a card's body frame, for a script that resolves it inside the window itself. */
export function cardBodySelector(title: string): string {
  return `iframe[title="${title} body"]`;
}

/** The selector of whichever card body frame a surface holds, for a script that resolves it inside the window. */
export const ANY_CARD_BODY_SELECTOR = 'iframe[title$=" body"]';

/** The selector of the frame inside `scope` (a hook, not a spec's own word), for a script that resolves it itself. */
export function frameSelectorIn(scope: string): string {
  return `${scope} iframe`;
}

/** The iframe element of the Observe panel (a development or alpha build's). */
export function observeElement(page: Page): Locator {
  return frameElement(page, 'iframe[title="Observe"]');
}

/** The Observe panel's page, once drawn. */
export function observeBody(page: Page): FrameLocator {
  return drawnFrame(page, 'iframe[title="Observe"]');
}

/**
 * One look at the frame inside `holder`, drawn or not, never a wait:
 * `fallback` when it holds no page yet or the read fails, otherwise `read`
 * run in its page. For a journey that samples states in order, where a wait
 * would miss one that lasts a moment, and where the frame may never be
 * marked drawn: a crewmate's draft sits outside the window, where Chromium
 * runs no animation frame (`railFrame`). A sample of the empty first
 * document answers `fallback`, and the next sample looks again.
 */
export async function readFrameNow<T>(
  holder: ElementHandle,
  read: () => T,
  fallback: T,
): Promise<T> {
  const frame = await (await holder.$("iframe"))?.contentFrame();
  if (!frame) return fallback;
  return (await frame.evaluate(read).catch(() => fallback)) as T;
}

/**
 * One read of `frame`'s page, run on its body, as a poll samples a page the
 * stage may take away: `gone` when the window holds no such frame, or when
 * its page is torn down while the read runs. The stage retires a card's page
 * once the card has paged out, and a read caught in that moment fails with
 * the frame detached or its page's context destroyed; `expect.poll` stops
 * at a read that throws instead of looking again, so the read answers what
 * the next look would: nothing there. Whether the page was torn down is the
 * window's own fact, that the frame's element has left it, never the
 * error's words; a page in a process of its own can report its context
 * destroyed before Playwright marks its frame detached, while the element
 * left the window first. Any other failure still throws, as a second frame
 * matching does.
 */
export async function readFrameOnce<T>(
  frame: FrameLocator,
  read: (body: HTMLElement) => T | Promise<T>,
  gone: T,
): Promise<T> {
  const holders = await frame.owner().elementHandles();
  try {
    if (holders.length > 1) throw new Error(`${holders.length} frames match ${frame.owner()}`);
    const [holder] = holders;
    const held = await holder?.contentFrame();
    if (!holder || !held) return gone;
    try {
      return await held.locator("body").evaluate(read);
    } catch (error) {
      if (!(await holder.evaluate((element) => element.isConnected))) return gone;
      throw error;
    }
  } finally {
    await Promise.all(holders.map((holder) => holder.dispose()));
  }
}

/** The iframe element of a side panel, by its id. */
export function panelElement(page: Page, panelId: string): Locator {
  return frameElement(page, `[data-side-panel="${panelId}"] iframe`);
}

/** A side panel's page, by its id, once drawn or while the rails are folded (`railFrame`). */
export function panelBody(page: Page, panelId: string): FrameLocator {
  return railFrame(page, `[data-side-panel="${panelId}"] iframe`);
}

/** The iframe element inside `scope`, the one surface that holds a single frame. */
export function frameIn(scope: Scope): Locator {
  return frameElement(scope, "iframe");
}

/** The page inside the only frame in `scope`, once drawn. */
export function bodyIn(scope: Scope): FrameLocator {
  return drawnFrame(scope, "iframe");
}

/** The iframe element of the card the stage prepares while the captain reads. */
export function warmElement(page: Page): Locator {
  return frameElement(page, '[data-stage-entry="warm"] iframe');
}

/**
 * The prepared card's page once it is drawn or held: the stage keeps the
 * previous drawing standing while the next card's page draws behind it.
 */
export function warmBody(page: Page): FrameLocator {
  return page.frameLocator(
    '[data-stage-entry="warm"] iframe:is([data-frame-drawn], [data-frame-held])',
  );
}

/** The iframe element inside `scope` once its page has drawn: for a journey that waits on the mark itself. */
export function drawnFrameIn(scope: Scope): Locator {
  return frameElement(scope, `iframe${DRAWN}`);
}
