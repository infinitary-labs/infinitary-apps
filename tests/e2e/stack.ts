import {
  type ElectronApplication,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  CARD_CHAT_LABEL,
  MERGE_CLOSES_MARK,
  SETTLE_FACT_VALUE_CLASS,
  SETTLE_FACTS,
  type SettleFact,
} from "../../src/shared/cards";
import type { ComposerNotice } from "../../src/shared/composer";
import { ENDED_CLOSE_CARD_LABEL, ENDED_CLOSE_LABEL } from "../../src/shared/endedCard";
import type { PushChannel, PushPayload } from "../../src/shared/ipc";
import type { RiskDimension } from "../../src/shared/risk";
import { drawnFrame } from "./frames";
import { takeTurn } from "./inputQueue";
import { promptInput } from "./prompt";
import { focusOn } from "./windowKeys";

/**
 * Paging helpers for the card stack.
 *
 * The stack sorts by priority, then oldest first, so two cards of the same
 * priority land in whichever order their timestamps fell - and a crewmate
 * that emits several in one turn can write them inside the same millisecond.
 * The mock crewmate emits two decisions (one of them a working preview), so
 * which of the two tops the stack is not a contract a test should hold the
 * app to: these helpers ask for a card by name and for the stack by size.
 */

/**
 * INF-2022: a drawn foreground update is read only once its owner records it.
 * A refusal baseline must include that real reading, not race its quiet timeline entry.
 */
export async function expectUpdateSeen(page: Page, cardId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.infinitary.cards.list()).find((card) => card.id === id)?.currentUpdateSeen,
        cardId,
      ),
    )
    .toBe(true);
}

/**
 * Returns once the captain has seen the open card titled `title`: the stage
 * drew it in the window in front of them and its owner recorded the reading.
 * A card its author ends stays up, ended, only after this (INF-3071), so a
 * journey waits here before the step that has its author end it.
 */
export async function expectCardSeen(page: Page, title: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (wanted) =>
            (await window.infinitary.cards.list()).find((card) => card.title === wanted)?.seen,
          title,
        ),
      { message: `the card titled "${title}" was seen` },
    )
    .toBe(true);
}

/**
 * Pushes a card list to the window as the host's card stack does when it
 * refreshes its cards (`CardService`'s broadcast on the core's `inf:cards`
 * push), so a journey can land a refresh at a moment it holds, such as
 * while a press is down. The channel and the list's shape are the push
 * contract's (`src/shared/ipc.ts`), so a renamed channel or a changed card
 * fails the typecheck here rather than pushing nothing. INF-2456 repairs
 * the hand-built pushes INF-2417's ledger found in two journeys.
 */
export async function pushCards(
  app: ElectronApplication,
  cards: PushPayload<"inf:cards">,
): Promise<void> {
  const channel: PushChannel = "inf:cards";
  await app.evaluate(
    ({ BrowserWindow }, { channel, cards }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(channel, cards);
    },
    { channel, cards },
  );
}

/** The pager of a stack of `count`, whatever position is shown; its words are the stack's own. */
export const pager = (page: Page, count: number) =>
  page.locator(`[data-card-pager][data-pager-count="${count}"]`);

/** The pager showing card `position` of a stack of `count`. */
export const pagerAt = (page: Page, position: number, count: number) =>
  page.locator(`[data-card-pager][data-pager-position="${position}"][data-pager-count="${count}"]`);

