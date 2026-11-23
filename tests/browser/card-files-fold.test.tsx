import { fileSizeWords } from "@shared/attachments";
import type { SavedCardFiles } from "@shared/cardFiles";
import type { Card } from "@shared/cards";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  CARD_FILE_WORDS,
  cardFileInFolderWords,
  cardFilesAllWords,
  cardFilesMoreWords,
  cardFilesSavedAllWords,
} from "../../src/renderer/src/cards/cardFileWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, SHOWN_ENTRY, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * INF-4427, the captain under a note whose sixteen file rows squeezed its
 * words to two lines: "we need to cap how many rows these saved files can
 * have... this looks broken", built as direction A with the captain's
 * picks: three rows, then one row for the rest, and Save all into one new
 * Downloads folder named for the task. Data: that note's sixteen files by
 * their names and sizes in the captain's picture.
 */

const TITLE = "Four hero shots re-recorded with pauses and close-ups; the rigor shot stays";
const TASK_TITLE = "Re-record hero shots that rush new viewers";
const PARAGRAPH =
  "I re-recorded four of the five hero shots so a new viewer can follow them. Each now holds every step long enough to read, and the camera moves in on the part that changes.";
const MB = 1000 * 1000;
const FILES = [
  { name: "decision-cards.mp4", bytes: 2.8 * MB },
  { name: "decision-cards.webp", bytes: 54_000 },
  { name: "decision-cards-phone.mp4", bytes: 1.3 * MB },
  { name: "decision-cards-phone.webp", bytes: 44_000 },
  { name: "panels.mp4", bytes: 2.3 * MB },
  { name: "panels.webp", bytes: 27_000 },
  { name: "panels-phone.mp4", bytes: 939_000 },
  { name: "panels-phone.webp", bytes: 14_000 },
  { name: "yours-1920.mp4", bytes: 2.5 * MB },
  { name: "yours-1920.webp", bytes: 31_000 },
  { name: "yours-phone.mp4", bytes: 1.2 * MB },
  { name: "yours-phone.webp", bytes: 14_000 },
  { name: "automate-work.mp4", bytes: 2.2 * MB },
  { name: "automate-work.webp", bytes: 59_000 },
  { name: "automate-work-phone.mp4", bytes: 1.3 * MB },
  { name: "automate-work-phone.webp", bytes: 37_000 },
];
const sum = (files: readonly { bytes: number }[]) =>
  files.reduce((all, file) => all + file.bytes, 0);

const shown = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T & HTMLElement>(`${SHOWN_ENTRY} ${selector}`);
const rows = () => [...document.querySelectorAll<HTMLElement>(`${SHOWN_ENTRY} [data-card-file]`)];
const count = () => shown("[data-card-files-count]") as HTMLElement;
const button = (name: string) =>
  [...count().querySelectorAll("button")].find((each) => each.textContent?.trim() === name);

