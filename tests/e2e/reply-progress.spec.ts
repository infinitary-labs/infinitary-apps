import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  REPLY_PROGRESS_ANSWER,
  REPLY_PROGRESS_CARD_TITLE,
  REPLY_PROGRESS_DOING,
  REPLY_PROGRESS_INTERIM,
  REPLY_PROGRESS_PROMPT_MARKER,
  REPLY_PROGRESS_REPLY,
  replyProgress,
} from "./scenarios/replyProgress";
import { cardReply, shownCard, shownEntry } from "./stack";

/**
 * A reply that asks for work shows that work (INF-990 friction 3, from the
 * nightly audit of the captain's sessions: replies asking INF-799's and
 * INF-887's crewmates for code changes went 41 and 26 minutes with no sign
 * of work). Through the real path - a crewmate session on the mock
 * provider, the real `reply` and command tools, the real card chrome -
 * the captain's reply under a crewmate's card gets, before its answer:
 *  1. the crewmate's one interim line in the thread, which leaves the
 *     reply waiting for the answer even though it names the captain's
 *     message (INF-2730);
 *  2. the thread's working row naming the command the crewmate runs.
 * Then the real answer lands and ends the wait.
 */
test("a reply that asks for work shows the crewmate's interim line and what it runs, before its answer", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [replyProgress],
    userDataDir: scratchDir("infinitary-reply-progress-"),
  });
  try {
    const { page } = launched;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${REPLY_PROGRESS_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(shownCard(page, REPLY_PROGRESS_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

    await cardReply(page).field.click();
    await cardReply(page).field.fill(REPLY_PROGRESS_REPLY);
    await cardReply(page).send.click();

    const thread = shownEntry(page).locator("[data-card-thread]");
    await expect(thread.getByText(REPLY_PROGRESS_REPLY)).toBeVisible({ timeout: 30_000 });
    await expect(
      thread.locator('[data-thread-message="crewmate"]').getByText(REPLY_PROGRESS_INTERIM),
    ).toBeVisible({ timeout: 30_000 });
    await expect(thread.locator("[data-thread-working] [data-thread-doing]")).toHaveText(
      REPLY_PROGRESS_DOING,
      { timeout: 30_000 },
    );
    await expect(thread.getByText(REPLY_PROGRESS_ANSWER)).toHaveCount(0);
    const awaiting = () =>
      page.evaluate(
        async (title) =>
          (await window.infinitary.cards.list()).find((card) => card.title === title)?.awaiting ??
          null,
        REPLY_PROGRESS_CARD_TITLE,
      );
    expect(await awaiting()).toBe("answer");

    await expect(
      thread.locator('[data-thread-message="crewmate"]').getByText(REPLY_PROGRESS_ANSWER),
    ).toBeVisible({ timeout: 60_000 });
    await expect.poll(awaiting, { timeout: 30_000 }).not.toBe("answer");
    await expect(thread.locator("[data-thread-working]")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await launched.close();
  }
});
