import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { MOCK_COMPLETION_TEXT } from "../e2e/mockProvider";
import { promptInput } from "../e2e/prompt";
import { reportLine, startedLine, taskKey } from "../e2e/rails";
import { scratchDir } from "../helpers/scratchDirs";
import { appProcesses, type InstalledApp, launchInstalled } from "./installedApp";

/**
 * An installed Linux package on a clean copy of its system
 * (docs/linux-packages.md, "The checks"): it opens with Chromium's sandbox
 * on, reports the version the package carries, and runs a crew turn on a
 * project with the system's own git, the way a person's first task does.
 */

let launched: InstalledApp;

test.beforeAll(async () => {
  launched = await launchInstalled();
});

test.afterAll(async () => {
  await launched?.close();
});

/** A project with one commit, made with the system's git. */
function project(): string {
  const dir = scratchDir("infinitary-installed-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  writeFileSync(join(dir, "README.md"), "# A project\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

test("the installed package opens sandboxed, reports its version and runs a crew turn with the system's git", async () => {
  test.setTimeout(3 * 60_000);
  const { page } = launched;

  await test.step("it opens on Linux with Chromium's sandbox on", async () => {
    const health = await page.evaluate(() => window.infinitary.app.healthcheck());
    expect(health.ok).toBe(true);
    expect(health.platform).toBe("linux");
    const expected = process.env.INFINITARY_INSTALLED_VERSION?.trim();
    if (expected) expect(health.version).toBe(expected);
    const processes = appProcesses(launched.process.pid as number);
    const table = JSON.stringify(processes, null, 1);
    // Chromium's sandboxed processes run confined in a process namespace of
    // their own, and nothing of the app was told to drop the sandbox.
    expect(
      processes.some((child) => child.seccomp === 2 && child.ownPidNamespace),
      table,
    ).toBe(true);
    expect(
      processes.filter((child) => child.args.includes("--no-sandbox")),
      table,
    ).toEqual([]);
    await expect(promptInput(page)).toBeVisible({ timeout: 30_000 });
  });

  await test.step("a crewmate takes a task on a project and reports", async () => {
    const repo = project();
    await page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
    const title = `tidy the readme in ${basename(repo)}`;
    const input = promptInput(page);
    await input.click();
    await input.fill(`commission a crewmate: ${title}`);
    await input.press("Enter");
    const key = await taskKey(page, title);
    await expect(startedLine(page, key)).toBeVisible({ timeout: 60_000 });
    // The task's working copy is a worktree the system's git made.
    const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"]).toString();
    expect(worktrees).toContain("fm/task-");
    await expect(
      reportLine(page, key).filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) }),
    ).toBeVisible({ timeout: 60_000 });
    const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "crew-turn.png"), animations: "disabled" });
    }
  });
});
