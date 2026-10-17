import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { askedUnderCardLine } from "../../src/core/orchestrator/threadWords";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  CARD_REPLY_MAX_CHARS,
  type Card,
  TURN_IMAGE_MAX_BYTES,
  TURN_IMAGES_MAX,
} from "../../src/shared/cards";
import { COMPOSER_NOTICE_WORDS } from "../../src/shared/composer";
import { reportSummary } from "../../src/shared/feed";
import { applyTaskBoardDelta, type TaskBoard, type TaskBoardDelta } from "../../src/shared/tasks";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { hintOf } from "./desktop";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import {
  FM_THREAD_CARD_REVISED_TITLE,
  FM_THREAD_CARD_TITLE,
  FM_THREAD_PROMPT_MARKER,
  FM_THREAD_PROSE_ANSWER,
  FM_THREAD_REVISE_ANSWER,
  MOCK_THREAD_HANDOFF_REPORT,
  SPAWN_PROMPT_MARKER,
  THREAD_ACK_REPLY,
  THREAD_ACK_REVISED_TITLE,
  THREAD_ACK_TEXT,
  THREAD_CARD_REVISED_TITLE,
  THREAD_CARD_TITLE,
  THREAD_IMAGE_PNG,
  THREAD_PROMPT_MARKER,
  THREAD_PROSE_ANSWER,
  THREAD_PROSE_REPLY,
  THREAD_REVISE_ANSWER,
  THREAD_REVISE_REPLY,
  THREAD_SETTLE_CARD_TITLE,
  THREAD_SETTLE_PROMPT_MARKER,
  THREAD_SETTLE_REPLY,
  THREAD_TREE_PARENT_KEY,
  THREAD_TREE_PROMPT_MARKER,
  THREAD_WORKING_SIBLING_MARKER,
} from "./mockProvider";
import { pastePictures, promptInput } from "./prompt";
import {
  expandDock,
  expectRecordBody,
  feedLine,
  nowRowGroup,
  pressRow,
  putInLine,
  recordBar,
  recordBarButton,
  recordCard,
  reportLine,
  taskKey,
} from "./rails";
import {
  cardReply,
  closeOpenCards,
  closeQuestion,
  expectNoCard,
  pager,
  pagerAt,
  SHOWN_ENTRY,
  showCard,
  shownCard,
  shownEntry,
} from "./stack";
import { focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * Cards as threads (captain-approved 2026-09-20; the design is R4 of
 * `fm3000-card-close-decision-model-s1`). Binding evidence through the real
 * path: a real Firstmate turn, a real crewmate session on the mock
 * provider, the real `reply` tool and the real card chrome.
 *
 * Phase 1:
 *  1. A captain reply that changes what the card should say revises it IN
 *     PLACE - same id, new head - and the thread says so in one host line.
 *  2. A reply that changes nothing on the card is answered in the thread.
 *     Either way the reply hands the turn to the author: the card leaves
 *     the stage while the captain waits and returns with the answer.
 *  3. A settle-shaped reply under a completion card is not the crewmate's
 *     to run: it closes its card and reports the captain's words verbatim,
 *     which wakes the Firstmate by the whose-turn rule and lands as the
 *     settle. Nothing in the host reads those words.
 *
 * Phase 2:
 *  4. A captain reply on the Firstmate's own card is a captain turn: the
 *     card revises in place, or the answer lands as prose in the thread.
 *  5. An image rides a thread reply on a transport that supports it.
 *
 * The card return rule (the captain's "ship it" of 2026-09-27):
 *  6. The card comes back at its author's close-out, never on its first
 *     write: an acknowledgement in the thread leaves it off the stage, a
 *     reload of the window keeps it off (the hide lives in the core), and
 *     the report after the real answer brings it back, answered.
 *
 * Collapsing a thread (FI3-1130):
 *  7. The thread folds back into its card and opens again from its own
 *     collapse, the latest line at the card's foot, ⌘\ and command search;
 *     the author's next line, or the captain's own reply, opens it again.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    withMockProvider: true,
    userDataDir: scratchDir("infinitary-card-threads-"),
  });
});

test.afterAll(async () => {
  await launched.close();
});

/** The second line of a reply typed over two. */
const MULTILINE_REPLY_TAIL = "only if it passes on the second try";

/**
 * The feed's note for a reply under the card titled `title`, whichever
 * crewmate it went to: the note's own words around the crewmate's handle.
 */
