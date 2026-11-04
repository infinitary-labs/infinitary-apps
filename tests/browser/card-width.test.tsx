import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import type { Rect } from "./layout";
import { SHOWN_ENTRY, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Card width (the captain's Q5 to Q7 A of 2026-09-28; docs/card-authoring.md
 * "Card width"), moved from `tests/e2e/card-width.spec.ts`: the captain's
 * drag resizes a card and holds while it is up, the keyboard widens it too,
 * and a double click gives back the width the host decided. The widths
 * themselves are `cardGeometry.test.ts`'s. One window with the crewmate's
 * four notes and the activity dock open, so the wide card folds it.
 */

const TITLES = {
  defaultWide: "The drawing uses the wide card",
  regular: "The meter row reads on first paint",
  wide: "What each model costs per turn",
  full: "The whole settings screen at once",
} as const;

const FIGURE_LABEL = "Cost grows with the turn";
const row = (cells: string[], tag: "th" | "td") =>
  `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
/** A five-column table, wide by the body's own facts. */
const TABLE =
  "<table>" +
  row(["Model", "Input", "Cached", "Output", "Per turn"], "th") +
  row(["Small", "0.10", "0.01", "0.40", "0.02"], "td") +
  row(["Large", "3.00", "0.30", "15.00", "0.61"], "td") +
  "</table>";
/** A drawing 750 units across, at width="100%". */
const FIGURE =
  `<figure aria-label="${FIGURE_LABEL}"><svg viewBox="0 0 750 60" width="100%" role="img" aria-label="${FIGURE_LABEL}">` +
  '<rect x="1" y="10" width="748" height="40" rx="6" style="fill:var(--accent-dim);stroke:var(--accent)"/>' +
  '<text x="12" y="35">Small: 0.02 per turn</text><text x="610" y="35">Large: 0.61</text></svg></figure>';

/** The crewmate's four notes, in the order it showed them. */
const NOTES = [
  {
    title: TITLES.defaultWide,
    body: `<p>The drawing fills the wide card while prose keeps its line.</p>${FIGURE}`,
  },
  {
    title: TITLES.regular,
    body: "<p>The meter row now reads on the first paint, all five meters in one line.</p>",
  },
  {
    title: TITLES.wide,
    body: `<p>The large model costs thirty times the small one per turn.</p><p>Each row is one model family, measured over the same forty recorded turns, and the columns read left to right from the cheapest input to the costliest output, so the row that matters most is the one whose last two columns grow fastest as the turn grows longer.</p>${TABLE}${FIGURE}`,
  },
  {
    title: TITLES.full,
    body: "<p>The settings screen shows every section without scrolling.</p>",
    width: "full" as const,
  },
];

const box = (element: Element): Rect => element.getBoundingClientRect();
const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** `read` once two reads a painted frame apart agree. */
async function settled<T>(read: () => T | Promise<T>): Promise<T> {
  let last: string | undefined;
  let value: T | undefined;
  await expect
    .poll(async () => {
      if (last !== undefined) await nextFrame();
      value = await read();
      const json = JSON.stringify(value);
      const same = json === last;
      last = json;
      return same;
    })
    .toBe(true);
  return value as T;
}

/** The stage's card layer, whose box is the shown card. */
const layer = () => one<HTMLElement>("[data-card-layer]") as HTMLElement;

/** The shown card's width once its move has settled. */
const cardWidth = () => settled(() => box(layer()).width);

/** Polls the shown card's width until it is `width`, to the pixel. */
async function expectCardWidth(width: number): Promise<void> {
  await expect.poll(() => box(layer()).width).toBeCloseTo(width, 0);
}

/** Opens a collapsed built-in dock, as the captain's click on its header does. */
async function expandDock(dock: string, title: string): Promise<void> {
  const panel = () => one(`[data-side-panel="${dock}"]`);
  await expect.poll(panel).not.toBeNull();
  if (!panel()?.hasAttribute("data-side-panel-collapsed")) return;
  await userEvent.click(page.getByRole("button", { name: `Expand ${title}`, exact: true }));
  await expect.poll(() => panel()?.hasAttribute("data-side-panel-collapsed")).toBe(false);
}

/**
 * Pages to the card titled `title` from wherever the stack is: back to the
 * top, then forward until it shows, as the captain walks the pager.
 */
async function showCard(title: string): Promise<void> {
  const shown = () => page.getByRole("region", { name: title, exact: true }).query();
  const arrow = (name: string) =>
    page.getByRole("button", { name, exact: true }).query() as HTMLButtonElement | null;
  await expect.poll(() => one(SHOWN_ENTRY)).not.toBeNull();
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

test("the captain's drag resizes a card and holds while it is up", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ notes: NOTES })));
  bridge.answer("inf:cards:seen-update", { ok: true });
  // The core keeps the layout the window sends, here the dock the captain opens.
  bridge.answer("inf:settings:layout:set", (layout) => layout);
  // The activity dock's frame asks whether the main process runs; here it does.
  bridge.answer("inf:frames:alive", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => one('[data-card-pager][data-pager-count="4"]')).not.toBeNull();
  await expandDock("activity", "Activity");

  await showCard(TITLES.regular);
  const regular = await cardWidth();
  await showCard(TITLES.wide);
  const decided = await cardWidth();
  const edge = () => one<HTMLElement>('[data-card-edge="right"]') as HTMLElement;
  expect(edge().getAttribute("aria-valuenow")).toBe(String(Math.round(decided)));
  // Far enough inward on one edge to take the card under regular, so the
  // docks the wide card folded come back.
  const inward = Math.ceil((decided - regular) / 2) + 20;
  const from = box(edge());
  const to = box(layer());
  await userEvent.dragAndDrop(edge(), layer(), {
    sourcePosition: { x: from.width / 2, y: from.height / 2 },
    targetPosition: {
      x: from.x + from.width / 2 - inward - to.x,
      y: from.y + from.height / 2 - to.y,
    },
    steps: 8,
  });
  await expect.poll(() => box(layer()).width).toBeLessThan(decided);
  const dragged = await cardWidth();

  // Paged away and back, the drag holds.
  await showCard(TITLES.regular);
  await expectCardWidth(regular);
  await showCard(TITLES.wide);
  await expectCardWidth(dragged);

  // The keyboard also widens the card.
  edge().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => box(layer()).width).toBeGreaterThan(dragged);

  // A double click gives the card back the width the host decided.
  await userEvent.dblClick(one('[data-card-edge="left"]') as HTMLElement);
  await expectCardWidth(decided);
  await expect.poll(() => one('[data-rail-tab="left"]')?.checkVisibility()).toBe(true);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
