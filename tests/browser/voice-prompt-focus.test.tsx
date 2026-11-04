import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox, messageBoxLocator } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * The prompt keeps the focus through a send, as the voice-prompt-focus
 * journey promises beside its recordings, which return focus to the end of
 * the prompt: a click on the send control leaves the field focused and
 * empty, so the next turn is typed straight away, and Enter sends that one
 * the same way.
 */

function field(): HTMLTextAreaElement {
  const box = messageBox();
  if (!box) throw new Error("The window drew no message box");
  return box;
}

test("clicking submit leaves the prompt ready for the next typed turn", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  bridge.answer("inf:converse", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => messageBox()?.disabled).toBe(false);

  await userEvent.fill(messageBoxLocator(), "First question");
  const shell = document.querySelector<HTMLElement>("[data-voice-input-shell]");
  if (!shell) throw new Error("The window drew no message box shell");
  await userEvent.click(page.elementLocator(shell).getByRole("button", { name: "Submit" }));
  await expect.poll(() => field().value).toBe("");
  await expect.element(field()).toHaveFocus();
  // The keys go to whatever holds the focus; nothing clicks the field again.
  await userEvent.keyboard("Follow-up question");
  await expect.poll(() => field().value).toBe("Follow-up question");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => field().value).toBe("");
  await expect.element(field()).toHaveFocus();
  expect(
    bridge.requests("inf:converse").map(([turn]) => (typeof turn === "string" ? turn : turn.text)),
  ).toEqual(["First question", "Follow-up question"]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
