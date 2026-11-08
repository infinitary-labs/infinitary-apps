import { expect, type Locator, type Page, test } from "@playwright/test";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  EMIT_CARDS_PROMPT_MARKER,
  everyCardKind,
  MOCK_CHOICE_CARD_TITLE,
  MOCK_QUOTA_NOTE_TITLE,
} from "./scenarios/everyCardKind";
import {
  MOCK_REVISED_NOTE_TEXT,
  REVISE_NOTE_PROMPT_MARKER,
  reviseNote,
} from "./scenarios/reviseNote";
import { pager, showCard, shownCard } from "./stack";

/**
 * WI-18 stack visibility: a new card is never gone unseen. With card A on
 * screen, a card B arriving leaves A shown, marks the pager with an unread
 * badge (and a dot on the arrow that leads to B), and the badge clears when
 * B is paged to. INF-2022 removes automatic hiding: seen notes remain available, and a released
 * revision becomes unread without moving the current selection.
 */

const DECISION_TITLE = MOCK_CHOICE_CARD_TITLE;

let launched: LaunchedApp;

const badge = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ new$/ });
const dots = (page: Page) => page.locator("[data-unread-dot]");

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [reviseNote, everyCardKind] });
  const { page } = launched;
  await askFirstmate(page, `${SPAWN_PROMPT_MARKER} ${EMIT_CARDS_PROMPT_MARKER}`);
  await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !launched) return;
  // INF-2022: a failed news assertion must retain the owner's actual update identities and readings.
  const cards = await launched.page.evaluate(() => window.infinitary.cards.list());
  await testInfo.attach("card-update-state", {
    body: JSON.stringify(cards, null, 2),
    contentType: "application/json",
  });
});

test("a new card clears when drawn; notes remain after elapsed time and revisions become unread", async () => {
  const { page } = launched;
  const previous = page.getByRole("button", { name: "Previous card" });
  const next = page.getByRole("button", { name: "Next card" });

  await test.step("a new card shows the unread badge, never steals the shown card, and clears when paged to", async () => {
    // INF-2022: paging past a card is not reading it. Let each initial card
    // draw and its owner acknowledge the sighting before navigating away.
    const initialCards = await page.evaluate(() => window.infinitary.cards.list());
    for (const card of initialCards) {
      await showCard(page, card.title);
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.infinitary.cards.list()).find((candidate) => candidate.id === id)
                ?.currentUpdateSeen,
            card.id,
          ),
        )
        .toBe(true);
    }
    await showCard(page, DECISION_TITLE);
    await expect(badge(page)).toHaveCount(0);
    await expect(dots(page)).toHaveCount(0);

    // Card B arrives while A is on screen.
    // The final author answer is a separate released update: wait for its real turn end.
    await askFirstmate(page, ANSWER_PROMPT_MARKER);
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

  await test.step("a retained note stays on the stack and its released revision becomes unread", async () => {
    const followDots = async (heading: Locator) => {
      while (!(await heading.isVisible())) {
        const side = await dots(page).first().getAttribute("data-unread-dot");
        await (side === "before" ? previous : next).click();
      }
    };

    // INF-2022: exceed the former hiding age after reading and paging away.
    await expect(pager(page, 4)).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward("20:00");
    await askFirstmate(page, ANSWER_PROMPT_MARKER);
    // All five cards remain; only the newly arrived answer is new.
    await expect(badge(page)).toHaveText("1 new", { timeout: 30_000 });
    await expect(pager(page, 5)).toBeVisible();
    // Two answer cards share a title, so page by the dots until none is left.
    while ((await dots(page).count()) > 0) {
      const side = await dots(page).first().getAttribute("data-unread-dot");
      await (side === "before" ? previous : next).click();
    }
    await expect(badge(page)).toHaveCount(0);
    await expect(shownCard(page, MOCK_QUOTA_NOTE_TITLE)).toHaveCount(0);

    await showCard(page, MOCK_QUOTA_NOTE_TITLE);
    await showCard(page, DECISION_TITLE);
    // INF-2022: ask this note's author through the real card owner, as another view can.
    // A composer turn also updates its first-mate answer cards: that is independent news,
    // not the retained note's revision. Keep this fixture on the one update it owns.
    await page.evaluate(
      async ({ title, text }) => {
        const card = (await window.infinitary.cards.list()).find((card) => card.title === title);
        if (!card) throw new Error(`The retained note is missing: ${title}`);
        await window.infinitary.cards.reply(card.id, text);
      },
      { title: MOCK_QUOTA_NOTE_TITLE, text: REVISE_NOTE_PROMPT_MARKER },
    );
    await expect(pager(page, 5)).toBeVisible({ timeout: 30_000 });
    await expect(badge(page)).toHaveText("1 new");
    await expect(dots(page)).toHaveCount(1);
    await expect(shownCard(page, DECISION_TITLE)).toBeVisible();

    await followDots(shownCard(page, MOCK_QUOTA_NOTE_TITLE));
    await expect(
      cardBody(page, MOCK_QUOTA_NOTE_TITLE).getByText(MOCK_REVISED_NOTE_TEXT),
    ).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    await expect(dots(page)).toHaveCount(0);
  });
});
