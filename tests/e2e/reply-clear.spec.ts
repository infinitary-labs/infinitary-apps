import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import {
  SPAWN_PROMPT_MARKER,
  THREAD_CARD_TITLE,
  THREAD_PROMPT_MARKER,
  THREAD_PROSE_ANSWER,
  THREAD_PROSE_REPLY,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { cardReply, SHOWN_ENTRY, shownCard, shownEntry } from "./stack";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    withMockProvider: true,
    userDataDir: scratchDir("infinitary-reply-clear-check-"),
  });
});

test.afterAll(async () => {
  await launched.close();
});

/**
 * Send `text` from the shown card's reply box by Enter and read the box at
 * the moment the reply first paints in the thread: a MutationObserver
 * callback runs in the same task as the commit that drew it, so the order
 * is exact - no clock.
 */
async function boxWhenReplyPaints(page: LaunchedApp["page"], text: string): Promise<string | null> {
  const box = cardReply(page).field;
  await box.click();
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await page.evaluate(
    ({ text, shown }) => {
      const w = window as unknown as { __boxAtPaint?: string | null; __obs?: MutationObserver };
      w.__boxAtPaint = undefined;
      w.__obs?.disconnect();
      const observer = new MutationObserver(() => {
        const painted = [...document.querySelectorAll('[data-thread-message="captain"]')].some(
          (el) => el.textContent?.includes(text),
        );
        if (!painted || w.__boxAtPaint !== undefined) return;
        w.__boxAtPaint =
          document.querySelector<HTMLTextAreaElement>(`${shown} [data-card-reply] textarea`)
            ?.value ?? null;
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      w.__obs = observer;
    },
    { text, shown: SHOWN_ENTRY },
  );
  if (process.env.FM_REPLY_EVIDENCE)
    await page.screenshot({
      path: `${process.env.FM_REPLY_EVIDENCE}/${text === THREAD_PROSE_REPLY ? "row" : "thread"}-draft.png`,
    });
  await box.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __boxAtPaint?: string | null }).__boxAtPaint),
    )
    .not.toBeUndefined();
  const seen = await page.evaluate(
    () => (window as unknown as { __boxAtPaint?: string | null }).__boxAtPaint ?? null,
  );
  await expect(box).toHaveValue("");
  if (process.env.FM_REPLY_EVIDENCE)
    await page.screenshot({
      path: `${process.env.FM_REPLY_EVIDENCE}/${text === THREAD_PROSE_REPLY ? "row" : "thread"}-sent.png`,
    });
  return seen;
}

test("the reply box is already empty when the sent reply paints in the thread", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const seen: (string | null)[] = [];
  seen.push(await boxWhenReplyPaints(page, THREAD_PROSE_REPLY));
  await expect(shownEntry(page).getByText(THREAD_PROSE_ANSWER)).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 4; i++) {
    seen.push(await boxWhenReplyPaints(page, `thread panel reply ${i + 1}`));
  }
  console.log(`box value when each reply painted in the thread: ${JSON.stringify(seen)}`);
  expect(seen).toEqual(["", "", "", "", ""]);
});

test("the main message box clears in the first send render", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.fill("main composer immediate clear");
  if (process.env.FM_REPLY_EVIDENCE)
    await page.screenshot({ path: `${process.env.FM_REPLY_EVIDENCE}/main-draft.png` });
  const value = await input.evaluate(async (field) => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // React batches the event: read its first commit, not inside keydown.
    await Promise.resolve();
    return (field as HTMLTextAreaElement).value;
  });
  expect(value).toBe("");
  if (process.env.FM_REPLY_EVIDENCE)
    await page.screenshot({ path: `${process.env.FM_REPLY_EVIDENCE}/main-sent.png` });
});
