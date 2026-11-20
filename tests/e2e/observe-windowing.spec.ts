import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { observeBody } from "./frames";
import { launchApp } from "./launch";
import {
  observeTranscriptEntries,
  observeTranscriptRow,
  seedTranscript,
} from "./transcriptFixtures";

// Dogfood scale, through the real storage -> IPC -> Tier-2 frame path.
// Vary heights: a row is never assumed to be one line or one fixed size.
function transcript(count: number) {
  return observeTranscriptEntries(count)
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}

test("Observe reaches every row of a long history and crew, and never lists the retired session, even with its file kept", async () => {
  const userDataDir = scratchDir("infinitary-observe-scale-");
  const file = join(userDataDir, "main.jsonl");
  const retired = join(userDataDir, "supervision.jsonl");
  // Dogfood's history length; its last row is the one the end of the list shows.
  const rows = 6581;
  seedTranscript(file, observeTranscriptEntries(rows), false);
  seedTranscript(retired, observeTranscriptEntries(1), false);
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setFirstmateSessionFile(file);
  settings.setSupervisionSessionFile(retired);
  const tasks = new TaskService({ db, strict: true });
  for (let i = 0; i < 280; i++) {
    seedTask(tasks, {
      id: `crew-${i}`,
      title: `Crew record ${i}`,
      status: "cancelled",
      createdAt: 1_790_000_000_000 + i,
      prompt: `Kept brief ${i}`,
    });
  }
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Observe" }).click();
    const frame = observeBody(page);
    const scroller = frame.locator("[data-observe-transcript]");
    const list = frame.locator("[data-observe-session-list]");
    await expect(scroller.getByText(observeTranscriptRow(rows - 1))).toBeInViewport();
    await expect(frame.locator('[data-observe-group="supervision"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.observe.sessions())).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "supervision" })]),
    );
    expect(readFileSync(retired, "utf8")).toBe(transcript(1));

    // The reader reaches the oldest row, the middle (a thumb jump paints
    // its destination, never a white hole) and the newest again.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(scroller.getByText(observeTranscriptRow(0), { exact: true })).toBeInViewport();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await expect
      .poll(() =>
        scroller.evaluate((el) => {
          const view = el.getBoundingClientRect();
          return [...el.querySelectorAll("[data-observe-turn]")].some((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > view.top && box.top < view.bottom;
          });
        }),
      )
      .toBe(true);
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(scroller.getByText(observeTranscriptRow(rows - 1))).toBeInViewport();

    // The last crew row remains reachable and selectable.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const oldest = frame.locator('[data-observe-session="crew-0"]');
    await expect(oldest).toBeVisible();
    await oldest.dispatchEvent("click");
    await expect(frame.locator("[data-observe-detail-header]")).toContainText("Crew record 0");
    await expect(scroller).toContainText("Kept brief 0");
  } finally {
    await launched.close();
  }
});
