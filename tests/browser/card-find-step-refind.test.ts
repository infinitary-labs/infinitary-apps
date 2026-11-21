import type { CardMessage, CardThread } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, bodyDrawn, cardBodyFrame, inCardBody, inShown, stageAtRest } from "./stack";
import { openWindow } from "./window";

/**
 * Find in this card brings a step's match into sight even when Find reads
 * the card again before the card's page answers the step (docs/keyboard.md,
 * "Finding in the shown card": a match still on its way into sight gets
 * there). The bug this holds, from the card-find journey on a Mac: Enter
 * and Next a moment apart, the second step's mark made the first one's
 * answer come back empty, and that late answer said nothing was on its way;
 * a read again started by a change to the card then dropped the second
 * step's answer and drew without bringing it into sight, so the folded
 * section opened and stayed below the body's sight. Data: the journey's
 * card, its question in the thread, and the first mate's answer arriving
 * while the step is on its way. Completion: the folded words' box inside the
 * card body's scrolled sight. The order is held, not raced: the page's
 * answers to marks wait until Find starts its read again.
 */

const TITLE = "Add a keyboard command to the catalog";
// A card long enough that its body scrolls, its last match in a folded section.
const BODY =
  "<p>Every feature works from the keyboard. A new command joins the catalog with one key.</p>" +
  Array.from(
    { length: 14 },
    (_, i) => `<p>Step ${i + 1}: the catalog row names its label, its scope and who runs it.</p>`,
  ).join("") +
  "<details><summary>Evidence</summary><p>The Keyboard journey presses it by keys.</p></details>";
const QUESTION = "Does the keyboard map change?";
const ANSWER = "Only one new row.";

/** The card body's part a person reads, in the window. */
const bodySight = () => inShown("[data-card-body]").getBoundingClientRect();

/** Where the fold's `selector` lies in the window, read from inside the card's page. */
async function inWindow(selector: string): Promise<{ top: number; bottom: number }> {
  const box = await inCardBody(
    TITLE,
    (target: string) => {
      const rect = document.querySelector(target)?.getBoundingClientRect();
      return rect ? { top: rect.top, height: rect.height } : null;
    },
    selector,
  );
  if (!box) throw new Error(`The card's page drew no ${selector}`);
  const frame = cardBodyFrame(TITLE)?.getBoundingClientRect();
  if (!frame) throw new Error("The card's page is not drawn");
  return { top: frame.top + box.top, bottom: frame.top + box.top + box.height };
}

/** Whether the folded section's words lie inside the card body's sight. */
async function foldedWordsInSight(): Promise<boolean> {
  const words = await inWindow("details p");
  const sight = bodySight();
  return words.top >= sight.top && words.bottom <= sight.bottom;
}

test("a step's match reaches sight when Find reads the card again before its page answers", async () => {
  const home = subscribed(await seededHome({ title: TITLE, body: BODY, question: QUESTION }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  const read = home["inf:cards:thread"];
  const seeded = typeof read === "function" ? await read("card-find") : read;
  if (!seeded) throw new Error("The seeded home read no thread");
  // The journey's window, whose card body scrolls.
  await page.viewport(1280, 640);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  await bodyDrawn(TITLE);
  await stageAtRest();
  const { FrameController } = await import("../../src/renderer/src/plugins/frames/frameController");

  // At rest the fold is shut and below the body's sight.
  expect(await inCardBody(TITLE, () => document.querySelector("details")?.open)).toBe(false);
  expect((await inWindow("summary")).top).toBeGreaterThan(bodySight().bottom);

  await userEvent.click(page.getByRole("button", { name: m.uiCardFind(), exact: true }));
  const field = page.getByRole("textbox", { name: m.uiCardFindField(), exact: true });
  await expect.element(field).toHaveFocus();
  await userEvent.fill(field, "keyboard");
  const count = () => inShown("[data-card-find-count]").textContent;
  // The title, the body, the folded section and the thread's question.
  await expect.poll(count).toBe(m.uiCardFindCount({ current: "1", total: "4" }));

  // From here the card's page answers each mark only once Find reads the
  // card again after the thread's change: both steps are still on their way
  // when that read starts.
  const held: unknown[] = [];
  let holding = true;
  let changed = false;
  const receive = FrameController.prototype.receive;
  const heard = vi.spyOn(FrameController.prototype, "receive").mockImplementation(function (
    this: InstanceType<typeof FrameController>,
    data,
  ) {
    const found = typeof data === "object" && data !== null && "type" in data;
    if (holding && found && data.type === "found") held.push(data);
    else receive.call(this, data);
  });
  const findRead = FrameController.prototype.findRead;
  const reads = vi.spyOn(FrameController.prototype, "findRead").mockImplementation(function (
    this: InstanceType<typeof FrameController>,
  ) {
    const answer = findRead.call(this);
    if (holding && changed) {
      holding = false;
      // The answers come late, after the read began, as a busy page's do.
      for (const message of held.splice(0)) receive.call(this, message);
    }
    return answer;
  });
  try {
    // Enter steps to the body's match, and again at once to the folded one.
    await userEvent.keyboard("{Enter}{Enter}");
    await expect.poll(count).toBe(m.uiCardFindCount({ current: "3", total: "4" }));
    await expect
      .poll(() => inCardBody(TITLE, () => document.querySelector("details")?.open))
      .toBe(true);

    // The first mate's answer reaches the thread: a change to the card, so
    // Find reads it again while the step is on its way.
    const answer: CardMessage = {
      id: Math.max(0, ...seeded.messages.map((message) => message.id)) + 1,
      cardId: seeded.cardId,
      who: "firstmate",
      text: ANSWER,
      at: Date.now(),
    };
    const thread: CardThread = { ...seeded, messages: [...seeded.messages, answer] };
    changed = true;
    bridge.push("inf:cards:thread", thread);
    await expect.poll(() => holding).toBe(false);

    // The step it was on keeps its place, and its folded words come into sight.
    await expect.poll(count).toBe(m.uiCardFindCount({ current: "3", total: "4" }));
    await expect.poll(foldedWordsInSight).toBe(true);
  } finally {
    holding = false;
    heard.mockRestore();
    reads.mockRestore();
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