/** Pages forward from the shown card until the requested card draws or the stack wraps. */
export async function showCard(page: Page, title: string): Promise<void> {
  const heading = shownCard(page, title);
  const next = page.getByRole("button", { name: "Next card", exact: true });
  const ready = readyEntry(page);
  const seen = new Set<string>();
  // A lone card has no pager. If another card is joining it, wait for the
  // pager or for the target itself to draw before deciding how to navigate.
  await expect(heading.or(next).first()).toBeVisible();
  await expect(ready).toHaveCount(1);
  while (!(await heading.isVisible())) {
    const id = await ready.getAttribute("data-stage-entry-id");
    if (!id) throw new Error("The shown card has no entry id");
    if (seen.has(id) || !(await next.isVisible())) break;
    seen.add(id);
    await next.click();
    // Rows may join or leave the stack while it pages. Wait for a different
    // card to be ready to read, not the number it would have in the old stack.
    await expect
      .poll(
        () =>
          ready.evaluateAll((entries, previousId) => {
            const currentId = entries[0]?.getAttribute("data-stage-entry-id");
            return entries.length === 1 && Boolean(currentId) && currentId !== previousId;
          }, id),
        { message: `A different card draws while looking for "${title}"` },
      )
      .toBe(true);
  }
  await expect(heading).toBeVisible();
}

/**
 * The shown stack entry, the only one the captain can act on. The stage may
 * also hold, inert and hidden, the successor it prepares while the captain
 * reads and the drawing that is leaving (docs/renderer.md); a selector for
 * "the shown card's X" starts here.
 */
export const SHOWN_ENTRY = '[data-card-layer] [data-stage-entry="shown"]';
export const shownEntry = (page: Page) => page.locator(SHOWN_ENTRY);

/**
 * The shown card titled `title`, found by the region its surface is named by
 * in lone and stacked presentations alike - never by the title's words, which
 * the last turn's reply and its live status may repeat (docs/composer.md "The
 * last turn"). It is there only once the shown entry is ready to read.
 */
export const shownCard = (page: Page, title: string) =>
  shownEntry(page).getByRole("region", { name: title, exact: true });

/**
 * The shown card's meta line (`data-card-meta`): who wrote it -
 * `cardMetaWords(FIRSTMATE_CARD_META)` on the Firstmate's own card - read on that card
 * alone, never page-wide.
 */
export const cardMeta = (page: Page, title: string) =>
  shownCard(page, title).locator("[data-card-meta]");

/**
 * Returns once no open card is titled `title`: the core's stack holds none
 * (`cards.list`) and the stage shows none. A close, or the choice that
 * resolved the card, is the core's state; a page-wide lookup by the title's
 * words would also meet the last turn's reply and a record's card line,
 * which may still say it.
 */
export async function expectNoCard(
  page: Page,
  title: string,
  options: { timeout?: number } = {},
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (wanted) =>
            (await window.infinitary.cards.list()).some((card) => card.title === wanted),
          title,
        ),
      { message: `no open card is titled "${title}"`, ...options },
    )
    .toBe(false);
  await expect(shownCard(page, title)).toHaveCount(0, options);
}

/** The shown entry once it is ready to read and act on: until then it is hidden from assistive technology. */
const readyEntry = (page: Page) => page.locator(`${SHOWN_ENTRY}:not([aria-hidden])`);

/** The shown card's body frame, whatever its title. */
export const shownCardFrame = (page: Page) => drawnFrame(page, `${SHOWN_ENTRY} iframe`);

/**
 * Returns once the stage has finished what a change of the shown entry
 * starts: nothing is leaving, and the card a close would bring up has its
 * page prepared and drawn (docs/renderer.md). Every card's and panel's page
 * runs in a process of its own, and one prepared while the keyboard is in
 * another page has not been told where focus is: the next time the window
 * is focused, it hands focus to the window's own page, which gives it back
 * (docs/keyboard.md, "Cards and frames"). Playwright's keyboard focuses the
 * window with every key, so a key could land in that hand-off. A journey
 * that drives a page's keys after the stage changed waits here, then puts
 * the keyboard in that page with a command, which tells every page where
 * focus is, or goes through `focusFrameAfterStage`.
 */
export async function stagePrepared(page: Page): Promise<void> {
  await expect(page.locator('[data-card-layer] [data-stage-entry="outgoing"]')).toHaveCount(0);
  await expect(
    page.locator(
      '[data-card-layer] [data-stage-entry="warm"] iframe:is([data-frame-drawn], [data-frame-held])',
    ),
  ).toHaveCount(1);
}

