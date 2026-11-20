import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { FM_THREAD_CARD_TITLE, FM_THREAD_DEFAULT_LABEL } from "./crewCards";
import { THREAD_PROSE_REPLY } from "./crewScripts";
import { cardBody } from "./frames";
import { emitContinuityCard } from "./holdsPlace";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  CONTINUITY_HELD_ASK,
  CONTINUITY_HELD_TITLE,
  continuityHeld,
} from "./scenarios/continuityHeld";
import {
  FM_THREAD_PROMPT_MARKER,
  FM_THREAD_PROSE_ANSWER,
  firstmateThread,
} from "./scenarios/firstmateThread";
import { cardReply, expectNoCard, pager, showCard, shownCard, shownEntry } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

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
  let app = await launchApp({ scenarios: [firstmateThread], userDataDir, withMockProvider: true });
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
      page.getByRole("button", { name: FM_THREAD_DEFAULT_LABEL, exact: true }),
      "Enter",
    );
    await expectNoCard(page, FM_THREAD_CARD_TITLE);
    await expect(shownCard(page, OTHER)).toBeVisible();
    // Its id comes back after the choice only as a note, which still comes forward.
    await emitContinuityCard(app, `${request} again`, { asks: false });
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
    app = await launchApp({ scenarios: [firstmateThread], userDataDir, withMockProvider: true });
    const restored = await app.page.evaluate(
      async (wanted) => (await window.infinitary.cards.list()).find((card) => card.id === wanted),
      id,
    );
    expect(restored?.holdsPlace).toBe(true);
    // No input into the main prompt is needed after restart: the same card accepts a question.
    // Boot preserves ordinary stack order, so reach it with the existing pager.
    await showCard(app.page, FM_THREAD_CARD_TITLE);
    // The thread survives restart too: the first answer is back before the new question.
    const answers = shownEntry(app.page).getByText(FM_THREAD_PROSE_ANSWER);
    await expect(answers).toHaveCount(1);
    await cardReply(app.page).field.fill(THREAD_PROSE_REPLY);
    await pressKey(cardReply(app.page).field, "Enter");
    await expect(answers).toHaveCount(2);
    await expect(answers.last()).toBeVisible();
    await expect(shownCard(app.page, FM_THREAD_CARD_TITLE)).toBeVisible();
  } finally {
    await app.close();
  }
});

// The captain passed on a person's report: typing in a card's text field, a
// new card came in and took the stage and the keys. A marked card is the only
// arrival that takes the stage, so it waits as new while the captain types.
test("a declared continuity card waits as new while the captain types in the shown card", async () => {
  const typing = "Where should the crew meet";
  const userDataDir = scratchDir("infinitary-continuity-typing-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "typing-card",
    author: "firstmate",
    priority: 25,
    title: typing,
    meta: "firstmate",
    body: '<p>Tell the crew where to meet before the tide turns.</p><label for="meet">Meeting place</label><input id="meet" name="meet">',
    actions: [
      { id: "send", label: "Send it", default: true },
      { id: "later", label: "Not now" },
    ],
    status: "ready",
    createdAt: 1000,
  });
  db.close();
  const app = await launchApp({ scenarios: [continuityHeld], userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    const provider = app.mockProvider;
    if (!provider) throw new Error("Card continuity requires the mock provider");
    await expect(shownCard(page, typing)).toBeVisible();
    await waitForFirstmateIdle(page);
    // The captain asks the first mate for something; its marked card is held back.
    const input = promptInput(page);
    await focusOn(input);
    await input.fill(CONTINUITY_HELD_ASK);
    await pressKey(input, "Enter");
    await expect.poll(() => provider.heldThreadAnswers()).toBe(1);
    // Meanwhile the captain types in the shown card's own field.
    const field = cardBody(page, typing).locator("#meet");
    await focusOn(field);
    await typeInto(field, "North dock");
    // The marked card arrives while the field holds the caret: the stack counts it.
    provider.releaseThreadAnswer();
    await expect(pager(page, 2)).toBeVisible();
    await expect(shownCard(page, typing)).toBeVisible();
    // The captain types on without looking up, and the words land in the field.
    await typeInto(field, " by the crane");
    await expect(field).toHaveValue("North dock by the crane");
    // The marked card waits as new, one page away.
    await showCard(page, CONTINUITY_HELD_TITLE);
  } finally {
    await app.close();
  }
});
