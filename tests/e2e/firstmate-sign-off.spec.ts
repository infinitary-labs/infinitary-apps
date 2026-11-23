import { expect, test } from "@playwright/test";
import { ANSWER_MISSING_OPENING } from "../../src/core/orchestrator/captainWakes";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { REACT_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { latestServedTurn } from "./providerRequest";
import {
  FM_SIGN_OFF_ANSWER,
  FM_SIGN_OFF_CAPTAIN_LINE,
  FM_SIGN_OFF_CARD_TITLE,
  FM_SIGN_OFF_PROMPT_MARKER,
  firstmateSignOff,
} from "./scenarios/firstmateSignOff";
import { cardReply, closeEndedCard, expectEndedCard, shownCard } from "./stack";

/**
 * Saying you are done under the first mate's own card answers the message it
 * was shown for (INF-6317 part 1, the captain's "figure out why it didn't
 * count the earlier card interactions as answer to my message"). Before, the
 * first mate could only withdraw its card, and the app then told the captain
 * it had not answered that message. The test launches its own app, so it
 * owns every prerequisite. The real first mate turn, card thread, answer
 * delivery and window run; the mock provider supplies only the model's words.
 */
test("the first mate's signed-off line under its own card ends it and answers the message it was shown for", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [firstmateSignOff],
    userDataDir: scratchDir("infinitary-firstmate-sign-off-"),
  });
  const { page } = launched;
  const say = async (text: string) => {
    await promptInput(page).fill(text);
    await promptInput(page).press("Enter");
  };
  try {
    await say(`${FM_SIGN_OFF_PROMPT_MARKER}?`);
    await expect(shownCard(page, FM_SIGN_OFF_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (entry) => entry.title === FM_SIGN_OFF_CARD_TITLE,
    );
    if (!card) throw new Error("the answering card never reached the stack");
    await waitForFirstmateIdle(page);
    await page.screenshot({ path: test.info().outputPath("fm-sign-off-before.png") });

    const box = cardReply(page).field;
    await box.click();
    await box.fill(FM_SIGN_OFF_CAPTAIN_LINE);
    await cardReply(page).send.click();

    // The first mate's mark ends the card the captain was reading: it stays,
    // ended, with one Close, as a crewmate's signed-off answer does.
    await expectEndedCard(page, FM_SIGN_OFF_CARD_TITLE);
    await page.screenshot({ path: test.info().outputPath("fm-sign-off-after.png") });

    // The mark on a line naming another message was refused and wrote
    // nothing; only the signed-off answer stands under the captain's line.
    const thread = await page.evaluate((id) => window.infinitary.cards.thread(id), card.id);
    expect(thread.messages.map((line) => [line.who, line.text])).toEqual([
      ["captain", FM_SIGN_OFF_CAPTAIN_LINE],
      ["firstmate", FM_SIGN_OFF_ANSWER],
    ]);

    // A message the mock answers with a reaction: every earlier turn, and
    // any retry or notice their endings raise, has finished first.
    await say(`${REACT_PROMPT_MARKER}: thanks`);
    await waitForFirstmateIdle(page);
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(cards.filter((entry) => entry.id.startsWith("card-ask-"))).toEqual([]);
    const retries = (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
      latestServedTurn(body)?.segments.some((segment) =>
        segment.body.includes(ANSWER_MISSING_OPENING),
      ),
    );
    expect(retries).toEqual([]);
    await test.info().attach("signed-off-thread", {
      body: JSON.stringify({ card, thread: thread.messages, cards }, null, 2),
      contentType: "application/json",
    });

    await closeEndedCard(page, FM_SIGN_OFF_CARD_TITLE);
  } finally {
    await launched.close();
  }
});