/**
 * `stagePrepared`, then focus in `frame`, a card's or a panel's frame
 * element, brought there from the window's own page as the shell moves it,
 * so Chromium tells every page where focus is. A focus move inside a frame
 * tells no other page, and a page the stage prepared meanwhile then hands
 * the window's focus to the window's own page at Playwright's next key,
 * which can be lost (docs/keyboard.md, "Cards and frames"). A journey whose
 * next Playwright key goes into a frame right after the stage changed
 * starts here, then focuses the control it presses inside `frame`. Focus
 * leaves for `from`, a place in the window's own page that takes focus: the
 * main message, or the shown entry where no subscription leaves the main
 * message disabled.
 */
export async function focusFrameAfterStage(
  page: Page,
  frame: Locator,
  from: Locator = promptInput(page),
): Promise<void> {
  await stagePrepared(page);
  await focusOn(from);
  await focusOn(frame);
}

/**
 * Returns once the stage has come to rest and the window has drawn it at
 * rest: nothing is leaving, and the shown entry, the cards peeking behind it
 * and the card's height have finished their moves (`stageMoves.ts`,
 * `cardPresentation.ts`). Chromium sends a native press to the page it
 * finds under the pointer in what the window last drew, and as a move ends
 * that can be stale: a press on the shown card's page then lands on the
 * window's own page, on the frame's element, so the page inside never hears
 * it and its field never takes focus. Before that, a card that replaces
 * another is untouchable until its body draws: the stage keeps the drawing
 * it replaces in front of it, behind a shield that takes the pointer, so a
 * wheel turn aimed at it scrolls nothing (docs/renderer.md). A journey whose
 * native press or wheel turn goes into the shown card right after the stage
 * changed waits here, as the captain clicks or scrolls a card once it has
 * come to rest.
 */
export async function stageAtRest(page: Page): Promise<void> {
  await expect(page.locator('[data-card-layer] [data-stage-entry="outgoing"]')).toHaveCount(0);
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll(
          "[data-card-layer] :is([data-stage-entry], [data-card-peek], [data-card-presentation])",
        ),
      ].every((moving) =>
        moving.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    undefined,
    { polling: "raf" },
  );
  // Two frames: the first draws the stage at rest, the second starts after it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * A click inside a card's frame: a picture, a link or an answer in a card's
 * body, or a button on a panel card's page. Chromium drops a native click
 * into a sandboxed frame while the window is hidden, so the press is played
 * in the frame as a real one lands: it focuses the target, a stop of its
 * own (the shell opens a picture or a link, and brings a panel's card to the
 * front, only from a frame that holds focus, docs/keyboard.md "Cards and
 * frames"), then clicks it.
 */
export async function clickInBody(target: Locator): Promise<void> {
  await takeTurn(target.page(), async () => {
    await target.focus();
    await target.dispatchEvent("click");
  });
}

/**
 * The shown card's own surface: a lone card, or the card and its thread as one
 * pair. Its box is the card the captain sees; the `[data-card-layer]` around it
 * is the stage's fixed envelope, which keeps its top while the card moves inside.
 */
export const cardSurface = (page: Page) =>
  page.locator("[data-card-layer] [data-card-presentation]");

/**
 * The shown card's revised line under its title ("Revised 14:02 · 2 parts
 * new", "Rewritten 14:02"), absent on a card unchanged since the captain
 * last saw it (design skill ResponseCard, "revised line").
 */
export const revisedLine = (page: Page) => page.locator(`${SHOWN_ENTRY} [data-card-revised]`);

/**
 * A card body's change bars and the parts they mark: one bar per part new
 * since the captain last saw the card, drawn by the frame stylesheet.
 */
export function changeMarks(frame: FrameLocator): { parts: Locator; bars: Locator } {
  return { parts: frame.locator("[data-inf-changed]"), bars: frame.locator("[data-inf-bar]") };
}

/** The outer body scroll surface, shared by lone cards and the card column of a thread. */
export const cardScroller = (page: Page) => page.locator(`${SHOWN_ENTRY} [data-card-body]`);

/**
 * The captain's drag on the shown lone card's right edge, to `width` px. The
 * card grows from its centre by twice the pointer's travel (design skill
 * ResponseCard, widths), so the pointer travels half the difference. The
 * drag holds while the card is up; a double click on an edge gives back the
 * width the host decided.
 */
export async function dragCardTo(page: Page, width: number): Promise<void> {
  const edge = page.locator('[data-card-layer] [data-card-edge="right"]');
  const shown = Number(await edge.getAttribute("aria-valuenow"));
  // The pointer holds the edge beside the card's own chrome, above its body,
  // and travels over that chrome. In the hidden test window, synthetic moves
  // across the sandboxed body frame can be lost, release and all, so the
  // edge never hears them (docs/architecture.md, sharp edges).
  const grip = await page.evaluate((shown) => {
    const edge = document.querySelector('[data-card-layer] [data-card-edge="right"]');
    const body = document.querySelector(`${shown} [data-card-body]`);
    if (!edge || !body) return null;
    const strip = edge.getBoundingClientRect();
    const top = Math.min(body.getBoundingClientRect().top, strip.bottom);
    return { x: Math.round(strip.x + strip.width / 2), y: Math.round((strip.top + top) / 2) };
  }, SHOWN_ENTRY);
  if (!grip) throw new Error("The shown card has no right edge or no body");
  const { x, y } = grip;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (width - shown) / 2, y, { steps: 4 });
  await page.mouse.up();
  await expect(edge).toHaveAttribute("aria-valuenow", String(width));
}

