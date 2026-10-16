import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { type LaunchedApp, launchApp } from "./launch";
import { intersects, minimumWindowSize, type Rect, resizeWindow, settled, within } from "./layout";
import { FM_THREAD_CARD_TITLE, FM_THREAD_PROMPT_MARKER } from "./mockProvider";
import { pastePictures, promptInput } from "./prompt";
import { cardSurface, shownCard } from "./stack";
import { focusOn, typeInto } from "./windowKeys";

/**
 * The multi-line composer (fm3000-multiline-input-s1, PR 2; docs/composer.md).
 * Each test drives the real field and reads what reached the provider: the
 * keys add lines or send, the shell keys edit the draft, Cmd+Z takes back
 * what was typed a run at a time, a long paste rides the turn as a chip, Up
 * brings the last turn back, and at the smallest window a tall draft leaves
 * the card above it usable - layout asserted as order between measured
 * boxes, never as pixel numbers.
 */

let launched: LaunchedApp;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

/** The captain's words in each request that reached the provider, as sent. */
function sentTexts(): string[] {
  return (launched.mockProvider?.requestBodies() ?? []).flatMap((body) => {
    if (!body.trimStart().startsWith("{")) return [];
    const request = JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> };
    return (request.messages ?? []).flatMap((message) => {
      if (message.role !== "user") return [];
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((part: { type?: string; text?: string }) =>
        part.type === "text" && part.text ? [part.text] : [],
      );
    });
  });
}

/** How many requests carried `text` exactly as typed, line breaks and all. */
function sentWith(text: string): number {
  return sentTexts().filter((sent) => sent.includes(text)).length;
}

async function expectSent(text: string): Promise<void> {
  await expect.poll(() => sentWith(text), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** Types into the prompt as keystrokes, line by line, adding lines with `newline`. */
async function typeLines(input: Locator, lines: string[], newline = "Shift+Enter") {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await input.press(newline);
    await input.pressSequentially(line);
  }
}

/** Pastes text into the prompt the way the clipboard hands it over. */
async function pasteText(page: Page, text: string) {
  await promptInput(page).evaluate((field, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    field.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, text);
}

async function box(locator: Locator): Promise<Rect> {
  const found = await locator.boundingBox();
  if (!found) throw new Error(`${locator} is not laid out`);
  return found;
}

const shell = (page: Page) => page.locator("[data-voice-input-shell]");

test("Shift+Enter and Option+Enter add lines, and Enter sends the text exactly as typed", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await typeLines(input, ["multiline keys: first line", "second line"], "Shift+Enter");
  await input.press("Alt+Enter");
  await input.pressSequentially("third line");

  const typed = "multiline keys: first line\nsecond line\nthird line";
  await expect(input).toHaveValue(typed);
  expect(sentWith("multiline keys")).toBe(0);

  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expectSent(typed);
});

test("inside an open code block Enter adds a line, and Cmd+Enter sends from there", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await typeLines(input, ["multiline fence: look at this", "```ts"]);
  await input.press("Enter");
  await input.pressSequentially("await flush();");
  const typed = "multiline fence: look at this\n```ts\nawait flush();";
  await expect(input).toHaveValue(typed);
  await expect(page.locator('[data-voice-input-hint="fence"]')).toBeVisible();
  expect(sentWith("multiline fence")).toBe(0);

  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveValue("");
  await expectSent(typed);

  // Text that arrives without a key (a paste, an input method's commit)
  // moves no caret key, and the hint follows it anyway; so does a draft
  // that replaces it.
  await focusOn(input);
  await typeInto(input, "look:\n```ts\nawait flush();", { insert: true });
  await expect(page.locator('[data-voice-input-hint="fence"]')).toBeVisible();
  await input.press("End");
  await input.fill("no block here\njust two lines");
  const hint = page.locator('[data-voice-input-hint="keys"]');
  await expect(hint).toBeVisible();
  await input.fill("");
});

test("a long paste sends as a removable file with exact full text and recalls its chip", async () => {
  const { page } = launched;
  const input = promptInput(page);
  const log = `transcript\r\n${"x".repeat(78426)}`;
  await input.fill("multiline paste: summarize this transcript");
  await pasteText(page, log);
  const chip = page.locator("[data-voice-input-paste]");
  await expect(chip).toHaveCount(1);
  const evidence = process.env.FM_PASTE_EVIDENCE;
  if (evidence) await page.screenshot({ path: join(evidence, "composer-file.png") });
  await input.press("Enter");
  await expect(chip).toHaveCount(0);
  await expectSent(`multiline paste: summarize this transcript\n\n${log.slice(0, 2000)}`);
  const sent =
    sentTexts().find((text) => text.includes("[truncated 76438 more characters; full text:")) ?? "";
  const path = /full text: (.+)\]/.exec(sent)?.[1] ?? "";
  expect(readFileSync(path, "utf8")).toBe(log);
  if (evidence) writeFileSync(join(evidence, "sent-file.txt"), sent);
  await input.press("ArrowUp");
  await expect(chip).toHaveCount(1);
  await expect(input).toHaveValue("multiline paste: summarize this transcript");
  await chip.getByRole("button").click();
  await expect(chip).toHaveCount(0);
  await input.fill("");

  // A pasted picture comes off the same way.
  await pastePictures(input, [{ name: "shot.png" }]);
  const picture = page.locator("[data-voice-input-attachment]");
  await expect(picture).toHaveCount(1);
  await picture.getByRole("button").click();
  await expect(picture).toHaveCount(0);

  // Even many-line text below 2,000 characters is written to a file.
  const short = "line\r\n".repeat(21);
  await pasteText(page, short);
  await expect(chip).toHaveCount(1);
  await input.press("Enter");
  await expectSent(`${short.trimEnd()}\n[truncated 0 more characters; full text:`);
});

