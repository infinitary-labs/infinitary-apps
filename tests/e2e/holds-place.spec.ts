import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { emitContinuityCard } from "./holdsPlace";
import { launchApp } from "./launch";
import {
  FM_THREAD_CARD_TITLE,
  FM_THREAD_PROMPT_MARKER,
  FM_THREAD_PROSE_ANSWER,
  THREAD_PROSE_REPLY,
} from "./mockProvider";
import { cardReply, expectNoCard, showCard, shownCard, shownEntry } from "./stack";
import { pressKey } from "./windowKeys";

const OTHER = "Another question";
const request = `${FM_THREAD_PROMPT_MARKER} holds-place-example`;

test("a declared continuity card keeps replies, closes choices, returns forward and survives restart", async () => {
  const userDataDir = scratchDir("infinitary-continuity-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "another-card",
    author: "firstmate",
    priority: 25,
    title: OTHER,
    meta: "firstmate",
    body: "<p>Another question can wait here.</p>",
    actions: [],
    status: "ready",
    createdAt: 1000,
  });
  db.close();
  let app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expect(shownCard(page, OTHER)).toBeVisible();
    await emitContinuityCard(app, request);
    // The author declared continuity: this arrival takes the stage without paging.
    await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
    const marked = await page.evaluate(async () =>
      (await window.infinitary.cards.list()).find((card) => card.holdsPlace),
    );
    expect(marked).toBeDefined();
    const id = marked?.id as string;
    const reply = cardReply(page).field;
    await reply.fill(THREAD_PROSE_REPLY);
    await pressKey(reply, "Enter");
    await expect(shownEntry(page).getByText(FM_THREAD_PROSE_ANSWER)).toBeVisible();
    await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
    await pressKey(
      page.getByRole("button", { name: "Lead with the caption", exact: true }),
      "Enter",
    );
    await expectNoCard(page, FM_THREAD_CARD_TITLE);
    await expect(shownCard(page, OTHER)).toBeVisible();
    await emitContinuityCard(app, `${request} again`);
    await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
    expect(
      await page.evaluate(
        async (wanted) =>
          (await window.infinitary.cards.list()).some(
            (card) => card.id === wanted && card.holdsPlace,
          ),
        id,
      ),
    ).toBe(true);
    await app.close();
    app = await launchApp({ userDataDir, withMockProvider: true });
    const restored = await app.page.evaluate(
      async (wanted) => (await window.infinitary.cards.list()).find((card) => card.id === wanted),
      id,
    );
    expect(restored?.holdsPlace).toBe(true);
    // No input into the main prompt is needed after restart: the same card accepts a question.
    // Boot preserves ordinary stack order, so reach it with the existing pager.
    await showCard(app.page, FM_THREAD_CARD_TITLE);
    await cardReply(app.page).field.fill(THREAD_PROSE_REPLY);
    await pressKey(cardReply(app.page).field, "Enter");
    await expect(shownEntry(app.page).getByText(FM_THREAD_PROSE_ANSWER)).toBeVisible();
    await expect(shownCard(app.page, FM_THREAD_CARD_TITLE)).toBeVisible();
  } finally {
    await app.close();
  }
});