/** The approved annotation flow reads its card's thread, including the column beside the body. */
export function cardThread(page: Page, cardId: string): Locator {
  return page.locator(`[data-card-thread=${JSON.stringify(cardId)}]:visible`);
}

/**
 * The shown card's one field and its Chat (INF-924): the field above the
 * card's choices with Chat at the right edge of their row, or both at the
 * foot of the thread open beside the card.
 */
export function cardReply(page: Page): {
  row: Locator;
  field: Locator;
  send: Locator;
  pictures: Locator;
  notice: (kind: ComposerNotice) => Locator;
} {
  const row = page.locator(`${SHOWN_ENTRY} [data-card-reply]`);
  return {
    row,
    field: row.getByRole("textbox"),
    send: page.locator(SHOWN_ENTRY).getByRole("button", { name: CARD_CHAT_LABEL, exact: true }),
    pictures: row.locator("[data-card-reply-picture]"),
    notice: (kind) => row.locator(`[data-composer-notice="${kind}"]`),
  };
}

/**
 * The shown completion card's ordinary merge control, never its check-override action (F27).
 * The host owns its label (including the delivery posture), so a journey
 * finds what the action does and reads its words from the card itself.
 */
export async function completionAction(page: Page, title: string): Promise<Locator> {
  const label = await page.evaluate(async (wanted) => {
    const card = (await window.infinitary.cards.list()).find((card) => card.title === wanted);
    return card?.actions.find((action) => !action.passes && action.effect?.kind === "merge")?.label;
  }, title);
  if (!label) throw new Error(`Card "${title}" has no completion action`);
  return page.locator("[data-card-layer]").getByRole("button", { name: label, exact: true });
}