test("a short multi-line paste goes inline with its line breaks", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.fill("");
  await pasteText(page, "one\r\ntwo\rthree");
  await expect(input).toHaveValue("one\ntwo\nthree");
  await expect(page.locator("[data-voice-input-paste]")).toHaveCount(0);
  await input.fill("");
});

test("Up in an empty composer brings the last message back", async () => {
  const { page } = launched;
  const input = promptInput(page);
  const typed = "multiline recall: first\nsecond";
  await input.fill(typed);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expectSent(typed);

  await input.press("ArrowUp");
  await expect(input).toHaveValue(typed);
  // With words in the field, Up is the caret's again.
  await input.press("ArrowUp");
  await expect(input).toHaveValue(typed);
  await input.fill("");
});

test("shell keys edit the draft, undo like typing, and send the words as edited", async () => {
  // Linux gives the shell keys no key and has no macOS Ctrl+A and Ctrl+E
  // (docs/composer.md, "Shell keys").
  test.skip(process.platform !== "darwin", "the shell keys' default keys are the Mac's");
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await typeLines(input, ["shell keys: fix the login bug", "then ship it to staging"]);

  // Ctrl+U clears the caret's line back to its start, and only that line.
  await input.press("Control+U");
  await expect(input).toHaveValue("shell keys: fix the login bug\n");
  await input.press("Meta+Z");
  await expect(input).toHaveValue("shell keys: fix the login bug\nthen ship it to staging");

  // Ctrl+W takes the word before the caret, twice joins both, and Ctrl+Y
  // types back what they took. macOS's own Ctrl+E first leaves the line's end.
  await input.press("Control+E");
  await input.press("Control+W");
  await input.press("Control+W");
  await expect(input).toHaveValue("shell keys: fix the login bug\nthen ship it ");
  await input.pressSequentially("now, ");
  await input.press("Control+Y");
  await expect(input).toHaveValue("shell keys: fix the login bug\nthen ship it now, to staging");

  // macOS's own Ctrl+A still moves to the line's start; Ctrl+K takes the
  // rest of the line, then the line break, and Ctrl+Y types both back.
  await input.press("ArrowUp");
  await input.press("Control+A");
  await input.press("Control+K");
  await input.press("Control+K");
  await expect(input).toHaveValue("then ship it now, to staging");
  await input.press("Control+E");
  await input.pressSequentially(" ");
  await input.press("Control+Y");
  const edited = "then ship it now, to staging shell keys: fix the login bug\n";
  await expect(input).toHaveValue(edited);

  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expectSent(edited.trimEnd());

  // Ctrl+P in an empty field brings the message back, as Up does.
  await input.press("Control+P");
  await expect(input).toHaveValue(edited);
  await input.fill("");
});

test("Cmd+Z takes back a run of typing at a time, a line at a time, and Cmd+Shift+Z puts it back", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.fill("");
  await input.click();
  // A first line long enough to wrap, typed in one go while something
  // elsewhere in the window leaves the page, as a feed line does; then a
  // second line.
  const first =
    "multiline undo: please look into why the login page keeps timing out for people on staging";
  await input.pressSequentially(first.slice(0, 40));
  await page.evaluate(() => {
    const line = document.body.appendChild(document.createElement("div"));
    line.remove();
  });
  await input.pressSequentially(first.slice(40));
  await input.press("Shift+Enter");
  await input.pressSequentially("then ship the fix");
  // Moving the caret ends a run of typing, as in any Mac text field.
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await input.pressSequentially(" before lunch");
  await expect(input).toHaveValue(`${first}\nthen ship the fix before lunch`);

  // Each Cmd+Z takes back one run: the words typed after the caret moved,
  // then the second line, then the first with its line break.
  await input.press("ControlOrMeta+Z");
  await expect(input).toHaveValue(`${first}\nthen ship the fix`);
  await input.press("ControlOrMeta+Z");
  await expect(input).toHaveValue(`${first}\n`);
  await input.press("ControlOrMeta+Z");
  await expect(input).toHaveValue("");

  // Cmd+Shift+Z puts each back in turn.
  await input.press("ControlOrMeta+Shift+Z");
  await expect(input).toHaveValue(`${first}\n`);
  await input.press("ControlOrMeta+Shift+Z");
  await expect(input).toHaveValue(`${first}\nthen ship the fix`);

  // The draft sent is the one undo left.
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expectSent(`${first}\nthen ship the fix`);
  expect(sentWith("before lunch")).toBe(0);
});

test("at the smallest window a tall draft stays in view and clear of the card, and the card still closes", async () => {
  const { app, page } = launched;
  const input = promptInput(page);
  await input.fill(FM_THREAD_PROMPT_MARKER);
  await input.press("Enter");
  const title = shownCard(page, FM_THREAD_CARD_TITLE);
  await expect(title).toBeVisible({ timeout: 30_000 });
  const restore = await resizeWindow(app, page, await minimumWindowSize(app));

  const draft = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await input.fill(draft);
  const laid = await settled(async () => ({
    shell: await box(shell(page)),
    card: await box(cardSurface(page)),
    window: await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
  }));
  // The draft's field stays whole in the window, and never covers the card.
  expect(within(laid.shell, laid.window)).toEqual([]);
  expect(intersects(laid.shell, laid.card)).toBe(false);

  // With the draft still up, Close on the card closes it.
  await page
    .locator("[data-card-layer]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(title).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).some(
        (card) => card.title === FM_THREAD_CARD_TITLE,
      ),
    )
    .toBe(false);
  await expect(input).toHaveValue(draft);
  await input.fill("");
  await resizeWindow(app, page, restore);
});
