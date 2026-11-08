import { expect, test } from "@playwright/test";
import { CARE_WORDS, DEFAULT_WORKSPACE_WORD, MERGE_WORDS } from "../../src/shared/vocabulary";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_MODEL_ID } from "./mockModels";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  ESCAPED_CARD_PROMPT_MARKER,
  escapedCard,
  MOCK_ESCAPED_CARD_ITEM,
  MOCK_ESCAPED_CARD_LEAD,
  MOCK_ESCAPED_CARD_TITLE,
} from "./scenarios/escapedCard";
import {
  EMIT_CARDS_PROMPT_MARKER,
  everyCardKind,
  MOCK_CHOICE_CARD_TITLE,
  MOCK_CHOICE_DEFAULT_LABEL,
  MOCK_PREVIEW_CARD_TITLE,
  MOCK_PREVIEW_HOLD_LABEL,
  MOCK_QUOTA_NOTE_TITLE,
} from "./scenarios/everyCardKind";
import { expectNoCard, factsStrip, pager, showCard, shownCard } from "./stack";

/**
 * Phase 4 acceptance (docs/architecture.md §17): a crewmate's cards wear
 * the chrome their shape derives (a card with actions is a decision, one
 * without a note); a card with a small interactive preview body renders
 * coherently in both themes, cannot reach network or the parent DOM, and
 * its action buttons round-trip to the orchestrator. The preview used to be
 * its own `live-prototype` kind and is now a decision whose body is
 * interactive, so two cards in this stack share the decision's priority.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [escapedCard, everyCardKind] });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${EMIT_CARDS_PROMPT_MARKER}`);
  await input.press("Enter");
  // The crewmate emits three cards through its tool and then reports. Two of
  // them are decisions, so the stack is three cards and which one tops it is
  // not something to assert on (see ./stack).
  await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("a click inside the preview rounds the declared action back, and resolving the decision keeps the choice", async () => {
  const { page } = launched;
  await test.step("a click inside the preview rounds the declared action back", async () => {
    await showCard(page, MOCK_PREVIEW_CARD_TITLE);
    const frame = cardBody(page, MOCK_PREVIEW_CARD_TITLE);
    // Wait until the frame is fully interactive (bridge installed) before the
    // click - a fresh srcdoc commit can otherwise swallow the first event.
    await expect
      .poll(() =>
        frame.locator("body").evaluate(() => typeof (window as { infAction?: unknown }).infAction),
      )
      .toBe("function");
    // The e2e window stays hidden (captain directive), and Chromium drops
    // native input routed into an out-of-process sandboxed frame when the
    // window has no compositor - so dispatch the click in-frame. Everything
    // from the bridge listener onward (postMessage, validation, orchestrator
    // round-trip) runs exactly as a real click would.
    await frame
      .getByRole("button", { name: MOCK_PREVIEW_HOLD_LABEL })
      .evaluate((el) => (el as HTMLButtonElement).click());
    // The orchestrator resolves the card: it leaves the stack (the pager
    // keeps its position, so only the count shrinks).
    await expectNoCard(page, MOCK_PREVIEW_CARD_TITLE, { timeout: 10_000 });
    await expect(pager(page, 2)).toBeVisible();
  });

  await test.step("resolving the decision keeps the choice and shrinks the stack", async () => {
    await showCard(page, MOCK_CHOICE_CARD_TITLE);
    await page.getByRole("button", { name: MOCK_CHOICE_DEFAULT_LABEL }).click();
    await expectNoCard(page, MOCK_CHOICE_CARD_TITLE, { timeout: 10_000 });
    await expect(shownCard(page, MOCK_QUOTA_NOTE_TITLE)).toBeVisible();
    await expect(pager(page, 2)).toHaveCount(0);
  });
});

test("an entity-escaped body is refused by name and the raw-tag retry renders as markup", async () => {
  // Contract v2.0: the Sep 15 Claude crewmates sent &lt;p&gt; bodies and
  // were told about sentence counts four times running. The mock crewmate
  // repeats the mistake and re-emits with raw tags only once the tool
  // result names the escaping, so the card on screen is the proof.
  const { page } = launched;
  const before = (await page.evaluate(() => window.infinitary.cards.list())).length;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${ESCAPED_CARD_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, before + 1)).toBeVisible({ timeout: 30_000 });
  await showCard(page, MOCK_ESCAPED_CARD_TITLE);
  const frame = cardBody(page, MOCK_ESCAPED_CARD_TITLE);
  await expect(frame.locator("p", { hasText: MOCK_ESCAPED_CARD_LEAD })).toHaveText(
    MOCK_ESCAPED_CARD_LEAD,
  );
  await expect(frame.locator("li")).toHaveText(MOCK_ESCAPED_CARD_ITEM);
  await expect(frame.locator("body")).not.toContainText("<p>");
  // A settle card ends with the host's own facts strip: the project and
  // the task's effective care are labeled cells, not a delivery posture.
  const facts = factsStrip(frame);
  await expect(facts.project).toHaveText(DEFAULT_WORKSPACE_WORD);
  await expect(facts.care).toHaveText(CARE_WORDS.quick);
  // The crewmate cell names the DISPATCHED model off the task record
  // (review F1) - the mock transport's model, by raw id since the mock
  // sits in no quota catalog.
  await expect(facts.crewmate).toHaveText(MOCK_MODEL_ID);
  // Even a value far wider than the card never widens the card body
  // (review F2).
  const overflow = await facts.strip.evaluate((strip) => {
    const doc = strip.ownerDocument;
    // A copy of the host's own project cell, its value made far too wide.
    const cell = strip.querySelector('[data-fact="project"]')?.cloneNode(true) as HTMLElement;
    const value = cell.lastElementChild as HTMLElement;
    value.textContent = `${"an-unreasonably-long-value-".repeat(12)}end`;
    strip.append(cell);
    const metrics = {
      bodyOverflows: doc.documentElement.scrollWidth > doc.documentElement.clientWidth,
    };
    cell.remove();
    return metrics;
  });
  expect(overflow.bodyOverflows).toBe(false);
  await expect(page.getByRole("button", { name: MERGE_WORDS.land })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("dark-settle-facts-card.png") });
});