/** A settle card's fact strip, as the stage shows it above the card's buttons. */
export type FactsStrip = Readonly<Record<SettleFact, Locator>> & {
  /** The strip's own page, once drawn: for a read that may meet its card paging out (`readFrameOnce`). */
  readonly page: FrameLocator;
  /** The strip itself. */
  readonly strip: Locator;
  /** A fact's whole item, where its `title` rides: a state of the status line, or a part of its reference. */
  readonly cell: (fact: SettleFact) => Locator;
  /** A state's words on rest, on the line the keyboard's focus shows under the states. */
  readonly rest: (fact: SettleFact) => Locator;
  /** Why a state needs the captain, in the open under the status line. */
  readonly why: (fact: SettleFact) => Locator;
  /** The facts the strip holds, in the order it shows them. */
  readonly facts: () => Promise<SettleFact[]>;
  /** The app's line saying whether the merge closes the task (INF-2490), at the left end of the buttons row. */
  readonly mergeLine: Locator;
};

/**
 * The host's fact strip above the buttons of the card whose body frame this
 * is, found by the fact each item carries (`data-fact`), never by its label's
 * words. Each fact's locator is its value, whose text is the value alone (a
 * status dot draws no text).
 */
export function factsStrip(frame: FrameLocator): FactsStrip {
  const card = frame.owner().locator("xpath=ancestor::section[@data-response-card][1]");
  const page = card.frameLocator("[data-card-facts] iframe[data-frame-drawn]");
  const strip = page.locator("[data-facts]");
  const cell = (fact: SettleFact) => strip.locator(`[data-fact="${fact}"]`);
  const values = Object.fromEntries(
    SETTLE_FACTS.map((fact) => [fact, cell(fact).locator(`.${SETTLE_FACT_VALUE_CLASS}`)]),
  ) as Record<SettleFact, Locator>;
  return {
    ...values,
    page,
    strip,
    cell,
    rest: (fact) => strip.locator(`[data-rest="${fact}"]`),
    why: (fact) => strip.locator(`[data-why="${fact}"]`),
    // The stage draws the line in the window, with the buttons it describes.
    mergeLine: card.locator(`[${MERGE_CLOSES_MARK}]`),
    facts: () =>
      strip
        .locator("[data-fact]")
        .evaluateAll((found) => found.map((each) => each.getAttribute("data-fact") as SettleFact)),
  };
}

/**
 * A card body's first element its author wrote. A merge card's body starts
 * with the app's own spacer for the risk chart beside the headline
 * (`data-inf-inset`, docs/card-authoring.md "The risk chart"), which is not
 * the author's.
 */
export const authoredFirst = (frame: FrameLocator) =>
  frame.locator("body > :not([data-inf-inset])").first();

/** A merge card's risk chart, as the shown card's chrome draws it. */
export type RiskChartReader = {
  /** The chart's box at the card's top right. */
  readonly chart: Locator;
  /** A dimension's dot, a keyboard stop carrying its level in `data-risk-level`. */
  readonly dot: (dimension: RiskDimension) => Locator;
  /** A dimension's label on the outer ring, `data-lit` while its dot is read. */
  readonly axis: (dimension: RiskDimension) => Locator;
  /** A dimension's note beside the chart, there only while its dot is read. */
  readonly note: (dimension: RiskDimension) => Locator;
  /** Every note open now: one at most. */
  readonly notes: Locator;
};

/**
 * The shown card's risk chart (docs/card-authoring.md "The risk chart"),
 * found by the marks the chrome paints - the dimension each dot, label and
 * note carries - never by their words.
 */
export function riskChart(page: Page): RiskChartReader {
  const chart = page.locator(`${SHOWN_ENTRY} [data-risk-chart]`);
  return {
    chart,
    dot: (dimension) => chart.locator(`[data-risk-dot="${dimension}"]`),
    axis: (dimension) => chart.locator(`[data-risk-axis="${dimension}"]`),
    note: (dimension) => chart.locator(`[data-risk-note="${dimension}"]`),
    notes: chart.locator("[data-risk-note]"),
  };
}

/** INF-1879: every card's one leaving control is owned here, not by copied labels. */
export const cardLeave = (page: Page, scope: Locator = shownEntry(page)) =>
  scope.locator("[data-card-leave]").and(shownEntry(page).locator("[data-card-leave]"));

