import { expect, type Locator, type Page, test } from "@playwright/test";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  EMIT_CARDS_PROMPT_MARKER,
  MOCK_ANSWER_TITLE,
  MOCK_REVISED_NOTE_TEXT,
  REVISE_NOTE_PROMPT_MARKER,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { pager, showCard, shownCard } from "./stack";

/**
 * WI-18 stack visibility: a new card is never gone unseen. With card A on
 * screen, a card B arriving leaves A shown, marks the pager with an unread
 * badge (and a dot on the arrow that leads to B), and the badge clears when
 * B is paged to. A seen note that collapsed out of the stack and is then
 * revised in place comes back the same way (fable review M1).
 */

const DECISION_TITLE = "Two ways to fix the flaky test";

let launched: LaunchedApp;

const badge = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ new$/ });
const dots = (page: Page) => page.locator("[data-unread-dot]");

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`commission a crewmate: ${EMIT_CARDS_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("a new card shows the unread badge and clears when paged to; a collapsed note revised in place returns unread", async () => {
  const { page } = launched;
  const previous = page.getByRole("button", { name: "Previous card" });
  const next = page.getByRole("button", { name: "Next card" });
  const input = promptInput(page);

  await test.step("a new card shows the unread badge, never steals the shown card, and clears when paged to", async () => {
    // See the whole stack once, then settle on card A - the decision, wherever
    // it sits among the two the crewmate emitted: nothing unread.
    while (await next.isEnabled()) await next.click();
    while (await previous.isEnabled()) await previous.click();
    await showCard(page, DECISION_TITLE);
    await expect(badge(page)).toHaveCount(0);
    await expect(dots(page)).toHaveCount(0);

    // Card B arrives while A is on screen.
    await input.click();
    await input.fill(ANSWER_PROMPT_MARKER);
    await input.press("Enter");
    await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
    await expect(badge(page)).toHaveText("1 new");
    await expect(dots(page)).toHaveCount(1);
    // A is still the shown card; B waits on the stack.
    await expect(shownCard(page, DECISION_TITLE)).toBeVisible();
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toHaveCount(0);

    // Page to B, following the dot: the badge clears once B is shown.
    const heading = shownCard(page, MOCK_ANSWER_TITLE);
    while (!(await heading.isVisible())) {
      const side = await dots(page).first().getAttribute("data-unread-dot");
      await (side === "before" ? previous : next).click();
    }
    await expect(heading).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    await expect(dots(page)).toHaveCount(0);
  });

  await test.step("a collapsed note revised in place returns to the stack unread", async () => {
    const followDots = async (heading: Locator) => {
      while (!(await heading.isVisible())) {
        const side = await dots(page).first().getAttribute("data-unread-dot");
        await (side === "before" ? previous : next).click();
      }
    };

    // Everything on the stack is seen (the step above paged it all). Let
    // the renderer's clock run past the collapse age; the next push then
    // collapses the seen "Quota note" into its task record.
    await expect(pager(page, 4)).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward("20:00");
    await input.click();
    await input.fill(ANSWER_PROMPT_MARKER);
    await input.press("Enter");
    // Five cards, one collapsed: the stack shows four, one of them new.
    await expect(badge(page)).toHaveText("1 new", { timeout: 30_000 });
    await expect(pager(page, 4)).toBeVisible();
    // Two answer cards share a title, so page by the dots until none is left.
    while ((await dots(page).count()) > 0) {
      const side = await dots(page).first().getAttribute("data-unread-dot");
      await (side === "before" ? previous : next).click();
    }
    await expect(badge(page)).toHaveCount(0);
    await expect(shownCard(page, "Quota note")).toHaveCount(0);

    // The crewmate revises the collapsed note under its own id.
    await input.click();
    await input.fill(`steer the task ${EMIT_CARDS_PROMPT_MARKER}: ${REVISE_NOTE_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(pager(page, 5)).toBeVisible({ timeout: 30_000 });
    await expect(badge(page)).toHaveText("1 new");
    await expect(dots(page)).toHaveCount(1);

    await followDots(shownCard(page, "Quota note"));
    await expect(cardBody(page, "Quota note").getByText(MOCK_REVISED_NOTE_TEXT)).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    await expect(dots(page)).toHaveCount(0);
  });
});
