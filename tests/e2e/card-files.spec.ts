import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cardFileSavedWords } from "../../src/renderer/src/cards/cardFileWords";
import { fileSizeWords } from "../../src/shared/attachments";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  CARD_FILE_LETTER,
  CARD_FILES_PROMPT_MARKER,
  CARD_FILES_TITLE,
  cardFiles,
} from "./scenarios/cardFiles";
import { shownCard } from "./stack";
import { pressKey } from "./windowKeys";

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
