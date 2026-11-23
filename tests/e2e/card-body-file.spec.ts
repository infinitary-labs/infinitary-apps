import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { clock, revisedLine as revisedWords } from "../../src/renderer/src/cards/revisedLine";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  FILE_CARD_INITIAL,
  FILE_CARD_PROMPT_MARKER,
  FILE_CARD_REVISE_MARKER,
  FILE_CARD_REVISED,
  FILE_CARD_TITLE,
  fileCard,
} from "./scenarios/fileCard";
import { cardReply, changeMarks, revisedLine } from "./stack";

/** The words of the mock's card file in its `n`th `<tag>`, as the frame reads them. */
function fileWords(html: string, tag: string, n = 0): string {
  const words = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([^<]+)</${tag}>`, "g"))][n]?.[1];
  if (!words) throw new Error(`The mock's card file has no <${tag}> number ${n + 1}`);
  return words;
}

const ORIGINAL_ANSWER = fileWords(FILE_CARD_INITIAL, "p");
const UPDATED_ANSWER = fileWords(FILE_CARD_REVISED, "p");
const UNCHANGED_EVIDENCE = fileWords(FILE_CARD_REVISED, "p", 1);
const DRAWING_WORDS = fileWords(FILE_CARD_REVISED, "text");

/** The revised line the product writes for these counts, at any time of day. */
function revisedPattern(added: number, removed: number): RegExp {
  const at = Date.now();
  const line = revisedWords({ at, added, removed, rewritten: false, marks: [] }, at);
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapeRegExp(line).replace(escapeRegExp(clock(at, at)), ".*")}$`);
}

// One test owns the whole journey, including its initial card and the file edit.
test("a crewmate emits a file snapshot and shows an edit only on its next explicit call", async () => {
  const launched = await launchApp({ scenarios: [fileCard], withMockProvider: true });
  try {
    const { page, userDataDir } = launched;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${FILE_CARD_PROMPT_MARKER}`);
    await input.press("Enter");
    const frame = cardBody(page, FILE_CARD_TITLE);
    // The first card comes after the first mate's turn, the crewmate's start
    // and its first turn: the 30 s other journeys give a crewmate's card.
    await expect(frame.locator("body")).toContainText(ORIGINAL_ANSWER, { timeout: 30_000 });
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR) {
      await page.screenshot({
        path: join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "file-card-before.png"),
      });
    }
    const tasks = await readdir(join(userDataDir, "crewmates"));
    let path: string | undefined;
    for (const id of tasks) {
      const candidate = join(userDataDir, "crewmates", id, "card-bodies", "answer.html");
      if ((await readFile(candidate, "utf8").catch(() => "")) === FILE_CARD_INITIAL)
        path = candidate;
    }
    expect(path).toBeDefined();
    await writeFile(path as string, FILE_CARD_REVISED);
    // File writes are not display events. The first snapshot remains on screen.
    await expect(frame.locator("body")).toContainText(ORIGINAL_ANSWER);
    const reply = cardReply(page).field;
    await reply.fill(FILE_CARD_REVISE_MARKER);
    await cardReply(page).send.click();
    // The revision comes after the crewmate's next turn.
    await expect(frame.locator("body")).toContainText(UPDATED_ANSWER, { timeout: 30_000 });
    await expect(frame.locator("body")).toContainText(UNCHANGED_EVIDENCE);
    // The new drawing appears on the explicit revision, never on a file edit.
    await expect(frame.getByRole("img", { name: "Revised answer drawing" })).toBeVisible();
    await expect(cardBodyElement(page, FILE_CARD_TITLE)).toHaveCount(1);
    // The edit is what the captain has not seen: the line counts it and its
    // changed paragraph and added drawing carry bars; untouched parts do not.
    await expect(revisedLine(page)).toHaveText(revisedPattern(2, 1));
    const marks = changeMarks(frame);
    await expect(marks.parts).toHaveCount(2);
    await expect(marks.parts).toHaveText([UPDATED_ANSWER, DRAWING_WORDS]);
    await expect(marks.bars).toHaveCount(2);
    expect(await readFile(path as string, "utf8")).toBe(FILE_CARD_REVISED);
    // Optional local evidence sink; never write task artifacts in the project.
    if (process.env.INFINITARY_TASK_EVIDENCE_DIR) {
      await page.screenshot({
        path: join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "file-card-after.png"),
      });
      await writeFile(
        join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "file-card-journey.txt"),
        `Initial explicit emission: ${FILE_CARD_INITIAL}\nFile edited without emission: original snapshot remained visible.\nExplicit revision, same id: ${FILE_CARD_REVISED}\nOne card remained on stage.\n`,
      );
    }
  } finally {
    await launched.close();
  }
});
