import { expect, test } from "@playwright/test";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  SIGN_OFF_CAPTAIN_LINE,
  SIGN_OFF_CARD_TITLE,
  SIGN_OFF_CREWMATE_LINE,
  SIGN_OFF_PROMPT_MARKER,
  threadSignOff,
} from "./scenarios/threadSignOff";
import { cardReply, closeEndedCard, expectEndedCard, shownCard } from "./stack";

/**
 * Saying you are done under an answer closes it (INF-2845, the captain's
 * direction A: "the crewmate marks a reply that says you are done, in any
 * words, as closing"), and the card stays in front of the captain, ended,
 * until they close it (INF-5561: "even if it's considered a sign-off, the
 * card should not just disappear in front of me. it should show me the close
 * card button"). The test launches its own app, so it owns every
 * prerequisite. The real first mate turn, crewmate session, card thread and
 * window run; the mock provider supplies only the two models' words.
 */

async function askAndShow(launched: LaunchedApp, title: string) {
  const { page } = launched;
  await promptInput(page).fill(`${SIGN_OFF_PROMPT_MARKER} ${title}`);
  await promptInput(page).press("Enter");
  await expect(shownCard(page, SIGN_OFF_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (entry) => entry.title === SIGN_OFF_CARD_TITLE,
  );
  if (!card?.taskId) throw new Error("the answering card never reached the stack");
  const taskId = card.taskId;
  const detail = (): Promise<TaskDetail> =>
    page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
  return { card, taskId, detail };
}

test("a crewmate's signed-off line under its answer ends the card in front of the captain and closes the task as answered", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [threadSignOff],
    userDataDir: scratchDir("infinitary-thread-sign-off-"),
  });
  const { page } = launched;
  try {
    const { card, detail } = await askAndShow(launched, "which plans stay clear");
    await page.screenshot({ path: test.info().outputPath("sign-off-before.png") });

    const box = cardReply(page).field;
    await box.click();
    await box.fill(SIGN_OFF_CAPTAIN_LINE);
    await cardReply(page).send.click();

    // The crewmate's mark ends the answer: the task closes answered, and the
    // card the captain was reading stays, ended, with one Close.
    await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    await expectEndedCard(page, SIGN_OFF_CARD_TITLE);
    await page.screenshot({ path: test.info().outputPath("sign-off-after.png") });

    // The mark on the crewmate's interim line first was refused and wrote
    // nothing; only its signed-off line stands under the captain's.
    const thread = await page.evaluate((id) => window.infinitary.cards.thread(id), card.id);
    expect(thread.messages.map((line) => [line.who, line.text])).toEqual([
      ["captain", SIGN_OFF_CAPTAIN_LINE],
      ["crewmate", SIGN_OFF_CREWMATE_LINE],
    ]);
    await test.info().attach("signed-off-task", {
      body: JSON.stringify({ task: await detail(), thread: thread.messages }, null, 2),
      contentType: "application/json",
    });

    // Its Close takes it off the stack.
    await closeEndedCard(page, SIGN_OFF_CARD_TITLE);
  } finally {
    await launched.close();
  }
});
