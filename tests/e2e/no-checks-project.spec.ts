import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { PROJECT_POLICY_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { CHECKS_ABSENT_WORDS } from "../../src/shared/checkSnapshot";
import { noChecksRecordSchema } from "../../src/shared/repos";
import {
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
  RIGOR_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedProject } from "./projectSeed";
import { projectRow } from "./projects";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  GITHUB_CHANGE_PROMPT_MARKER,
  githubChange,
  MOCK_GITHUB_CHANGE_CARD_TITLE,
} from "./scenarios/githubChange";
import { factsStrip, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

/**
 * INF-2114, the captain's checked improvement: "A project with no checks is
 * a recorded fact: its card offers Merge now, nothing watches for two
 * hours", and the approved plan's choice to show it "in Settings → Projects,
 * as a switch beside Care" that the captain flips by keys.
 *
 * A project on GitHub whose pull requests run no checks: a local stand-in
 * GitHub serves the app's real sign-in, forge and merge and lists no check
 * run on any version, and every push lands on a bare repository here. The
 * captain turns Require pull request checks off by keys; a scripted
 * crewmate (`scenarios/githubChange.ts`) then commits, pushes, opens its
 * pull request and reads its checks with its own tools. Completion signals
 * are the saved project record, the task's saved reading with no watch,
 * and the one merge the stand-in records at the pushed version.
 * Requires desktop Electron and local git; no real sign-in or shared pull
 * request.
 */
test("a project recorded by keys as running no checks shows its merge card at once, watches nothing and merges on one key", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-no-checks-");
  const bare = join(userDataDir, "github-meterlab.git");
  const meterlab = join(userDataDir, "meterlab");
  const origin = "https://github.com/octo/meterlab.git";
  git("init", "--bare", "--initial-branch=main", bare);
  git("init", "--initial-branch=main", meterlab);
  git("-C", meterlab, "config", "user.name", "Test");
  git("-C", meterlab, "config", "user.email", "test@localhost");
  git("-C", meterlab, "commit", "--allow-empty", "-m", "chore: start the meter");
  git("-C", meterlab, "remote", "add", "origin", origin);
  git("-C", meterlab, "config", `url.${bare}.insteadOf`, origin);
  git("-C", meterlab, "push", "origin", "HEAD:refs/heads/main");
  // The folder knows origin's default branch the way a clone does, so the merge's refresh reads it.
  git("-C", meterlab, "fetch", "--quiet", "origin");
  git("-C", meterlab, "remote", "set-head", "origin", "--auto");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: meterlab,
    name: "meterlab",
    setupKind: "clone",
    origin,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  db.close();
  seedGitHubSignIn(userDataDir);
  const github = await startGitHubStub();
  // The project runs no checks: GitHub lists no check run on any version.
  github.setChecks([]);
  github.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [githubChange],
    userDataDir,
    env: github.env,
  });
  try {
    const { page } = launched;
    const saved = () =>
      readSavedData(userDataDir, (savedDb) => {
        const row = savedDb
          .prepare("SELECT no_checks_json FROM repos WHERE id = ?")
          .get("repo-meterlab") as { no_checks_json: string | null };
        return row.no_checks_json
          ? noChecksRecordSchema.parse(JSON.parse(row.no_checks_json))
          : null;
      });

    // Settings → Projects: Require pull request checks sits after Care, on
    // for a new project, and the captain turns it off by keys.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const row = projectRow(page, "repo-meterlab");
    const header = row.getByRole("button", { expanded: false });
    await expect(header).toBeVisible();
    await pressKey(header, "Enter");
    const quick = row.getByRole("radio", { name: RIGOR_WORDS.quick });
    await expect(quick).toBeChecked();
    const require = row.getByRole("switch", { name: PROJECT_POLICY_WORDS.checksTitle });
    await expect(require).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText(PROJECT_POLICY_WORDS.checksOn);
    await focusOn(quick);
    await pressKey(quick, "Tab");
    await expect(require).toBeFocused();
    await pressKey(require, "Space");
    await expect(require).toHaveAttribute("aria-checked", "false");
    await expect.poll(saved).toEqual({ at: expect.any(Number) });
    await expect(row).toContainText(PROJECT_POLICY_WORDS.checksOff);
    await expect(row).not.toContainText(PROJECT_POLICY_WORDS.checksOn);
    await pressKey(require, "Escape");

    // A crewmate's change in the project: its reading lists no check run.
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} meterlab ${GITHUB_CHANGE_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE)).toBeVisible({ timeout: 60_000 });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const taskId =
      board.tasks.find((task) => task.title.includes(GITHUB_CHANGE_PROMPT_MARKER))?.id ?? "";
    expect(taskId).not.toBe("");
    const pushed = git("-C", bare, "rev-parse", `refs/heads/fm/task-${taskId}`);

    // The card offers the merge at once: no checks, and Merge the pull request.
    const facts = factsStrip(cardBody(page, MOCK_GITHUB_CHANGE_CARD_TITLE));
    await expect(facts.checks).toHaveText(CHECKS_ABSENT_WORDS);
    const merge = page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true });
    await expect(merge).toBeVisible();
    await expect(
      page.getByRole("button", { name: MERGE_WHEN_CHECKS_PASS_WORDS, exact: true }),
    ).toHaveCount(0);
    // Nothing watches the checks: the reading is no checks, with no watch to wake anyone.
    const delivery = () =>
      readSavedData(userDataDir, (savedDb) => new TaskStore(savedDb).get(taskId)?.delivery);
    expect(delivery()?.checks).toMatchObject({ headSha: pushed, items: [], absenceDeclared: true });
    expect(delivery()?.ciWatch).toBeUndefined();

    // One key merges the pushed version.
    await pressKey(merge, "Enter");
    await expect
      .poll(() => github.merges().map(({ number, sha }) => ({ number, sha })), { timeout: 30_000 })
      .toEqual([{ number: 100, sha: pushed }]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
      .toMatchObject({ status: "done", closedReason: "merged" });
    // The record stands for the project's next change.
    expect(saved()).not.toBeNull();
  } finally {
    await launched.close();
    await github.close();
  }
});
