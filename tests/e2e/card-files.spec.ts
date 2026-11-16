import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { downloadsFolderName } from "../../src/core/files/downloadsSave";
import { TaskStore } from "../../src/core/storage/taskRecords";
import {
  CARD_FILE_WORDS,
  cardFileSavedWords,
  cardFilesMoreWords,
  cardFilesSavedAllWords,
} from "../../src/renderer/src/cards/cardFileWords";
import { fileSizeWords } from "../../src/shared/attachments";
import { cardFileTask } from "../../src/shared/cardFiles";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  CARD_FILE_LETTER,
  CARD_FILES_PACK,
  CARD_FILES_PACK_PROMPT_MARKER,
  CARD_FILES_PACK_TITLE,
  CARD_FILES_PROMPT_MARKER,
  CARD_FILES_TITLE,
  cardFiles,
  cardFilesPack,
} from "./scenarios/cardFiles";
import { shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * INF-3757, direction C, under the captain's condition: "the file content
 * should not physically get attached to the card. data transfer should only
 * happen when user click". A crewmate puts a letter on its card's files; the
 * card shows a row with Save, and nothing reaches Downloads until the
 * captain presses Save by keys, when the letter lands whole in Downloads on
 * this computer.
 */
test("saves a crewmate's card file into this computer's Downloads by keys, only on Save", async () => {
  const launched = await launchApp({ scenarios: [cardFiles], withMockProvider: true });
  try {
    const { app, page, homeDir, userDataDir } = launched;
    // This computer's Downloads, as the window's own process saves into it, inside the scratch home.
    const downloads = await app.evaluate(({ app: electron }) => electron.getPath("downloads"));
    expect(downloads.startsWith(homeDir), downloads).toBe(true);
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${CARD_FILES_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(cardBody(page, CARD_FILES_TITLE).locator("body")).toBeVisible();

    const row = shownCard(page, CARD_FILES_TITLE).locator("[data-card-file]");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-card-file-state", "idle");
    await expect(row.getByText(CARD_FILE_LETTER.name, { exact: true })).toBeVisible();
    await expect(row).toContainText(fileSizeWords(CARD_FILE_LETTER.bytes.length));
    // The card holds the reference; the copy is kept with the task's card copies, and nothing moved yet.
    const fileId = await row.getAttribute("data-card-file");
    const kept = readdirSync(join(userDataDir, "crewmates")).map((task) =>
      join(userDataDir, "crewmates", task, "cards", `${fileId}.file`),
    );
    expect(kept.filter((path) => existsSync(path))).toHaveLength(1);
    expect(existsSync(join(downloads, CARD_FILE_LETTER.name))).toBe(false);

    const save = row.getByRole("button");
    await pressKey(save, "Enter");
    await expect(row).toHaveAttribute("data-card-file-state", "saved");
    await expect(row).toContainText(cardFileSavedWords(CARD_FILE_LETTER.name));
    const saved = join(downloads, CARD_FILE_LETTER.name);
    expect(sha256(readFileSync(saved))).toBe(sha256(CARD_FILE_LETTER.bytes));
    // No part file is left beside it. (A Linux home with no Downloads folder saves into the home itself.)
    expect(readdirSync(downloads).filter((name) => name.includes(CARD_FILE_LETTER.name))).toEqual([
      CARD_FILE_LETTER.name,
    ]);
  } finally {
    await launched.close();
  }
});

/**
 * INF-4427, the captain under a card whose file rows squeezed its words:
 * "we need to cap how many rows these saved files can have", with the
 * picks three rows then a row for the rest, and Save all "in one new folder
 * in Downloads, named for the task". A crewmate hands five files; the card
 * shows the first three and a counting row, and Save all by keys lands all
 * five whole in one new folder named for the task's title.
 */
test("saves every file of a folded card into one new Downloads folder named for the task, by keys", async () => {
  const launched = await launchApp({ scenarios: [cardFilesPack], withMockProvider: true });
  try {
    const { app, page, userDataDir } = launched;
    const downloads = await app.evaluate(({ app: electron }) => electron.getPath("downloads"));
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${CARD_FILES_PACK_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(cardBody(page, CARD_FILES_PACK_TITLE).locator("body")).toBeVisible();

    const card = shownCard(page, CARD_FILES_PACK_TITLE);
    const rows = card.locator("[data-card-file]");
    await expect(rows).toHaveCount(3);
    for (const [at, file] of CARD_FILES_PACK.slice(0, 3).entries())
      await expect(rows.nth(at).getByText(file.name, { exact: true })).toBeVisible();
    const count = card.locator("[data-card-files-count]");
    await expect(count).toContainText(cardFilesMoreWords(2));
    const before = new Set(existsSync(downloads) ? readdirSync(downloads) : []);

    // The card's head names its task once the board is read; Save all names the folder from it.
    await expect(card.locator("[data-card-key]")).toBeVisible();
    const saveAll = count.getByRole("button", { name: CARD_FILE_WORDS.saveAll, exact: true });
    await focusOn(saveAll, { focusVisible: true });
    await pressKey(saveAll, "Enter");
    await expect(count).toHaveAttribute("data-card-files-save-state", "saved");

    // The new folder is named for the task the card is about.
    const taskId = cardFileTask((await rows.first().getAttribute("data-card-file")) ?? "");
    const taskTitle = readSavedData(
      userDataDir,
      (db) => new TaskStore(db).get(taskId ?? "")?.title,
    );
    expect(taskTitle).toBeTruthy();
    const named = downloadsFolderName(taskTitle ?? "");
    const made = readdirSync(downloads).filter((name) => !before.has(name));
    expect(made).toEqual([named]);
    await expect(count).toContainText(cardFilesSavedAllWords(named));
    const folder = join(downloads, named);
    expect(readdirSync(folder).sort()).toEqual(CARD_FILES_PACK.map((file) => file.name).sort());
    for (const file of CARD_FILES_PACK)
      expect(sha256(readFileSync(join(folder, file.name)))).toBe(sha256(file.bytes));
  } finally {
    await launched.close();
  }
});