/** A live note's one footer button, Done or Got it (INF-2794); the minus only puts it aside. */
export const noteDone = (page: Page, scope: Locator = shownEntry(page)) =>
  scope.locator("[data-note-done]").and(shownEntry(page).locator("[data-note-done]"));

/** The shown card's ended line in its thread (INF-3071), with its own Close card button. */
export const endedLine = (page: Page) => shownEntry(page).locator("[data-thread-ended]");
/** The ended line's own Close card button. */
export const endedCloseCard = (page: Page) =>
  endedLine(page).getByRole("button", { name: ENDED_CLOSE_CARD_LABEL, exact: true });

/**
 * Returns once the card titled `title`, ended by its author while the
 * captain had seen it, is on the stack marked ended (INF-3071), shown, with
 * its line and one Close: the record closed it, the stack keeps it.
 */
export async function expectEndedCard(
  page: Page,
  title: string,
  options: { timeout?: number } = {},
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (wanted) =>
            (await window.infinitary.cards.list()).some(
              (card) => card.title === wanted && card.ended !== undefined,
            ),
          title,
        ),
      { message: `the card titled "${title}" is ended`, ...options },
    )
    .toBe(true);
  await showCard(page, title);
  await expect(endedLine(page)).toBeVisible();
  await expect(noteDone(page)).toContainText(ENDED_CLOSE_LABEL);
}

/** Closes the ended card titled `title` with its one Close, and returns once it left. */
export async function closeEndedCard(
  page: Page,
  title: string,
  options: { timeout?: number } = {},
): Promise<void> {
  await expectEndedCard(page, title, options);
  await noteDone(page).click();
  await expectNoCard(page, title);
}

/** The shown card's answer summary, never a retained or outgoing card's copy. */
export const cardAnswersLine = (page: Page) => shownEntry(page).locator("[data-card-answers]");

/** Put a decision away and restore it through the same saved-visibility door its Tasks row uses. */
export async function putAwayAndRestore(page: Page, title: string): Promise<void> {
  const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === title,
  );
  if (!card) throw new Error(`No open card titled ${title}`);
  await cardLeave(page).click();
  await expect(shownCard(page, title)).toBeHidden();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).find(
          (entry) => entry.id === card.id,
        )?.minimized,
    )
    .toBe(true);
  await page.evaluate((id) => window.infinitary.cards.minimize(id, false), card.id);
  await showCard(page, title);
}

/** The safe saved-visibility request retained for older views; the current note corner puts aside too. */
export async function minimizeForLegacyView(page: Page, title: string): Promise<void> {
  const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === title,
  );
  if (!card) throw new Error(`No open card titled ${title}`);
  await page.evaluate((id) => window.infinitary.cards.minimize(id, true), card.id);
  await expect(shownCard(page, title)).toBeHidden();
}

/** No confirmation dialog may interrupt the shared minus. */
export const closeQuestion = (page: Page) => page.getByRole("dialog");

/**
 * Read notes and put choices away before an unrelated journey; hide records
 * first. A note's Got it or Done reads it and the corner request puts every
 * other card aside, and the stage is waited on until it agrees.
 * The window's drawing of the stack lags
 * the core's state by a push, so a cleanup that reads the drawing and
 * presses × on it fails whenever the card leaves between the read and the
 * press (three fixes of this helper in a day, each for a new gap between
 * what the window showed and what the core had already done). A card a
 * crewmate re-files after its close is closed again until the stack is
 * empty.
 */
export async function closeOpenCards(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const open = await window.infinitary.cards.list();
          await Promise.all(
            open.map((card) =>
              card.noteDone && !card.noteDone.closesTask
                ? window.infinitary.cards.noteDone(card.id)
                : window.infinitary.cards.close(card.id),
            ),
          );
          return open.filter((card) => !card.minimized).length;
        }),
      { message: "the core holds no card on the stage" },
    )
    .toBe(0);
  await expect(page.locator("[data-card-layer] [data-stage-entry]")).toHaveCount(0);
}
