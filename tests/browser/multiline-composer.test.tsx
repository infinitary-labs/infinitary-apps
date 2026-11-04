import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox, messageBoxLocator } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * The multi-line composer (fm3000-multiline-input-s1, PR 2; docs/composer.md).
 * The test drives the real field and reads what the window sent the core:
 * the keys add lines or send, text that arrives without a key moves the
 * code-block hint too, a short paste goes inline, Up brings the last turn
 * back, and Cmd+Z takes back what was typed a run at a time. One window, as
 * the captain keeps one: each part leaves the box empty.
 *
 * The window in a page has no platform mark, so it keeps a Mac's keys
 * (src/renderer/src/design/core/desktop.ts): ⌘ is Meta on every computer.
 */

/** The words of every turn the window sent, as sent. */
function sentTexts(bridge: FakeBridge): string[] {
  return bridge
    .requests("inf:converse")
    .map(([turn]) => (typeof turn === "string" ? turn : (turn.text ?? "")));
}

/** How many turns carried `text` exactly as typed, line breaks and all. */
const sentWith = (bridge: FakeBridge, text: string) =>
  sentTexts(bridge).filter((sent) => sent.includes(text)).length;

function field(): HTMLTextAreaElement {
  const box = messageBox();
  if (!box) throw new Error("The window drew no message box");
  return box;
}

/** Types `lines` as keystrokes, adding each line after the first with `newline`. */
async function typeLines(lines: string[], newline = "{Shift>}{Enter}{/Shift}"): Promise<void> {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await userEvent.keyboard(newline);
    await userEvent.keyboard(line);
  }
}

/** Pastes text into the message box the way the clipboard hands it over. */
function pasteText(text: string): void {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  field().dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
}

const hint = (kind: string) => document.querySelector(`[data-voice-input-hint="${kind}"]`);
const pasteChips = () => document.querySelectorAll("[data-voice-input-paste]");

test("the message box adds lines, pastes, recalls and undoes as the captain types, and sends the words as typed", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  bridge.answer("inf:converse", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => messageBox()?.disabled).toBe(false);

  // Section: Shift+Enter and Option+Enter add lines, and Enter sends the text exactly as typed.
  {
    await userEvent.click(messageBoxLocator());
    await typeLines(["multiline keys: first line", "second line"]);
    await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
    await userEvent.keyboard("third line");
    const typed = "multiline keys: first line\nsecond line\nthird line";
    await expect.poll(() => field().value).toBe(typed);
    expect(sentWith(bridge, "multiline keys")).toBe(0);

    await userEvent.keyboard("{Enter}");
    await expect.poll(() => field().value).toBe("");
    await expect.poll(() => sentWith(bridge, typed)).toBeGreaterThan(0);
  }

  // Section: inside an open code block Enter adds a line, and Cmd+Enter sends from there.
  {
    await typeLines(["multiline fence: look at this", "```ts"]);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("await flush();");
    const typed = "multiline fence: look at this\n```ts\nawait flush();";
    await expect.poll(() => field().value).toBe(typed);
    await expect.poll(() => hint("fence")).not.toBeNull();
    await expect.element(hint("fence") as HTMLElement).toBeVisible();
    expect(sentWith(bridge, "multiline fence")).toBe(0);

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await expect.poll(() => field().value).toBe("");
    await expect.poll(() => sentWith(bridge, typed)).toBeGreaterThan(0);

    // Text that arrives without a key (a paste, an input method's commit)
    // moves no caret key, and the hint follows it anyway; so does a draft
    // that replaces it. The browser's fill inserts the words whole, as an
    // input method commits them.
    await expect.element(field()).toHaveFocus();
    await userEvent.fill(messageBoxLocator(), "look:\n```ts\nawait flush();");
    await expect.poll(() => hint("fence")).not.toBeNull();
    await expect.element(hint("fence") as HTMLElement).toBeVisible();
    await userEvent.keyboard("{End}");
    await userEvent.fill(messageBoxLocator(), "no block here\njust two lines");
    await expect.poll(() => hint("keys")).not.toBeNull();
    await expect.element(hint("keys") as HTMLElement).toBeVisible();
    await userEvent.fill(messageBoxLocator(), "");
  }
  pasteText("one\r\ntwo\rthree");
  await expect.poll(() => field().value).toBe("one\ntwo\nthree");
  expect(pasteChips()).toHaveLength(0);
  await userEvent.fill(messageBoxLocator(), "");

  // Section: Up in an empty composer brings the last message back.
  {
    const typed = "multiline recall: first\nsecond";
    await userEvent.fill(messageBoxLocator(), typed);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => field().value).toBe("");
    await expect.poll(() => sentWith(bridge, typed)).toBeGreaterThan(0);

    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(() => field().value).toBe(typed);
    // With words in the field, Up is the caret's again.
    await userEvent.keyboard("{ArrowUp}");
    expect(field().value).toBe(typed);
    await userEvent.fill(messageBoxLocator(), "");
  }

  // Section: Cmd+Z takes back a run of typing at a time, a line at a time,
  // and Cmd+Shift+Z puts it back.
  {
    await userEvent.click(messageBoxLocator());
    // A first line long enough to wrap, typed in one go while something
    // elsewhere in the window leaves the page, as a feed line does; then a
    // second line.
    const first =
      "multiline undo: please look into why the login page keeps timing out for people on staging";
    await userEvent.keyboard(first.slice(0, 40));
    document.body.appendChild(document.createElement("div")).remove();
    await userEvent.keyboard(first.slice(40));
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await userEvent.keyboard("then ship the fix");
    // Moving the caret ends a run of typing, as in any Mac text field.
    await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
    await userEvent.keyboard(" before lunch");
    await expect.poll(() => field().value).toBe(`${first}\nthen ship the fix before lunch`);

    // Each Cmd+Z takes back one run: the words typed after the caret moved,
    // then the second line, then the first with its line break.
    const undo = "{Meta>}z{/Meta}";
    await userEvent.keyboard(undo);
    await expect.poll(() => field().value).toBe(`${first}\nthen ship the fix`);
    await userEvent.keyboard(undo);
    await expect.poll(() => field().value).toBe(`${first}\n`);
    await userEvent.keyboard(undo);
    await expect.poll(() => field().value).toBe("");

    // Cmd+Shift+Z puts each back in turn.
    const redo = "{Meta>}{Shift>}z{/Shift}{/Meta}";
    await userEvent.keyboard(redo);
    await expect.poll(() => field().value).toBe(`${first}\n`);
    await userEvent.keyboard(redo);
    await expect.poll(() => field().value).toBe(`${first}\nthen ship the fix`);

    // The draft sent is the one undo left.
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => field().value).toBe("");
    await expect.poll(() => sentWith(bridge, `${first}\nthen ship the fix`)).toBeGreaterThan(0);
    expect(sentWith(bridge, "before lunch")).toBe(0);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