test("a note's sixteen files fold to three rows and a counting row; Show all, Show fewer and Save all work by keys", async () => {
  const home = subscribed(
    await seededHome({ title: TITLE, taskTitle: TASK_TITLE, paragraph: PARAGRAPH, files: FILES }),
  );
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  let saved: SavedCardFiles = { files: [], batch: null };
  bridge.answer("inf:cards:saved-files", (_cardId, ids) => ({
    files: saved.files.filter((file) => ids.includes(file.id)),
    batch: saved.files.length === ids.length ? saved.batch : null,
  }));
  bridge.answer("inf:cards:save-files", (_cardId, ids, name) => {
    const batch = { savedAs: name, saved: ids.length, failed: [] };
    saved = {
      files: ids.map((id, index) => ({ id, savedAs: FILES[index]?.name ?? id, folder: name })),
      batch,
    };
    return { ...batch, path: `/Downloads/${name}` };
  });
  bridge.answer("inf:cards:open-saved-file", "opened");
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  await stageAtRest();

  // Section: folded, the first three files in the crewmate's order, then one counting row for the other thirteen.
  await expect.poll(() => rows().length).toBe(3);
  expect(rows().map((row) => row.textContent)).toEqual(
    FILES.slice(0, 3).map((file) => expect.stringContaining(file.name)),
  );
  expect(count().textContent).toContain(
    `${cardFilesMoreWords(13)} · ${fileSizeWords(sum(FILES.slice(3)))}`,
  );
  // The folded strip is no taller than four rows: three files and the counting row.
  const strip = shown("[data-card-files]") as HTMLElement;
  const row = (rows()[0] as HTMLElement).getBoundingClientRect().height;
  const gap = Number.parseFloat(getComputedStyle(strip).rowGap);
  expect(strip.getBoundingClientRect().height).toBeLessThanOrEqual(4 * row + 3 * gap + 1);
  // The body keeps room: more than the two lines the sixteen rows left it.
  const middle = shown("[data-card-attachment-row]")?.previousElementSibling as HTMLElement;
  expect(middle.getBoundingClientRect().height).toBeGreaterThan(4 * 24);

  // Section: Show all by Enter opens every row in a list that scrolls after six; focus stays on the toggle.
  const toggle = button(CARD_FILE_WORDS.showAll) as HTMLButtonElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => rows().length).toBe(16);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.textContent?.trim()).toBe(CARD_FILE_WORDS.showFewer);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const list = shown("[data-card-files-list]") as HTMLElement;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  const sixth = (rows()[5] as HTMLElement).getBoundingClientRect();
  const seventh = (rows()[6] as HTMLElement).getBoundingClientRect();
  const box = list.getBoundingClientRect();
  expect(sixth.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
  expect(seventh.bottom).toBeGreaterThan(box.bottom);
  expect(count().getBoundingClientRect().top).toBeGreaterThanOrEqual(box.bottom);
  expect(count().textContent).toContain(`${cardFilesAllWords(16)} · ${fileSizeWords(sum(FILES))}`);

  // Section: Space on Show fewer folds it again, focus still on the toggle.
  await userEvent.keyboard(" ");
  await expect.poll(() => rows().length).toBe(3);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.textContent?.trim()).toBe(CARD_FILE_WORDS.showAll);

  // Section: Tab reaches Save all; Enter saves every file, in order, into one folder named for the task.
  await userEvent.keyboard("{Tab}");
  const saveAll = button(CARD_FILE_WORDS.saveAll) as HTMLButtonElement;
  expect(document.activeElement).toBe(saveAll);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => count().getAttribute("data-card-files-save-state")).toBe("saved");
  const [request] = bridge.requests("inf:cards:save-files");
  const card = (home["inf:cards:list"] as Card[]).find((each) => each.title === TITLE) as Card;
  expect(request).toEqual([card.id, card.files?.map((file) => file.id), TASK_TITLE]);
  expect(count().textContent).toContain(cardFilesSavedAllWords(TASK_TITLE));
  expect(document.activeElement).toBe(saveAll);

  expect(saveAll.textContent?.trim()).toBe(CARD_FILE_WORDS.openFolder);
  for (const row of rows()) {
    expect(row.textContent).toContain(cardFileInFolderWords(TASK_TITLE));
    expect(row.querySelector("button")?.textContent?.trim()).toBe(CARD_FILE_WORDS.open);
  }
  await userEvent.keyboard("{Enter}");
  expect(bridge.requests("inf:cards:open-saved-file")).toEqual([[card.id, null]]);

  // Section: a revision's new list of five folds again from its own count.
  const revised = { ...card, files: card.files?.slice(0, 5) };
  bridge.push("inf:cards", [revised]);
  await expect.poll(() => count().textContent).toContain(cardFilesMoreWords(2));
  expect(rows()).toHaveLength(3);
  expect(count().getAttribute("data-card-files-save-state")).toBe("idle");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
