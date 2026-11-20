import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { purgedTasksText } from "../../src/renderer/src/settings/generalWords";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { seedRetiredTranscripts } from "./savedDataFixtures";

/**
 * Phase 7 (docs/architecture.md §17): the retention purge control (D-13).
 * The update indicator is read in the browser layer
 * (tests/browser/phase7-shellops.test.tsx).
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("the purge control removes every task and its data", async () => {
  const { page, userDataDir } = launched;
  // An idle task still holds its worktree, so the purge has one to remove.
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} write a purge probe note`);
  await input.press("Enter");
  await expect(reportLine(page, await taskKey(page, "write a purge probe note"))).toBeVisible({
    timeout: 30_000,
  });
  await waitForFirstmateIdle(page, 20_000);
  await expect.poll(() => readdirSync(join(userDataDir, "worktrees")).length).toBeGreaterThan(0);

  // The mock seat writes Pi files. Plant the Claude copies and a retired
  // supervision transcripts dir the purge must remove with them.
  const { claudeDir, supervisionDir, supervisionHome } = seedRetiredTranscripts(userDataDir);
  const listing = (dir: string): string[] | null =>
    existsSync(dir) ? readdirSync(dir).sort() : null;
  const before = {
    claude: listing(claudeDir),
    supervision: listing(supervisionDir),
    supervisionHome: listing(supervisionHome),
  };

  // The purge removes every task the app holds, and says how many.
  const tasks = readSavedData(
    userDataDir,
    (db) => (db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count,
  );
  await page.getByRole("button", { name: "Settings" }).click();
  // Two-step confirm: Purge arms, Confirm purge executes.
  await page.getByRole("button", { name: "Purge", exact: true }).click();
  await page.getByRole("button", { name: "Confirm purge" }).click();
  await expect(
    page.locator('[data-setting="purge-task-data"]').getByText(purgedTasksText(tasks), {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readdirSync(join(userDataDir, "worktrees")).length).toBe(0);
  await expect.poll(() => readdirSync(join(userDataDir, "crewmates")).length).toBe(0);
  // Q4: the purge clears the Firstmate rolling session too, including the
  // Claude seat's copies and a retired supervision transcripts dir.
  const firstmateSessions = join(userDataDir, "firstmate", "sessions");
  const dirCount = (dir: string) => (existsSync(dir) ? readdirSync(dir).length : 0);
  await expect.poll(() => dirCount(firstmateSessions)).toBe(0);
  await expect.poll(() => dirCount(claudeDir)).toBe(0);
  await expect.poll(() => dirCount(supervisionDir)).toBe(0);
  expect(existsSync(join(supervisionHome, "keep.txt"))).toBe(true);
  await test.info().attach("purge-dirs.json", {
    body: JSON.stringify(
      {
        before,
        after: {
          sessions: listing(firstmateSessions),
          claude: listing(claudeDir),
          supervision: listing(supervisionDir),
          supervisionHome: listing(supervisionHome),
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  // The dismissed tasks' cards are gone with them.
  await expect(page.locator("[data-screen-label]")).toHaveAttribute(
    "data-screen-label",
    "Null state",
  );
});