function askedUnder(title: string): RegExp {
  const hole = "\u0000";
  const [before = "", after = ""] = askedUnderCardLine(hole, title).split(hole);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${literal(before)}.+${literal(after)}`);
}

/** The captain's own input under the shown card. */
const replyBox = (page: LaunchedApp["page"]) => cardReply(page).field;

async function sendReply(page: LaunchedApp["page"], text: string): Promise<void> {
  const box = replyBox(page);
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Send reply" }).click();
}

/**
 * Watch the stage for the shown card leaving it. A lone card stays when the
 * captain replies under it, and a poll could miss a brief leave - so the
 * watch records the moment the card layer leaves the DOM, and the returned
 * reader says whether it did since the watch began.
 */
async function watchCardLeaves(page: LaunchedApp["page"]): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const w = window as unknown as { __cardLeft?: boolean; __cardWatch?: MutationObserver };
    w.__cardWatch?.disconnect();
    w.__cardLeft = false;
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-card-layer]")) w.__cardLeft = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__cardWatch = observer;
  });
  return () =>
    page.evaluate(() => Boolean((window as unknown as { __cardLeft?: boolean }).__cardLeft));
}

/** The main prompt: wait for React to hold the value, then the send control. */
async function sendPrompt(page: LaunchedApp["page"], text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Task prompt" });
  await input.click();
  await input.fill(text);
  await expect(input).toHaveValue(text);
  await page.getByRole("button", { name: "Submit" }).click();
}

/** Wait until the mock's request log stops growing so the next turn is a fresh prompt. */
async function waitForProviderQuiet(
  page: LaunchedApp["page"],
  mock: LaunchedApp["mockProvider"],
): Promise<void> {
  let last = mock?.requestBodies().length ?? 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = mock?.requestBodies().length ?? 0;
    if (next === last) return;
    last = next;
  }
}

test("a captain reply revises the card in place, or is answered in the thread", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await input.press("Enter");

  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

  await expect(replyBox(page)).toBeVisible();

  // Sending hands the turn to the author, but a lone card stays put: the
  // stage never loses it, and the thread opens beside it.
  await expandDock(page, "activity");
  await expandDock(page, "now");
  const cardLeft = await watchCardLeaves(page);
  await sendReply(page, THREAD_REVISE_REPLY);

  // The first sent message opens the thread beside the card.
  const thread = shownEntry(page).locator("[data-card-thread]");
  await expect(thread).toBeVisible({ timeout: 30_000 });
  expect(await cardLeft()).toBe(false);
  await expect(thread.getByText(THREAD_REVISE_REPLY)).toBeVisible();

  // The preferred answer: the head re-renders under the same id, and the
  // thread carries the host's one line saying it did. The card is revised,
  // not replaced - the stack never grew a second card.
  await expect(shownCard(page, THREAD_CARD_REVISED_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(shownCard(page, THREAD_CARD_TITLE)).toHaveCount(0);
  await expect(thread.getByText(`revised: ${THREAD_CARD_REVISED_TITLE}`)).toBeVisible();
  // The revision carries the author's short answer, after the revised line.
  await expect(thread.getByText(THREAD_REVISE_ANSWER)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Next card" })).toHaveCount(0);

  // A reply resolves nothing: the decision's buttons are still there.
  await expect(page.getByRole("button", { name: "Await the queue" })).toBeEnabled();

  // The edge tab remains a way back to the panels while the thread is open.
  const rail = page.locator('[data-rail="left"]');
  await expect(page.locator('[data-rail-tab="left"]')).toBeVisible();

  // One click brings the docks back, by closing the thread; the messages
  // stay on the record and the reply row returns to the foot of the card.
  await page.locator('[data-rail-tab="left"]').click();
  await expect(shownEntry(page).locator("[data-card-thread]")).toHaveCount(0);
  await expect(replyBox(page)).toBeVisible();

  // The same reply journey also works in a wider window.
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1728, 900);
  });

  // The second answer shape, on the same card: a reply that changes
  // nothing on it is answered in the thread itself. The card stays on the
  // stage, and the thread the edge tab closed re-opens with the answer -
  // nothing was lost with the column.
  const cardLeftAgain = await watchCardLeaves(page);
  await sendReply(page, THREAD_PROSE_REPLY);
  await expect(thread.getByText(THREAD_PROSE_ANSWER)).toBeVisible({ timeout: 30_000 });
  expect(await cardLeftAgain()).toBe(false);
  await expect(thread).toBeVisible();
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const pairBox = await shownEntry(page).locator("[data-card-pair]").boundingBox();
      return (pairBox?.x ?? 0) - ((railBox?.x ?? 0) + (railBox?.width ?? 0));
    })
    .toBeGreaterThanOrEqual(0);
  await expect(thread.getByText(THREAD_REVISE_REPLY)).toBeVisible();
  await expect(thread.getByText(THREAD_PROSE_REPLY)).toBeVisible();

  // The crewmate's own prose - the revision's answer and the real reply
  // tool's - rendered as messages, never as a second card.
  await expect(page.locator('[data-thread-message="crewmate"]')).toHaveCount(2);
  await expect(shownCard(page, THREAD_CARD_REVISED_TITLE)).toBeVisible();

  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1200, 800);
  });
});

test("the thread collapses into its card and opens again, by keys, its controls and a new line", async () => {
  const { app, page, mockProvider } = launched;
  await waitForFirstmateIdle(page);
  await closeOpenCards(page);
  await sendPrompt(page, `${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  // Both docks hold their width at the default 1200, so the open pair folds them.
  await expandDock(page, "activity");
  await expandDock(page, "now");
  const thread = shownEntry(page).locator("[data-card-thread]");
  const collapse = thread.getByRole("button", { name: "Collapse thread" });
  const cue = shownEntry(page).locator("[data-thread-cue]");
  const reply = replyBox(page);

  // The crewmate acknowledges and holds its answer, so nothing new lands
  // until this journey lets it.
  await sendReply(page, THREAD_ACK_REPLY);
  await expect(thread.getByText(THREAD_ACK_TEXT)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => mockProvider?.heldThreadAnswers() ?? 0, { timeout: 30_000 }).toBe(1);
  await expect(reply).toBeFocused();

  // ⌘\ folds the thread into the card: the docks come back, the reply row is
  // at the card's foot under the latest line, and the field keeps the focus.
  await pressWindowKey(app, "\\", ["meta"]);
  await expect(thread).toHaveCount(0);
  await expect(cue).toContainText(THREAD_ACK_TEXT);
  await expect(cue).toHaveAccessibleName(/^Show thread, /);
  await expect(reply).toBeFocused();
  await reply.fill("a draft that waits");

  // ⌘\ again puts it beside the card, with the draft where it was.
  await pressWindowKey(app, "\\", ["meta"]);
  await expect(thread.getByText(THREAD_ACK_TEXT)).toBeVisible();
  await expect(cue).toHaveCount(0);
  await expect(reply).toHaveValue("a draft that waits");
  await expect(reply).toBeFocused();

  // The head's own collapse, pressed with Enter, hands focus to the latest
  // line, and Enter there opens the thread with focus back on the collapse.
  // The pointer rests where no control is, so only the keyboard shows labels.
  await page.mouse.move(600, 20);
  await pressKey(collapse, "Enter");
  await expect(thread).toHaveCount(0);
  await expect(cue).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(thread).toBeVisible();
  await expect(collapse).toBeFocused();
  // Resting there, the collapse names its key; ⌘\ takes the label with it.
  const label = page.locator("[data-icon-label]").filter({ hasText: "Collapse thread" });
  await expect(label).toBeVisible();
  await expect(label).toContainText(hintOf("cards.thread"));
  await pressWindowKey(app, "\\", ["meta"]);
  await expect(thread).toHaveCount(0);
  await expect(cue).toBeFocused();
  await expect(label).toBeHidden();

  // Command search lists it and runs it the same way.
  await runFromSearch(app, page, "cards.thread");
  await expect(thread).toBeVisible();
  await expect(collapse).toBeFocused();
  await pressWindowKey(app, "\\", ["meta"]);
  await expect(thread).toHaveCount(0);
  await expect(cue).toBeFocused();

  // The author's next line opens the collapsed thread by itself.
  mockProvider?.releaseThreadAnswer();
  await expect(thread.getByText(`revised: ${THREAD_ACK_REVISED_TITLE}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(shownCard(page, THREAD_ACK_REVISED_TITLE)).toBeVisible();
  await waitForFirstmateIdle(page);

  // So does the captain's own reply, sent from the collapsed card.
  await pressWindowKey(app, "\\", ["meta"]);
  await expect(cue).toBeVisible();
  await expect(reply).toHaveValue("a draft that waits");
  await sendReply(page, THREAD_PROSE_REPLY);
  await expect(thread.getByText(THREAD_PROSE_REPLY)).toBeVisible({ timeout: 30_000 });
  await expect(cue).toHaveCount(0);
  await expect(thread.getByText(THREAD_PROSE_ANSWER)).toBeVisible({ timeout: 30_000 });
  await closeOpenCards(page);
});

test('"merge it" typed under a completion card closes it and lands as the Firstmate\'s settle', async () => {
  const { page } = launched;
  // Clear whatever the previous test left on the stage, so the completion
  // card is the one the reply row belongs to.
  const openClose = page.locator(`${SHOWN_ENTRY} button[aria-label="Close"]`).first();
  while (await openClose.isVisible()) {
    await openClose.click();
    await page.waitForTimeout(300);
  }

  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${THREAD_SETTLE_PROMPT_MARKER}`);
  await input.press("Enter");

  await expect(shownCard(page, THREAD_SETTLE_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  // The host attached the completion buttons from the posture (v3.6).
  await expect(page.getByRole("button", { name: MERGE_WORDS.land })).toBeVisible();

  await expandDock(page, "activity");
  await sendReply(page, THREAD_SETTLE_REPLY);

  // The crewmate closes its own card - the captain's × was never clicked -
  // and the Firstmate, woken by that report, runs the settle.
  await expect(shownCard(page, THREAD_SETTLE_CARD_TITLE)).toHaveCount(0, { timeout: 45_000 });
  // His words reached the Firstmate through the crewmate's report, and the
  // settle is the Firstmate's own - the same one he would have got by
  // typing "merge it" in the main input.
  await expect(
    reportLine(page, await taskKey(page, THREAD_SETTLE_PROMPT_MARKER)).filter({
      hasText: reportSummary(MOCK_THREAD_HANDOFF_REPORT),
    }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(putInLine(page, await taskKey(page, THREAD_SETTLE_PROMPT_MARKER))).toBeVisible({
    timeout: 45_000,
  });
});

test("a captain reply on a Firstmate card revises it or lands as prose in the thread", async () => {
  const { page } = launched;
  await closeOpenCards(page);
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);

  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const cardId = (await cardReply(page).row.getAttribute("data-card-reply")) ?? "";
  expect(cardId).toBeTruthy();

  // Past a reply's limit the row says so, and neither Enter nor the send
  // control sends: the draft stays and the thread is still empty.
  const box = replyBox(page);
  await box.fill("x".repeat(CARD_REPLY_MAX_CHARS + 1));
  const limit = page.locator("[data-card-reply-limit]");
  await expect(limit.locator('[data-composer-count="over"]')).toBeVisible();
  await expect(limit.getByText(COMPOSER_NOTICE_WORDS["too-long"])).toBeVisible();
  const sendControl = page.getByRole("button", { name: "Send reply" });
  await expect(sendControl).toHaveAttribute("aria-disabled", "true");
  await box.press("Enter");
  await sendControl.click({ force: true });
  await expect(box).toHaveValue("x".repeat(CARD_REPLY_MAX_CHARS + 1));
  expect(
    (await page.evaluate((id) => window.infinitary.cards.thread(id), cardId)).messages,
  ).toEqual([]);
  await box.fill("");
  await expect(limit).toHaveCount(0);

  await cardBody(page, FM_THREAD_CARD_TITLE).locator("#tone").fill("plain");
  const cardLeft = await watchCardLeaves(page);
  await sendReply(page, THREAD_REVISE_REPLY);

  const thread = shownEntry(page).locator("[data-card-thread]");
  await expect(thread).toBeVisible({ timeout: 30_000 });
  expect(await cardLeft()).toBe(false);
  await expect(thread.getByText(THREAD_REVISE_REPLY)).toBeVisible();
  await expect(shownCard(page, FM_THREAD_CARD_REVISED_TITLE)).toBeVisible({ timeout: 30_000 });
  // The revision swaps the body of a frame the thread's opening just
  // remounted; it still draws, at a real height.
  await expect(cardBodyElement(page, FM_THREAD_CARD_REVISED_TITLE)).toHaveAttribute(
    "data-frame-drawn",
    "",
  );
  await expect(thread.getByText(`revised: ${FM_THREAD_CARD_REVISED_TITLE}`)).toBeVisible();
  // The revision carries the Firstmate's short answer, after the revised line.
  await expect(thread.getByText(FM_THREAD_REVISE_ANSWER)).toBeVisible({ timeout: 30_000 });
  expect(
    (await page.evaluate((id) => window.infinitary.cards.thread(id), cardId)).messages
      .slice(0, 3)
      .map((message) => message.who),
  ).toEqual(["captain", "host", "firstmate"]);
  await expect(page.getByRole("button", { name: "Lead with the caption" })).toBeEnabled();

  // The Firstmate's prose answer lands in the thread this time.
  // The reply is typed as keystrokes over two lines: Shift+Enter adds the
  // line, Enter sends, and the thread keeps the line break.
  await cardBody(page, FM_THREAD_CARD_REVISED_TITLE).locator("#tone").fill("brief");
  const cardLeftAgain = await watchCardLeaves(page);
  const threadBox = cardReply(page).field;
  await threadBox.click();
  await threadBox.pressSequentially(THREAD_PROSE_REPLY);
  await threadBox.press("Shift+Enter");
  await threadBox.pressSequentially(MULTILINE_REPLY_TAIL);
  await expect(threadBox).toHaveValue(`${THREAD_PROSE_REPLY}\n${MULTILINE_REPLY_TAIL}`);
  await threadBox.press("Enter");
  await expect(thread.getByText(FM_THREAD_PROSE_ANSWER)).toBeVisible({ timeout: 30_000 });
  expect(await cardLeftAgain()).toBe(false);
  const sent = (await page.evaluate((id) => window.infinitary.cards.thread(id), cardId)).messages;
  // The thread keeps his words apart from the settings the card sent with
  // them (FI3-617), and the author still reads the two together.
  const captainMessages = sent.filter((message) => message.who === "captain");
  expect(captainMessages.map((message) => message.text)).toEqual([
    THREAD_REVISE_REPLY,
    `${THREAD_PROSE_REPLY}\n${MULTILINE_REPLY_TAIL}`,
  ]);
  expect(
    captainMessages.map(
      (message) => message.answers?.find((answer) => answer.name === "tone")?.values,
    ),
  ).toEqual([["plain"], ["brief"]]);
  expect(
    launched.mockProvider
      ?.requestBodies()
      .some((body) =>
        JSON.stringify(JSON.parse(body)).includes(JSON.stringify('tone: "brief"').slice(1, -1)),
      ),
  ).toBe(true);
  // Rendered with its lines: the message's own text breaks where it was typed.
  const multiLine = thread
    .locator('[data-thread-message="captain"]')
    .filter({ hasText: MULTILINE_REPLY_TAIL });
  expect(await multiLine.innerText()).toContain(`${THREAD_PROSE_REPLY}\n${MULTILINE_REPLY_TAIL}`);
  // The settings sit under his words, collapsed until he opens them.
  const settings = multiLine.locator("[data-thread-settings-toggle]");
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(multiLine.locator("[data-thread-settings]")).toHaveCount(0);
  await settings.click();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(multiLine.locator("[data-thread-settings]")).toContainText("brief");
  // The revised draft was sent with the latest reply, so closing loses no settings.
  await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(closeQuestion(page)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).some(
        (card) => card.id === cardId,
      ),
    )
    .toBe(false);
});

test("a card reply refuses pictures beyond the shared limit and shows the shared notice", async () => {
  const { page } = launched;
  await closeOpenCards(page);
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

  const reply = cardReply(page);
  await pastePictures(
    reply.field,
    Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => ({ name: `reply-${i}.png` })),
  );
  await expect(reply.pictures).toHaveCount(TURN_IMAGES_MAX);
  await expect(reply.notice("pictures-max")).toBeVisible();

  // The row remains capped when another picture is pasted later, too.
  await pastePictures(reply.field, [{ name: "extra.png" }]);
  await expect(reply.pictures).toHaveCount(TURN_IMAGES_MAX);

  // A picture past the shared size limit also refuses visibly in this field.
  await pastePictures(reply.field, [{ name: "oversized.png", bytes: TURN_IMAGE_MAX_BYTES + 1 }]);
  await expect(reply.pictures).toHaveCount(TURN_IMAGES_MAX);
  await expect(reply.notice("picture-too-big")).toBeVisible();
});

test("a card reply takes multiple lines without hiding their text", async () => {
  const { page } = launched;
  await closeOpenCards(page);
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  const reply = cardReply(page);
  await reply.field.click();
  await reply.field.pressSequentially("a");
  await reply.field.press("Shift+Enter");
  await reply.field.pressSequentially("b");
  await expect(reply.field).toHaveValue("a\nb");
  await expect
    .poll(() => reply.field.evaluate((field) => field.scrollHeight <= field.clientHeight))
    .toBe(true);
  await reply.field.fill("");
});

test("a card reply takes the shell keys and undoes typing by the run, but never brings back the main message", async () => {
  // Linux gives the shell keys no key (docs/composer.md, "Shell keys").
  test.skip(process.platform !== "darwin", "the shell keys' default keys are the Mac's");
  const { page } = launched;
  await closeOpenCards(page);
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });

  const reply = cardReply(page);
  await reply.field.click();
  // Recall is the main message's: Up and Ctrl+P in an empty reply stay empty.
  await reply.field.press("ArrowUp");
  await reply.field.press("Control+P");
  await expect(reply.field).toHaveValue("");
  await reply.field.pressSequentially("merge it now");
  // Cmd+Z takes back what was typed, not its last character, and
  // Cmd+Shift+Z puts it back.
  await reply.field.press("Meta+Z");
  await expect(reply.field).toHaveValue("");
  await reply.field.press("Meta+Shift+Z");
  await expect(reply.field).toHaveValue("merge it now");
  await reply.field.press("Control+W");
  await expect(reply.field).toHaveValue("merge it ");
  await reply.field.press("Control+U");
  await expect(reply.field).toHaveValue("");
  // The two removals joined in the order the words stood.
  await reply.field.press("Control+Y");
  await expect(reply.field).toHaveValue("merge it now");
  await reply.field.fill("");
});

