import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../../src/core/overflow";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { pastePictures, promptInput } from "./prompt";
import { MAC_ONLY_TAG } from "./tags";

/**
 * The multi-line composer (fm3000-multiline-input-s1, PR 2; docs/composer.md).
 * Each test drives the real field and reads what reached the provider: a
 * long paste rides the turn as a chip whose full text the core writes to a
 * file, and on a Mac the shell keys edit the draft. The keys, short pastes,
 * recall, undo and the smallest window are the browser tests'
 * (tests/browser/multiline-composer.test.tsx,
 * tests/browser/multiline-composer-smallest.test.tsx).
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

/**
 * What the core sends for `typed` with `paste` riding as a file, either side
 * of the file's path: `withPastedFiles`, the composer every turn goes
 * through, run on the spec's own words, so the preview's cut and the
 * pointer's words are the owner's (`src/core/overflow.ts`). The copy it
 * writes goes to a scratch folder of its own.
 */
function spillAround(typed: string, paste: string): { before: string; after: string } {
  initOverflowDir(scratchDir("infinitary-paste-pointer-"));
  const kept: MessageFile[] = [];
  const sent = withPastedFiles(typed, [{ text: paste }], kept);
  const path = kept[0]?.path;
  if (!path) throw new Error("withPastedFiles kept no file for the paste");
  const at = sent.indexOf(path);
  return { before: sent.slice(0, at), after: sent.slice(at + path.length) };
}

/** The file path a sent text points at, between the owner's words around it. */
function spilledPath(sent: string, spill: { before: string; after: string }): string {
  const start = sent.indexOf(spill.before);
  if (start < 0) return "";
  const from = start + spill.before.length;
  const end = sent.indexOf(spill.after, from);
  return end < 0 ? "" : sent.slice(from, end);
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
  const spill = spillAround("multiline paste: summarize this transcript", log);
  await expectSent(spill.before);
  const sent = sentTexts().find((text) => text.includes(spill.before)) ?? "";
  const path = spilledPath(sent, spill);
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
  await expectSent(spillAround("", short).before);
});

test("shell keys edit the draft, undo like typing, and send the words as edited", {
  tag: MAC_ONLY_TAG,
}, async () => {
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
