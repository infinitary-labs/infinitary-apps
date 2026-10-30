import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import type { TaskView } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import {
  GAP_CHECKLIST_ACCEPT,
  GAP_CHECKLIST_MARKER,
  GAP_CHECKLIST_TITLE,
  GAP_CHECKS,
  gapChecklist,
} from "./scenarios/gapChecklist";
import { expectNoCard, showCard, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * INF-1824, the captain's accepted plan: a review's gaps from one version
 * arrive on one card as a checklist. Each row starts unticked, Check all
 * ticks every row, and the approval accepts exactly the ticked rows and
 * keeps the rest held, all from the keyboard.
 *
 * Real: the repository and the task's working copy, the validation record
 * and its one writer, the host-drawn checklist, the card frame's answers and
 * the captain's chrome click. Stand-ins: the models (`gapChecklist`) and
 * GitHub (`./githubStub.ts`), which the record never reaches.
 */

const REPO_NAME = "meterlab";
let launched: LaunchedApp;
let github: GitHubStub;

test.beforeAll(async () => {
  const userDataDir = scratchDir("infinitary-validation-checklist-");
  const repo = seedRepo(userDataDir);
  github = await startGitHubStub();
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-meterlab", repo.repoDir, REPO_NAME, Date.now(), "https://github.com/o/meterlab.git");
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [gapChecklist],
    userDataDir,
    env: github.env,
  });
});

test.afterAll(async () => {
  await launched.close();
  await github.close();
});

test("a version's gaps share one checklist card, and the keys accept exactly the ticked rows", async () => {
  const { page } = launched;
  await resizeWindow(launched.app, page, { width: 1280, height: 900 });
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${REPO_NAME} ${GAP_CHECKLIST_MARKER}`);
  await input.press("Enter");

  // One card carries all four gaps; no other card asks about them.
  await expect(shownCard(page, GAP_CHECKLIST_TITLE)).toBeVisible({ timeout: 60_000 });
  await showCard(page, GAP_CHECKLIST_TITLE);
  const frame = cardBody(page, GAP_CHECKLIST_TITLE);
  const rows = frame.locator('input[name="inf-accepted-gaps"]');
  await expect(rows).toHaveCount(GAP_CHECKS.length);
  for (const [, action] of GAP_CHECKS) await expect(frame.getByLabel(action)).not.toBeChecked();
  const checkAll = frame.getByLabel("Check all");

  // Check all ticks every row and, pressed again, clears them.
  await pressKey(checkAll, "Space");
  for (const [, action] of GAP_CHECKS) await expect(frame.getByLabel(action)).toBeChecked();
  await pressKey(checkAll, "Space");
  for (const [, action] of GAP_CHECKS) await expect(frame.getByLabel(action)).not.toBeChecked();

  // The captain ticks the first and third rows by keys, then accepts.
  const ticked = [GAP_CHECKS[0], GAP_CHECKS[2]];
  for (const [, action] of ticked) await pressKey(frame.getByLabel(action), "Space");
  for (const [, action] of ticked) await expect(frame.getByLabel(action)).toBeChecked();
  const accept = page.getByRole("button", { name: GAP_CHECKLIST_ACCEPT.label, exact: true });
  await focusOn(accept);
  await accept.press("Enter");
  await expectNoCard(page, GAP_CHECKLIST_TITLE);

  // The record accepts exactly those two gaps; the other two stay held.
  const taskId = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
    (item: TaskView) => item.title.includes(GAP_CHECKLIST_MARKER),
  )?.id;
  expect(taskId).toBeDefined();
  await expect
    .poll(async () =>
      (
        await page.evaluate((id) => window.infinitary.tasks.detail(id), String(taskId))
      ).liveValidation?.rows.map((row) => [row.id, row.result]),
    )
    .toEqual(
      GAP_CHECKS.map(([id]) => [
        id,
        ticked.some(([picked]) => picked === id) ? "Your exception" : "Not exercised",
      ]),
    );
});
