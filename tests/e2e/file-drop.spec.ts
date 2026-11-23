import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { FM_THREAD_CARD_TITLE } from "./crewCards";
import { type LaunchedApp, launchApp } from "./launch";
import { encodePng } from "./pictureFixtures";
import { dropFiles, promptInput } from "./prompt";
import { FM_THREAD_PROMPT_MARKER, firstmateThread } from "./scenarios/firstmateThread";
import { cardReply, closeOpenCards, shownCard } from "./stack";

/**
 * Files given to the main input and to a card's reply (docs/composer.md,
 * "Files"). The drops here carry real File objects the browser built from
 * files on disk (`dropFiles`), so Electron's `webUtils.getPathForFile`
 * answers with their true paths. The picker is the real handler with the
 * system sheet stubbed.
 */

let launched: LaunchedApp;
let files: string;

test.beforeAll(async () => {
  files = scratchDir("infinitary-file-drop-files-");
  launched = await launchApp({
    scenarios: [firstmateThread],
    withMockProvider: true,
    userDataDir: scratchDir("infinitary-file-drop-"),
  });
});

test.afterAll(async () => {
  await launched.close();
});

const PNG = encodePng(8, 8, () => [40, 120, 200]);
/** A PDF-shaped file: binary bytes, so it is an unsupported format whatever its name says. */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n%"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0, 1, 2]),
]);
const ZIP = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0xff, 0xfe]);

function put(name: string, content: Buffer | string): string {
  const path = join(files, name);
  writeFileSync(path, content);
  return path;
}

/** A generated File - what a clipboard or a web page hands over - with no place on disk. */
async function dropGenerated(target: Locator, name: string, bytes: number[]): Promise<void> {
  await target.evaluate(
    (element, { name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name));
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }
    },
    { name, bytes },
  );
}

const shell = (page: Page) => page.locator("[data-voice-input-shell]");

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

test("dropping files on the main input: supported files become chips, unsupported ones become editable paths, and nothing sends", async () => {
  const { page } = launched;
  const input = promptInput(page);
  const notes = "﻿naïve ✓ — résumé\r\n".repeat(4_400).slice(0, 78_438);
  expect(notes.length).toBe(78_438);
  const notesPath = put("notes.csv", notes);
  const picturePath = put("shot.png", PNG);
  const pdfPath = put("My Report été.pdf", PDF);
  const zipPath = put("archive.zip", ZIP);

  await input.click();
  await input.fill("look at these:");
  const before = sentTexts().length;
  await dropFiles(page, shell(page), [pdfPath, notesPath, picturePath, zipPath]);

  await expect(shell(page).locator("[data-voice-input-paste]")).toHaveCount(1);
  await expect(shell(page).locator("[data-voice-input-paste]")).toContainText("notes.csv");
  await expect(shell(page).locator("[data-voice-input-attachment]")).toContainText("shot.png");
  await expect(input).toHaveValue(`look at these:\n${pdfPath}\n${zipPath}`);
  expect(sentTexts().length).toBe(before);

  await input.press("ControlOrMeta+z");
  await expect(input).not.toHaveValue(new RegExp(pdfPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue(`look at these:\n${pdfPath}\n${zipPath}`);

  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() => sentTexts().some((text) => text.includes("[attached file: notes.csv]")), {
      timeout: 30_000,
    })
    .toBe(true);
  const sent = sentTexts().find((text) => text.includes("[attached file: notes.csv]")) ?? "";
  expect(sent).toContain(pdfPath);
  expect(sent).toContain(zipPath);
  const pointer = /full text: (\S+\.txt)\]/.exec(sent)?.[1];
  expect(pointer).toBeTruthy();
  // The complete bytes, line endings and BOM included, through the managed pointer.
  expect(readFileSync(pointer ?? "").equals(Buffer.from(notes, "utf8"))).toBe(true);

  // The accepted picture has a message-owned copy, private to the app.
  const attachments = join(launched.userDataDir, "attachments");
  await expect.poll(() => existsSync(attachments)).toBe(true);
  const [message] = readdirSync(attachments);
  const [copy] = readdirSync(join(attachments, message ?? ""));
  expect(statSync(join(attachments, message ?? "", copy ?? "")).mode & 0o777).toBe(0o600);
  expect(existsSync(pdfPath) && existsSync(notesPath) && existsSync(picturePath)).toBe(true);
});

test("a file with no place on disk gets an honest note, never a made-up path", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.fill("");
  await dropGenerated(shell(page), "clip.pdf", [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  await expect(page.locator('[data-composer-notice="file-not-local"]')).toBeVisible();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Dismiss notice" }).click();
});

test("the picker follows the same rule, and cancelling it changes nothing", async () => {
  const { page, app } = launched;
  const input = promptInput(page);
  await input.fill("picked:");
  const docPath = put("Q3 plan é.docx", ZIP);
  const textPath = put("log.txt", "one\r\ntwo\r\n");
  await app.evaluate(({ dialog }) => {
    (globalThis as { __pickerCalls?: number }).__pickerCalls = 0;
    dialog.showOpenDialog = (async () => {
      (globalThis as { __pickerCalls?: number }).__pickerCalls =
        ((globalThis as { __pickerCalls?: number }).__pickerCalls ?? 0) + 1;
      return { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
  });
  await page.getByRole("button", { name: "Add files" }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __pickerCalls?: number }).__pickerCalls))
    .toBe(1);
  await expect(input).toHaveValue("picked:");
  await expect(shell(page).locator("[data-voice-input-paste]")).toHaveCount(0);

  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: paths,
      })) as typeof dialog.showOpenDialog;
    },
    [docPath, textPath],
  );
  await page.getByRole("button", { name: "Add files" }).click();
  await expect(shell(page).locator("[data-voice-input-paste]")).toContainText("log.txt");
  await expect(input).toHaveValue(`picked:\n${docPath}`);
  // Clear the draft for the next test.
  await shell(page)
    .getByRole("button", { name: /Remove log.txt/ })
    .click();
  await input.fill("");
});

test("a drop that lands elsewhere never navigates or opens the file", async () => {
  const { page } = launched;
  const url = page.url();
  await dropFiles(page, page.locator("body"), [put("stray.txt", "stray")]);
  expect(page.url()).toBe(url);
  await expect(shell(page).locator("[data-voice-input-paste]")).toHaveCount(0);
  await expect(promptInput(page)).toHaveValue("");
});

test("a drop on a card's reply goes to that reply alone, while the main draft stays", async () => {
  const { page } = launched;
  await closeOpenCards(page);
  const main = promptInput(page);
  await main.fill(FM_THREAD_PROMPT_MARKER);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible({
    timeout: 30_000,
  });
  await main.fill("main draft stays");
  const reply = cardReply(page);
  await reply.field.fill("reply words");
  const pdfPath = put("reply doc.pdf", PDF);
  const textPath = put("reply notes.txt", "hello\r\n");
  await dropFiles(page, reply.row, [pdfPath, textPath]);

  await expect(reply.field).toHaveValue(`reply words\n${pdfPath}`);
  await expect(reply.row.locator("[data-voice-input-paste]")).toContainText("reply notes.txt");
  await expect(main).toHaveValue("main draft stays");
  await expect(shell(page).locator("[data-voice-input-paste]")).toHaveCount(0);
  expect(
    sentTexts().some((text) => text.includes(pdfPath) || text.includes("reply notes.txt")),
  ).toBe(false);
  await expect(reply.row.getByRole("button", { name: "Add files to this reply" })).toBeVisible();
});
