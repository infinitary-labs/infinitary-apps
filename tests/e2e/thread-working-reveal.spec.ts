import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { FM_THREAD_CARD_TITLE } from "./mockProvider";
import { FM_THREAD_PROMPT_MARKER, firstmateThread } from "./scenarios/firstmateThread";
import {
  THREAD_FILL_REPLY,
  THREAD_HOLD_REPLY,
  threadWorkingReveal,
} from "./scenarios/threadWorkingReveal";
import { cardReply, shownCard, shownEntry } from "./stack";

/**
 * The thread reveals its working row (INF-1231). The captain: "the
 * 'working' label in the chat panel doesn't show unless i scroll down...
 * it should auto scroll and reveal itself". On the first mate's own card
 * the captain's reply and the first mate's busy flag reach the thread in
 * separate renders, so a thread already past its height must scroll again
 * when `working` appears, not only when the reply does.
 */
test("a thread past its height scrolls to show working once the first mate takes a reply", async () => {
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [threadWorkingReveal, firstmateThread],
    userDataDir: scratchDir("infinitary-thread-working-"),
  });
  try {
    const { page, app } = launched;
    await resizeWindow(app, page, { width: 1280, height: 800 });
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.click();
    await prompt.fill(FM_THREAD_PROMPT_MARKER);
    await expect(prompt).toHaveValue(FM_THREAD_PROMPT_MARKER);
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await waitForFirstmateIdle(page);

    const reply = async (text: string) => {
      await cardReply(page).field.click();
      await cardReply(page).field.fill(text);
      await cardReply(page).send.click();
    };
    const list = shownEntry(page).locator("[data-card-thread] [data-thread-messages]");
    // A few answered replies push the thread past its height.
    for (let answered = 1; answered <= 4; answered++) {
      await reply(`${THREAD_FILL_REPLY} ${answered}`);
      await expect(list.locator('[data-thread-message="firstmate"]')).toHaveCount(answered, {
        timeout: 30_000,
      });
      await waitForFirstmateIdle(page);
    }
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(list.locator("[data-thread-working]")).toHaveCount(0);

    // The captain replies again and the first mate's turn stays open.
    await reply(THREAD_HOLD_REPLY);
    const working = list.locator("[data-thread-working]");
    await expect(working).toBeAttached({ timeout: 30_000 });
    // The thread scrolls on its own until the row's foot is inside its view.
    await expect
      .poll(
        () =>
          list.evaluate((el) => {
            const row = el.querySelector("[data-thread-working]");
            return (
              row !== null &&
              row.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom
            );
          }),
        { message: "the working row sits inside the thread's visible area" },
      )
      .toBe(true);
  } finally {
    await launched.close();
  }
});
