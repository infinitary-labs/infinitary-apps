import { RISK_DIMENSIONS, RISK_WORDS, type RiskAssessment, type RiskDimension } from "@shared/risk";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { intersects, type Rect } from "./layout";
import { bodyDrawn, cardLeave, inCardBody, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * A merge card shows its crewmate's risk as a radar at its top right
 * (FI3-1127's plan, built in FI3-1128; docs/card-authoring.md "The risk
 * chart"). The captain reads each dimension by resting on its dot, or by
 * reaching it with Tab, and lets the note go by leaving it or with Esc,
 * which closes nothing else. The chart never covers the headline, the
 * first lines or Before's picture.
 */

const TITLE = "Cards open wide by default and saved widths move over";
const BEFORE = "A card at 560 px";
const AFTER = "A card at 800 px";

const RISK: RiskAssessment = {
  declared: {
    blast: { level: "high", why: "The stage, the store and every test that reads widths" },
    behavior: { level: "high", why: "Every card opens wider than before" },
    undo: { level: "medium", why: "Saved widths are rewritten by a migration" },
    evidence: { level: "medium", why: "Tests pass; the narrow window was not photographed" },
    sensitivity: { level: "medium", why: "Rewrites saved card widths" },
    novelty: { level: "medium", why: "A new width rule beside the old" },
    deps: { level: "low", why: "Nothing added" },
  },
};

const CHART = `${SHOWN_ENTRY} [data-risk-chart]`;
const chart = () => document.querySelector<HTMLElement>(CHART);
const dot = (dimension: RiskDimension) =>
  page.elementLocator(
    document.querySelector(`${CHART} [data-risk-dot="${dimension}"]`) as HTMLElement,
  );
const note = (dimension: RiskDimension) =>
  document.querySelector<HTMLElement>(`${CHART} [data-risk-note="${dimension}"]`);
const notes = () => document.querySelectorAll(`${CHART} [data-risk-note]`).length;
const closeButton = () => cardLeave();

/**
 * The box of an element's own words, not of its block, which reaches under
 * a float beside it.
 */
function wordsBox(element: Element): Rect {
  const range = document.createRange();
  range.selectNodeContents(element.firstChild ?? element);
  const { x, y, width, height } = range.getBoundingClientRect();
  return { x, y, width, height };
}

async function tabFromClose(): Promise<void> {
  closeButton().focus();
  await userEvent.keyboard("{Tab}");
}

test("a merge card's risk chart sits at its top right, and each dot opens its own note by pointer and by keys", async () => {
  const bridge = fakeBridge(
    await seededHome({ title: TITLE, risk: RISK, before: BEFORE, after: AFTER }),
  );
  // The window marks a card seen once it shows; the core accepts it.
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(1280, 900);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  const frame = await bodyDrawn(TITLE);
  await stageAtRest();

  for (const dimension of RISK_DIMENSIONS)
    await expect
      .element(dot(dimension))
      .toHaveAttribute("data-risk-level", RISK.declared[dimension].level);
  expect(notes()).toBe(0);

  // Section: nothing the captain reads runs under the chart. The headline
  // and the first heading keep clear of it, and so does Before's picture,
  // compared once the body has drawn and the card holds still.
  const box = chart()?.getBoundingClientRect();
  const headline = document.querySelector(`${SHOWN_ENTRY} [data-card-title]`);
  if (!box || !headline) throw new Error("The card drew no risk chart or headline");
  const inBody = await inCardBody(
    TITLE,
    (alt) => {
      const why = [...document.querySelectorAll("h3")].find((h) => h.textContent === "Why");
      const picture = [...document.images].find((image) => image.alt === alt);
      if (!why?.firstChild || !picture)
        throw new Error("The body drew no Why or no Before picture");
      const range = document.createRange();
      range.selectNodeContents(why.firstChild);
      const words = range.getBoundingClientRect();
      const shown = picture.getBoundingClientRect();
      return {
        why: { x: words.x, y: words.y, width: words.width, height: words.height },
        before: { x: shown.x, y: shown.y, width: shown.width, height: shown.height },
      };
    },
    BEFORE,
  );
  const at = frame.getBoundingClientRect();
  const moved = (rect: Rect) => ({ ...rect, x: rect.x + at.x, y: rect.y + at.y });
  expect(intersects(wordsBox(headline), box), "the headline").toBe(false);
  expect(intersects(moved(inBody.why), box), "the first heading").toBe(false);
  expect(intersects(moved(inBody.before), box), "Before's picture").toBe(false);

  // Section: resting on a dot opens its note, with the crewmate's line;
  // leaving lets it go.
  await userEvent.hover(dot("blast"));
  await expect.poll(() => note("blast")?.textContent).toContain(RISK.declared.blast.why);
  await userEvent.hover(dot("deps"));
  await expect.poll(() => note("deps")?.textContent).toContain(RISK.declared.deps.why);
  expect(notes()).toBe(1);
  await userEvent.unhover(dot("deps"));
  await expect.poll(notes).toBe(0);

  // Section: the keys. Tab from the card's close reaches the dots in the
  // radar's order, each opening its note; Esc lets the note go and the card stays.
  await tabFromClose();
  await expect.element(dot("blast")).toHaveFocus();
  await expect.poll(() => note("blast") !== null).toBe(true);
  await userEvent.keyboard("{Tab}");
  await expect.element(dot("behavior")).toHaveFocus();
  await expect.poll(() => note("behavior")?.textContent).toContain(RISK.declared.behavior.why);
  await userEvent.keyboard("{Escape}");
  await expect.poll(notes).toBe(0);
  await expect.element(dot("behavior")).toHaveFocus();
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  for (const dimension of RISK_DIMENSIONS) {
    (dot(dimension).element() as HTMLElement).focus();
    const rating = RISK.declared[dimension];
    await expect
      .poll(() => note(dimension)?.textContent)
      .toBe(
        `${RISK_WORDS[dimension].label} · ${RISK_WORDS[dimension].levels[rating.level]}${rating.why}`,
      );
  }
  await userEvent.keyboard("{Escape}");

  // Section: reading down to After, the chart leaves with the top of the
  // body; a dot the keyboard reaches brings it back, its note open.
  const scroller = document.querySelector<HTMLElement>(`${SHOWN_ENTRY} [data-card-body]`);
  if (!scroller) throw new Error("The card drew no body scroller");
  scroller.scrollTop = scroller.scrollHeight;
  await stageAtRest();
  const afterTop = await inCardBody(
    TITLE,
    (alt) => [...document.images].find((image) => image.alt === alt)?.getBoundingClientRect().top,
    AFTER,
  );
  if (afterTop === undefined) throw new Error("The body drew no After picture");
  const view = scroller.getBoundingClientRect();
  const afterAt = afterTop + frame.getBoundingClientRect().y;
  expect(afterAt, "After's picture is in view").toBeLessThan(view.bottom);
  expect(afterAt + 1, "After's picture is in view").toBeGreaterThan(view.top);
  await expect.element(dot("blast")).not.toBeInViewport();
  await tabFromClose();
  await expect.element(dot("blast")).toHaveFocus();
  await expect.element(dot("blast")).toBeInViewport();
  await expect.poll(() => note("blast")?.textContent).toContain(RISK.declared.blast.why);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