test("an image rides a thread reply on a transport that supports it", async () => {
  const { page, mockProvider } = launched;
  await closeOpenCards(page);
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  await waitForProviderQuiet(page, mockProvider);

  const cardId = await cardReply(page).row.getAttribute("data-card-reply");
  expect(cardId).toBeTruthy();
  const before = mockProvider?.requestBodies().length ?? 0;
  await page.evaluate(
    async ({ id, png }) => {
      await window.infinitary.cards.reply(id, {
        text: "see this picture",
        images: [{ mimeType: "image/png", data: png }],
      });
    },
    { id: cardId as string, png: THREAD_IMAGE_PNG },
  );
  await expect(
    shownEntry(page).locator("[data-card-thread]").getByText("see this picture"),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      () => {
        const bodies = (mockProvider?.requestBodies() ?? []).slice(before).join("\n");
        return (
          bodies.includes(THREAD_IMAGE_PNG) ||
          bodies.includes('"type":"image"') ||
          bodies.includes("image_url") ||
          bodies.includes("image/png")
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
});

/**
 * The window has read everything the core pushed before this call: a read
 * over the same channel, answered after the pushes queued before it, then
 * two frames for React to paint what the store took in.
 */
async function windowCaughtUp(page: LaunchedApp["page"], cardId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.infinitary.cards.thread(id);
    await window.infinitary.cards.list();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, cardId);
}

test("a reply takes the card off the stack; an acknowledgement does not redraw it, nor does a reload; the report does", async () => {
  const { page, mockProvider } = launched;
  // The preceding image reply can still be finishing when its request is
  // observed; close its card only once its author has ended that turn.
  await waitForFirstmateIdle(page);
  await closeOpenCards(page);
  // A second card to come up when the first leaves.
  await sendPrompt(page, FM_THREAD_PROMPT_MARKER);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  await waitForFirstmateIdle(page);
  await sendPrompt(page, `${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await expect(pager(page, 2)).toBeVisible({ timeout: 30_000 });
  await showCard(page, THREAD_CARD_TITLE);
  const cardId = (await cardReply(page).row.getAttribute("data-card-reply")) ?? "";
  expect(cardId).toBeTruthy();
  await expandDock(page, "activity");

  const newBadge = page.getByRole("status").filter({ hasText: /^\d+ new$/ });
  const asked = feedLine(page, askedUnder(THREAD_CARD_TITLE));
  const askedBefore = await asked.count();
  await sendReply(page, THREAD_ACK_REPLY);
  // One feed line while the crewmate works, and the card left:
  // the other card is now the only card.
  await expect(asked).toHaveCount(askedBefore + 1, { timeout: 20_000 });
  await expect(page.locator("[data-card-pager]")).toHaveCount(0);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
  await expect(newBadge).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("reply-dismissed-card.png") });

  // The acknowledgement is on the record and the crewmate is still at work.
  await expect.poll(() => mockProvider?.heldThreadAnswers() ?? 0, { timeout: 30_000 }).toBe(1);
  const said = await page.evaluate(
    async (id) =>
      (await window.infinitary.cards.thread(id)).messages.map((message) => [
        message.who,
        message.text,
      ]),
    cardId,
  );
  expect(said).toEqual([
    ["captain", THREAD_ACK_REPLY],
    ["crewmate", THREAD_ACK_TEXT],
  ]);
  await windowCaughtUp(page, cardId);
  // The acknowledgement redraws nothing and marks nothing new.
  await expect(page.locator("[data-card-pager]")).toHaveCount(0);
  await expect(newBadge).toHaveCount(0);

  // A reload keeps the replied-under card off the stack.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("textbox", { name: "Task prompt" })).toBeVisible({ timeout: 20_000 });
  await windowCaughtUp(page, cardId);
  await expect(page.locator("[data-card-pager]")).toHaveCount(0);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
  await expect(newBadge).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next card" })).toHaveCount(0);

  // The work lands - a revision, then the report - and the report is what
  // redraws it with the answer: marked new in its original place, never over the card
  // on screen.
  mockProvider?.releaseThreadAnswer();
  await expect(newBadge).toHaveText("1 new", { timeout: 30_000 });
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("answer-marked-new.png") });
  await page.getByRole("button", { name: "Next card" }).click();
  await expect(pagerAt(page, 2, 2)).toBeVisible();
  await expect(shownCard(page, THREAD_ACK_REVISED_TITLE)).toBeVisible();
  await expect(shownCard(page, THREAD_CARD_TITLE)).toHaveCount(0);
  const thread = shownEntry(page).locator("[data-card-thread]");
  await expect(thread.getByText(THREAD_ACK_TEXT)).toBeVisible();
  await expect(thread.getByText(`revised: ${THREAD_ACK_REVISED_TITLE}`)).toBeVisible();
  await expect(newBadge).toHaveCount(0);
  await closeOpenCards(page);
});

test("a lone replied-under card closes from its own X and stays closed through its crewmate's answer", async () => {
  const { page, mockProvider } = launched;
  await waitForFirstmateIdle(page);
  await closeOpenCards(page);
  await sendPrompt(page, `${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER}`);
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
  await showCard(page, THREAD_CARD_TITLE);
  const cardId = (await cardReply(page).row.getAttribute("data-card-reply")) ?? "";
  expect(cardId).toBeTruthy();
  const taskId = await page.evaluate(
    async (id) => (await window.infinitary.cards.list()).find((card) => card.id === id)?.taskId,
    cardId,
  );
  expect(taskId).toBeTruthy();

  // The lone card stays while its crewmate works on the answer.
  await sendReply(page, THREAD_ACK_REPLY);
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => mockProvider?.heldThreadAnswers() ?? 0, { timeout: 30_000 }).toBe(1);
  await windowCaughtUp(page, cardId);

  // The captain closes it with its own X.
  await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible();
  await shownEntry(page)
    .locator("[data-card-pair]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expectNoCard(page, THREAD_CARD_TITLE);

  // The answer it was writing - a revision under the same id - lands after
  // the close, and the crewmate's turn ends: the card stays closed.
  mockProvider?.releaseThreadAnswer();
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) =>
            (await window.infinitary.tasks.board()).tasks.find((task) => task.id === id)?.activity,
          taskId,
        ),
      { message: "the crewmate's answering turn has ended", timeout: 30_000 },
    )
    .toBe("idle");
  await windowCaughtUp(page, cardId);
  expect(
    await page.evaluate(
      async (id) => (await window.infinitary.cards.list()).some((card) => card.id === id),
      cardId,
    ),
  ).toBe(false);
  await expectNoCard(page, THREAD_ACK_REVISED_TITLE);
  await expect(page.locator("[data-card-pager]")).toHaveCount(0);
  await closeOpenCards(page);
});

test("ready waiting follows reachable choices through a reply, reload and return beside working siblings", async () => {
  const userDataDir = scratchDir("infinitary-ready-waiting-");
  const db = openDatabase(userDataDir);
  const parent = seedTask(new TaskService({ db, strict: true }), {
    id: "ready-parent",
    title: "Route work",
    status: "queued",
    startPolicy: "on-request",
  });
  expect(parent.key).toBe(THREAD_TREE_PARENT_KEY);
  new CardStore(db).upsert({
    id: "other-ready-note",
    author: "firstmate",
    priority: 80,
    title: "Another card remains in front",
    meta: "firstmate",
    body: "<p>This note is not a task decision.</p>",
    actions: [],
    status: "ready",
    createdAt: Date.now(),
  });
  db.close();
  const own = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: { INFINITARY_TASK_DELTA_ROWS: "0" },
  });
  try {
    const { page, mockProvider } = own;
    await page.evaluate(async () => {
      const order: { channel: "cards" | "board" | "delta"; value: unknown }[] = [
        { channel: "cards", value: await window.infinitary.cards.list() },
        { channel: "board", value: await window.infinitary.tasks.board() },
      ];
      (window as unknown as { __readyOrder: typeof order }).__readyOrder = order;
      window.infinitary.cards.onCards((value) => order.push({ channel: "cards", value }));
      window.infinitary.tasks.onBoard((value) => order.push({ channel: "board", value }));
      window.infinitary.tasks.onBoardDelta((value) => order.push({ channel: "delta", value }));
    });
    await sendPrompt(
      page,
      `${SPAWN_PROMPT_MARKER} ${THREAD_PROMPT_MARKER} ${THREAD_TREE_PROMPT_MARKER}`,
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            async (title) =>
              (await window.infinitary.cards.list()).some((c) => c.title === title && !c.awaiting),
            THREAD_CARD_TITLE,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const key = await taskKey(page, `${THREAD_PROMPT_MARKER} ${THREAD_TREE_PROMPT_MARKER}`);
    const ready = await page.evaluate(async (key) => {
      const board = await window.infinitary.tasks.board();
      return board.tasks.find((t) => t.key === key);
    }, key);
    if (!ready?.waitingCardId) throw new Error("The ready task has no reachable decision.");
    const cardId = ready.waitingCardId;
    await waitForFirstmateIdle(page);
    await sendPrompt(page, `${SPAWN_PROMPT_MARKER} ${THREAD_WORKING_SIBLING_MARKER}`);
    const siblingKey = await taskKey(page, THREAD_WORKING_SIBLING_MARKER);
    await expect
      .poll(() =>
        page.evaluate(
          async (key) =>
            (await window.infinitary.tasks.board()).tasks.find((t) => t.key === key)?.activity,
          siblingKey,
        ),
      )
      .toBe("running");
    await expandDock(page, "now");
    await expect.poll(() => nowRowGroup(page, key)).toBe("waiting");
    await expect.poll(() => nowRowGroup(page, siblingKey)).toBe("working");
    await expect.poll(() => nowRowGroup(page, parent.key)).toBe("working");
    // The ready decision is behind the existing note, yet its task brings it forward.
    await expect(shownCard(page, "Another card remains in front")).toBeVisible();
    await pressRow(page, key);
    await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible();
    await showCard(page, "Another card remains in front");
    expect(
      (await page.evaluate(() => window.infinitary.projects.list()))[0]?.counts.waitingOnYou,
    ).toBe(1);
    await pressRow(page, key);
    await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible();
    // Retire only the unrelated note so the reply screenshots are unambiguous.
    await page.evaluate(() => window.infinitary.cards.close("other-ready-note"));
    await page.screenshot({ path: test.info().outputPath("ready-waiting-tree.png") });
    const states: unknown[] = [];
    const capture = async (name: string) => {
      const state = await page.evaluate(
        async (id) => ({
          cards: await window.infinitary.cards.list(),
          detail: await window.infinitary.tasks.detail(id),
          projects: await window.infinitary.projects.list(),
        }),
        ready.id,
      );
      states.push({ name, ...state });
      return state;
    };
    const before = await capture("ready");
    expect(before.projects[0]?.counts.waitingOnYou).toBe(1);
    // Task navigation brings this reachable decision forward, regardless of paging.
    await pressRow(page, key);
    await expect(cardReply(page).row).toHaveAttribute("data-card-reply", cardId);
    await sendReply(page, THREAD_ACK_REPLY);
    await expect.poll(() => mockProvider?.heldThreadAnswers() ?? 0).toBe(1);
    await expect.poll(() => nowRowGroup(page, key)).toBe("working");
    const hidden = await capture("acknowledgement, still hidden");
    expect(hidden.detail.waitingCardId).toBeNull();
    expect(hidden.projects[0]?.counts.waitingOnYou).toBe(0);
    await pressRow(page, key);
    await expect(recordCard(page)).toBeVisible();
    await expect(recordBar(page)).not.toHaveAttribute("data-record-next", "show-card");
    await page.screenshot({ path: test.info().outputPath("ready-waiting-hidden.png") });
    const order = await page.evaluate(
      () =>
        (window as unknown as { __readyOrder: { channel: string; value: unknown }[] }).__readyOrder,
    );
    let stack: Card[] = [];
    let folded: TaskBoard | null = null;
    for (const entry of order) {
      if (entry.channel === "cards") {
        stack = entry.value as Card[];
        continue;
      }
      folded =
        entry.channel === "board"
          ? (entry.value as TaskBoard)
          : folded && applyTaskBoardDelta(folded, entry.value as TaskBoardDelta);
      if (!folded) throw new Error("The waiting journey missed a board version.");
      for (const task of folded.tasks)
        if (task.waitingCardId)
          expect(
            stack.some(
              (c) =>
                c.id === task.waitingCardId &&
                !c.awaiting &&
                c.status === "ready" &&
                c.actions.length > 0,
            ),
          ).toBe(true);
    }
    await test.info().attach("ordered card and task delivery", {
      body: JSON.stringify(order),
      contentType: "application/json",
    });
    await page.reload();
    await expect(promptInput(page)).toBeVisible();
    await expect.poll(() => nowRowGroup(page, key)).toBe("working");
    // The waiting card stayed on the stage, showing what it showed at the reply.
    await expect(shownCard(page, THREAD_CARD_TITLE)).toBeVisible();
    // A ready return waits behind the record, rather than stealing its place.
    await pressRow(page, key);
    await expect(recordCard(page)).toBeVisible();
    await expectRecordBody(page);
    mockProvider?.releaseThreadAnswer();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.cards.list())).find(
            (card) => card.id === cardId,
          )?.title,
      )
      .toBe(THREAD_ACK_REVISED_TITLE);
    await expect(recordCard(page)).toBeVisible();
    await expect.poll(() => nowRowGroup(page, key)).toBe("waiting");
    await expect(recordBar(page)).toHaveAttribute("data-record-next", "show-card");
    await page.screenshot({ path: test.info().outputPath("ready-waiting-return.png") });
    await recordBarButton(page, "next").click();
    await expect(shownCard(page, THREAD_ACK_REVISED_TITLE)).toBeVisible();
    const returned = await capture("ready return");
    expect(returned.detail.waitingCardId).toBe(cardId);
    expect(returned.projects[0]?.counts.waitingOnYou).toBe(1);
    await page.screenshot({ path: test.info().outputPath("ready-waiting-return.png") });
    await test.info().attach("ready waiting state transitions", {
      body: JSON.stringify(states, null, 2),
      contentType: "application/json",
    });
  } finally {
    await own.close();
  }
});

test("a large paste in a card reply becomes a file and reaches the author with its pointer", async () => {
  const { page } = launched;
  await sendPrompt(page, `${FM_THREAD_PROMPT_MARKER}`);
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({ timeout: 30000 });
  const box = replyBox(page);
  const text = `reply transcript\r\n${"z".repeat(78438)}`;
  await box.evaluate((field, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    field.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, text);
  await expect(box).toHaveValue("");
  await expect(cardReply(page).row.locator("[data-voice-input-paste]")).toContainText("file ·");
  const evidence = process.env.FM_PASTE_EVIDENCE;
  if (evidence) await page.screenshot({ path: join(evidence, "reply-file.png") });
  const cardId = (await cardReply(page).row.getAttribute("data-card-reply")) ?? "";
  await box.press("Enter");
  await expect
    .poll(async () => {
      const thread = await page.evaluate((id) => window.infinitary.cards.thread(id), cardId);
      return thread.messages.some(
        (message) => message.who === "captain" && message.text.includes("full text:"),
      );
    })
    .toBe(true);
  const thread = await page.evaluate((id) => window.infinitary.cards.thread(id), cardId);
  const words =
    thread.messages.find(
      (message) => message.who === "captain" && message.text.includes("full text:"),
    )?.text ?? "";
  const file = /full text: (.+)\]/.exec(words)?.[1] ?? "";
  expect(readFileSync(file, "utf8")).toBe(text);
  if (evidence) writeFileSync(join(evidence, "reply-sent.txt"), words);
});

test("command search follows the chosen revision list and a row expands its own remaining links", async () => {
  const { seedRevisionCard, revisionRows, revisionFrame } = await import("./revisions");
  const fixture = seedRevisionCard({ many: true });
  const local = await launchApp({ withMockProvider: true, userDataDir: fixture.userDataDir });
  try {
    const { page, app } = local;
    const row = revisionRows(page).last();
    const more = row.locator("[data-revision-more]");
    await expect(more).toBeVisible();
    await focusOn(more);
    await more.press("Enter");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const links = row.locator("[data-revision-link]");
    await focusOn(links.first());
    await links.first().press("Enter");
    await expect(revisionFrame(page).getByText("New area 1", { exact: true })).toBeInViewport();
    await runFromSearch(app, page, "cards.next-revision");
    // Area 2 sits under Area 1, already in view: the command has arrived
    // once its area holds the keyboard.
    const area = revisionFrame(page).getByRole("heading", { name: "Area 2", exact: true });
    await expect(area).toBeFocused();
    await expect(revisionFrame(page).getByText("New area 2", { exact: true })).toBeInViewport();
    await area.press("Escape");
    await expect(links.nth(1)).toBeFocused();
  } finally {
    await local.close();
  }
});
