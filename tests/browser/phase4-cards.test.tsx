import type { CardAction } from "@shared/cards";
import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { type Rect, within } from "./layout";
import { bodyDrawn, cardBodyFrame, inCardBody, inShown, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Phase 4 acceptance (docs/architecture.md §17): a crewmate's cards wear
 * the chrome their shape derives (a card with actions is a decision, one
 * without a note), and a decision reads whole at the smallest window - its
 * long footer actions stay whole and usable, a long body reads to its end
 * by scrolling the card, its extra prose opens on demand without deciding
 * anything, and a reply begun on it survives paging away. One window with
 * the crewmate's three cards - a decision, a note and a working preview -
 * in the journey's order: the footer, the long body, then the prose and the
 * draft.
 */

const LONG_ACTION =
  "Mock the clock while preserving every queued write in its original execution order";
const DEFAULT_ACTION = "Await the queue";
const CHOICE_TITLE = "Two ways to fix the flaky test";
const NOTE_TITLE = "Quota note";
const PREVIEW_TITLE = "Course preview";
const LEAD = "Awaiting the job queue removes the race entirely.";
const DETAIL = "Awaiting the queue adds 40ms to the run.";
const DISCLOSURE = "Latency trade-off";

/** A figure the decision's body draws, named `label`, from `from` to `to`. */
const figure = (label: string, from: string, to: string) =>
  `<figure><svg viewBox="0 0 320 62" width="100%" role="img" aria-label="${label}">` +
  '<rect x="4" y="9" width="136" height="44" rx="6" style="fill:var(--bg-1);stroke:var(--line-2)"></rect>' +
  '<rect x="180" y="9" width="136" height="44" rx="6" style="fill:var(--accent-dim);stroke:var(--accent)"></rect>' +
  '<path d="M140 31 H174 M166 25 L174 31 L166 37" fill="none" style="stroke:var(--fg-2)"></path>' +
  '<g font-size="14" text-anchor="middle" style="fill:var(--fg-1)">' +
  `<text x="72" y="36">${from}</text><text x="248" y="36">${to}</text></g></svg></figure>`;

/** The crewmate's three cards, in the order it showed them. */
const CARDS: { title: string; body: string; actions: CardAction[] }[] = [
  {
    title: CHOICE_TITLE,
    body:
      `<p>${LEAD}</p>` +
      '<p class="inf-muted">Mocking time leaves write order uncertain.</p>' +
      figure("Mock clock can leave the race", "Mock clock", "Race can return") +
      '<p class="inf-muted">Awaiting the queue orders both writes.</p>' +
      figure("Await queue orders the writes", "Await queue", "Ordered writes") +
      `<details><summary>${DISCLOSURE}</summary><p>${DETAIL}</p></details>`,
    actions: [
      { id: "mock-clock", label: LONG_ACTION },
      { id: "await-queue", label: DEFAULT_ACTION, default: true },
    ],
  },
  {
    title: NOTE_TITLE,
    body:
      '<p>Codex weekly at <span class="inf-mono">41%</span> - routing stays put.</p>' +
      '<svg viewBox="0 0 200 8" width="100%" role="img" aria-label="Codex weekly quota">' +
      '<rect width="200" height="8" rx="4" style="fill:var(--bg-3)"></rect>' +
      '<rect width="82" height="8" rx="4" style="fill:var(--accent)"></rect></svg>' +
      "<details><summary>Windows</summary><h6>Weekly</h6>" +
      "<p><mark>41%</mark> used, resets Fri.</p></details>",
    actions: [],
  },
  {
    title: PREVIEW_TITLE,
    body: [
      "<style>.course-row{display:flex;gap:14px;padding:6px 0}</style>",
      "<h2>Course options</h2>",
      '<p class="inf-muted">Pick a heading; this preview is sandboxed.</p>',
      '<div class="course-row">',
      '<button type="button" data-inf-action="hold-course">Hold course</button>',
      '<button type="button" data-inf-action="new-course">Plot new course</button>',
      "</div>",
    ].join(""),
    actions: [
      { id: "hold-course", label: "Hold course" },
      { id: "new-course", label: "Plot new course", default: true },
    ],
  },
];

/** The shown card's own surface: the card the captain sees, inside the stage's envelope. */
const cardSurface = () =>
  document.querySelector<HTMLElement>("[data-card-layer] [data-card-presentation]");

/** The shown card's scrolling body. */
const cardScroller = () => inShown("[data-card-body]");

/** The pager of a stack of `count`, whatever position it shows. */
const pager = (count: number) =>
  document.querySelector(`[data-card-pager][data-pager-count="${count}"]`);

/** The shown card's reply field. */
const replyField = () => inShown("[data-card-reply] textarea") as HTMLTextAreaElement;

const box = (element: Element): Rect => element.getBoundingClientRect();

/**
 * Pages to the card titled `title` from wherever the stack is: back to the
 * top, then forward until it shows, as the captain walks the pager.
 */
async function showCard(title: string): Promise<void> {
  const shown = () => page.getByRole("region", { name: title, exact: true }).query();
  const arrow = (name: string) =>
    page.getByRole("button", { name, exact: true }).query() as HTMLButtonElement | null;
  await expect.poll(() => document.querySelector(SHOWN_ENTRY)).not.toBeNull();
  for (let previous = arrow("Previous card"); previous && !previous.disabled; ) {
    await userEvent.click(previous);
    await stageAtRest();
    previous = arrow("Previous card");
  }
  for (let next = arrow("Next card"); !shown() && next && !next.disabled; ) {
    await userEvent.click(next);
    await stageAtRest();
    next = arrow("Next card");
  }
  await expect.element(page.getByRole("region", { name: title, exact: true })).toBeVisible();
  await stageAtRest();
}

/** Whether the paragraph of the shown card's body that reads `text` shows. */
function bodyTextShows(title: string, text: string): Promise<boolean> {
  return inCardBody(
    title,
    (wanted) =>
      [...document.querySelectorAll("p, summary")].some(
        (element) => element.textContent === wanted && element.checkVisibility(),
      ),
    text,
  );
}

test("a decision reads whole at the smallest window: its footer, its long body, its extra prose and a reply draft", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ cards: CARDS })));
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => pager(3)).not.toBeNull();

  // Section: long footer actions stay whole and usable at the smallest window.
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await showCard(CHOICE_TITLE);
  for (const name of [LONG_ACTION, DEFAULT_ACTION]) {
    const action = page
      .getByRole("region", { name: CHOICE_TITLE, exact: true })
      .getByRole("button", { name, exact: true });
    await expect.element(action).toBeVisible();
    await expect.element(action).toBeEnabled();
    await stageAtRest();
    const button = action.element();
    // A press would land on it: the point at its middle finds the button itself.
    const middle = box(button);
    const hit = document.elementFromPoint(
      middle.x + middle.width / 2,
      middle.y + middle.height / 2,
    );
    expect(hit !== null && button.contains(hit), `a press on ${name} lands on it`).toBe(true);
    const card = cardSurface();
    if (!card) throw new Error("The stage shows no card");
    expect(within(box(button), box(card)), `${name} is not cut off`).toEqual([]);
  }
  await openSize();

  // Section: a long decision body reads to its end by scrolling the card.
  await showCard(CHOICE_TITLE);
  await bodyDrawn(CHOICE_TITLE);
  // The card's own document, not the frame's first empty one.
  await expect.poll(() => bodyTextShows(CHOICE_TITLE, LEAD)).toBe(true);
  await inCardBody(CHOICE_TITLE, () => {
    const overflow = document.createElement("div");
    overflow.dataset.overflowProof = "";
    overflow.innerHTML = Array.from(
      { length: 80 },
      (_, index) => `<p>Decision evidence row ${index + 1}</p>`,
    ).join("");
    document.body.appendChild(overflow);
  });
  // Scrolling the card reaches the body's last line.
  await expect
    .poll(async () => {
      const scroller = cardScroller();
      scroller.scrollTop = scroller.scrollHeight;
      const frame = cardBodyFrame(CHOICE_TITLE);
      if (!frame) return ["the body's frame is gone"];
      const row = await inCardBody(CHOICE_TITLE, () => {
        const last = [...document.querySelectorAll("p")].find(
          (p) => p.textContent === "Decision evidence row 80",
        );
        const r = last?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      });
      if (!row) return ["the last row is not drawn"];
      const offset = box(frame);
      return within({ ...row, x: row.x + offset.x, y: row.y + offset.y }, box(cardScroller()));
    })
    .toEqual([]);
  await inCardBody(CHOICE_TITLE, () => document.querySelector("[data-overflow-proof]")?.remove());

  // Section: a decision reveals its extra prose on demand at the smallest
  // window, and keeps a reply draft across paging.
  {
    // A reply begun on this card is still there after paging away and back.
    const draft = "Keep this draft";
    await userEvent.fill(replyField(), draft);
    await showCard(NOTE_TITLE);
    await showCard(CHOICE_TITLE);
    await expect.poll(() => replyField().value).toBe(draft);
    await userEvent.fill(replyField(), "");

    await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
    await bodyDrawn(CHOICE_TITLE);
    expect(await bodyTextShows(CHOICE_TITLE, DETAIL)).toBe(false);
    const toggle = () =>
      inCardBody(
        CHOICE_TITLE,
        (summary) =>
          [...document.querySelectorAll<HTMLElement>("summary")]
            .find((element) => element.textContent === summary)
            ?.click(),
        DISCLOSURE,
      );
    await toggle();
    await expect.poll(() => bodyTextShows(CHOICE_TITLE, DETAIL)).toBe(true);
    // Opening it decided nothing: the card and its choice are still there.
    expect(pager(3)).not.toBeNull();
    await expect
      .element(page.getByRole("button", { name: DEFAULT_ACTION, exact: true }))
      .toBeEnabled();
    expect(bridge.requests("inf:cards:act")).toEqual([]);
    await toggle();
    await expect.poll(() => bodyTextShows(CHOICE_TITLE, DETAIL)).toBe(false);
    await openSize();
  }
  expect(bridge.requests("inf:cards:reply")).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
