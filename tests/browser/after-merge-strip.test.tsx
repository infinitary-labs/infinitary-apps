import { AFTER_MERGE_DOER_WORDS, AFTER_MERGE_LEAD } from "@shared/afterMerge";
import type { RiskAssessment } from "@shared/risk";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { REQUIRED_ACTIONS_LEAD } from "../../src/renderer/src/cards/requiredActionsWords";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { intersects } from "./layout";
import { bodyDrawn, inCardBody, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * INF-3149, the captain's direction C on a merge card's after-merge steps:
 * "the box takes too much prime real state space ... it blocks the main card
 * body". The steps move into the top of the body, where they scroll away as
 * the captain reads on, as one strip: the captain's own steps first under a
 * label in the warning color, then the crew's. Nothing sits pinned between
 * the body and the field, and Merge stays in view.
 */

const TITLE = "The alert triage skill is ready to merge";
const PARAGRAPH = "The skill reads the alert, finds the failing model and names who owns it.";
const RISK: RiskAssessment = {
  declared: {
    blast: { level: "low", why: "One new skill file" },
    behavior: { level: "medium", why: "Adds a skill you opt into" },
    undo: { level: "low", why: "Revert and done" },
    evidence: { level: "medium", why: "Read through; not run on a live alert" },
    sensitivity: { level: "low", why: "None" },
    novelty: { level: "medium", why: "A new skill beside the others" },
    deps: { level: "low", why: "Nothing added" },
  },
};

test("a merge card's after-merge steps lead its body and scroll away with it, the captain's first", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, risk: RISK, paragraph: PARAGRAPH }));
  bridge.answer("inf:cards:seen-update", { ok: true });
  // The app's usual window, where the captain's photo showed the body squeezed.
  await page.viewport(1200, 800);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  const frame = await bodyDrawn(TITLE);
  await stageAtRest();
  expect(document.querySelector(`${SHOWN_ENTRY} [data-card-attachment-row]`)).toBeNull();

  // One strip leads the body: the captain's steps under a lead in the
  // warning color, then the crew's under an untinted lead, every word shown.
  const strip = await inCardBody(TITLE, () => {
    const panel = document.querySelector("[data-inf-after-merge]");
    if (!panel) return null;
    const probe = document.createElement("span");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    const lead = (who: string) =>
      getComputedStyle(panel.querySelector(`[data-inf-after-merge-lead="${who}"]`) as Element)
        .color;
    const { x, y, width, height } = panel.getBoundingClientRect();
    return {
      first: document.body.querySelector(":scope > :not([data-inf-inset])") === panel,
      sections: [...panel.querySelectorAll("section")].map((section) => ({
        label: section.getAttribute("aria-label"),
        words: section.textContent,
      })),
      captainWarn: lead("captain") === warn,
      crewWarn: lead("crew") === warn,
      box: { x, y, width, height },
    };
  });
  if (!strip) throw new Error("The body drew no after-merge strip");
  expect(strip.first, "the strip is the body's first part").toBe(true);
  expect(strip.sections.map((section) => section.label)).toEqual([
    REQUIRED_ACTIONS_LEAD,
    AFTER_MERGE_LEAD,
  ]);
  expect(strip.sections[0]?.words).toContain("Link the skill after merge · your dotfiles");
  expect(strip.sections[0]?.words).toContain("The skill is not available until it is linked.");
  expect(strip.sections[1]?.words).toContain("DOT-41 Add the skill to the team's index");
  expect(strip.sections[1]?.words).toContain(AFTER_MERGE_DOER_WORDS.firstmate);
  expect(strip.captainWarn).toBe(true);
  expect(strip.crewWarn).toBe(false);

  // The strip keeps clear of the risk chart beside it.
  const at = frame.getBoundingClientRect();
  const chart = document.querySelector(`${SHOWN_ENTRY} [data-risk-chart]`)?.getBoundingClientRect();
  if (!chart) throw new Error("The card drew no risk chart");
  const onScreen = { ...strip.box, x: strip.box.x + at.x, y: strip.box.y + at.y };
  expect(intersects(onScreen, chart)).toBe(false);

  // Merge is in view, and reading on scrolls the strip out of the body's view.
  const merge = page.getByRole("button", { name: "Merge" });
  await expect.element(merge).toBeInViewport();
  const scroller = document.querySelector<HTMLElement>(`${SHOWN_ENTRY} [data-card-body]`);
  if (!scroller) throw new Error("The card drew no body scroller");
  scroller.scrollTop = scroller.scrollHeight;
  await stageAtRest();
  const scrolled = frame.getBoundingClientRect().y + strip.box.y + strip.box.height;
  expect(scrolled).toBeLessThanOrEqual(scroller.getBoundingClientRect().top);
  await expect.element(merge).toBeInViewport();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
