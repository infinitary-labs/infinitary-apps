import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { RESET_MARK_SUFFIX, RESETTING_SUFFIX } from "../../src/core/reset/mark";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { startedLine, taskKey } from "./rails";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingRow } from "./settings";

/**
 * Reset Infinitary (docs/reset.md; the captain's ask that a reset button in
 * Settings "should make the app go back to the initial installed state no
 * matter what"): Keep everything and a declined system confirmation change
 * nothing, and a confirmed reset quits the app, whose next start wipes its
 * folder and opens on the welcome screen. A project in the person's own
 * folder keeps its files and branches; only Infinitary's settings in it go.
 * The second start carries an environment provider key, which must not hide
 * the sign-in screen the reset leads to.
 */

const SENTINEL = "left-from-before-the-reset.txt";
const TASK_TITLE = "tidy the notes";

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function gitIn(repo: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { env: hostEnv(), stdio: "pipe" })
      .toString()
      .trim();
}

/** A project in the person's own folder, with a branch of their own beside main. */
function ownProject(): string {
  const repo = scratchDir("reset-own-project-");
  const git = gitIn(repo);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Someone");
  git("config", "user.email", "someone@localhost");
  writeFileSync(join(repo, "README.md"), "# Notes\n");
  git("add", "-A");
  git("commit", "-m", "start");
  git("switch", "-c", "my-notes");
  writeFileSync(join(repo, "notes.md"), "mine\n");
  git("add", "-A");
  git("commit", "-m", "my notes");
  git("switch", "main");
  return repo;
}

/** What Infinitary may write into a project: task remotes, branch marks and working-copy links. */
function infinitarySettings(repo: string, userDataDir: string) {
  const git = gitIn(repo);
  let marks: string[] = [];
  try {
    marks = git("config", "--local", "--name-only", "--get-regexp", "infinitarytask").split("\n");
  } catch {
    // git answers 1 when no key matches.
  }
  return {
    remotes: git("remote")
      .split("\n")
      .filter((name) => name.startsWith("infinitary")),
    marks,
    copies: git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes(userDataDir)),
  };
}

async function openGeneral(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(settingRow(page, "reset-infinitary")).toBeVisible();
}

test("Reset Infinitary keeps everything until the person confirms, then opens fresh on the welcome screen", async () => {
  test.setTimeout(3 * 60_000);
  const repo = ownProject();
  const git = gitIn(repo);
  const ownCommits = git("rev-parse", "main", "my-notes");
  // The system's own confirmation is a stand-in here, never a real prompt.
  const launched = await launchSecrets({ withMockProvider: true });
  const { app, page, userDataDir, homeDir } = launched;
  const mark = `${userDataDir}${RESET_MARK_SUFFIX}`;
  // e2e-fixture: mutation -- prove the reset deletes what the folder held.
  writeFileSync(join(userDataDir, SENTINEL), "saved work\n");
  // A job a task kept running past its close: the reset runs its own remove
  // before quitting, which shows the first mate's side undid its work first.
  const outside = scratchDir("reset-kept-");
  const keptFolder = join(outside, "job");
  const removed = join(outside, "removed");
  mkdirSync(keptFolder);
  mkdirSync(join(userDataDir, "kept"), { recursive: true });
  // e2e-fixture: mutation -- prove the reset runs a kept job's remove before it quits.
  writeFileSync(
    join(userDataDir, "kept", "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          computer: null,
          account: "",
          label: "nightly backup",
          check: "true",
          remove: `touch '${removed}'`,
          folder: keptFolder,
          task: "t-kept",
          key: "INF-1",
          at: 1,
        },
      ],
    }),
  );
  const homeBefore = listing(homeDir);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  let taskWork = "";
  try {
    await test.step("an open task works in a project from the person's own folder", async () => {
      await page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
      const title = `${TASK_TITLE} in ${basename(repo)}`;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      await expect(startedLine(page, await taskKey(page, title))).toBeVisible({
        timeout: 30_000,
      });
      const [copy] = infinitarySettings(repo, userDataDir).copies;
      expect(copy).toBeDefined();
      // The task's own unmerged work: the reset must keep it in the project.
      const copyDir = (copy as string).slice("worktree ".length);
      const inCopy = gitIn(copyDir);
      writeFileSync(join(copyDir, "tidy.md"), "tidied\n");
      inCopy("add", "-A");
      inCopy("-c", "user.name=Someone", "-c", "user.email=someone@localhost", "commit", "-m", "t");
      taskWork = inCopy("rev-parse", "HEAD");
    });

    await openGeneral(page);
    const row = settingRow(page, "reset-infinitary");
    const resetButton = () =>
      row.getByRole("button", { name: m.settingsGeneralResetButton(), exact: true });
    // Each row says what it keeps: Purge keeps projects, sign-ins and
    // settings; the reset's question points at Purge for tasks only.
    const { knowledge } = await page.evaluate(() => window.infinitary.retention.scope());
    await expect(settingRow(page, "purge-task-data")).toContainText(
      knowledge
        ? m.settingsGeneralPurgeDescriptionKnowledge()
        : m.settingsGeneralPurgeDescription(),
    );
    const untouched = () => {
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(removed)).toBe(false);
      expect(existsSync(join(userDataDir, SENTINEL))).toBe(true);
    };

    await test.step("Keep everything has focus, so Enter resets nothing", async () => {
      await resetButton().click();
      const question = row.locator("[data-reset-question]");
      await expect(question).toContainText(m.settingsGeneralResetKeeps());
      await expect(question).toContainText(m.settingsGeneralResetOpenTasks({ count: 1 }));
      const keep = row.getByRole("button", { name: m.settingsGeneralResetKeep(), exact: true });
      await expect(keep).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);
      await expect(resetButton()).toBeFocused();
      untouched();
    });

    const confirmations = () =>
      app.evaluate(() => (globalThis as SecretsJourneyGlobal).secretsJourney.confirmations);

    await test.step("a declined system confirmation changes nothing", async () => {
      await app.evaluate(() => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = false;
      });
      const before = await confirmations();
      await resetButton().click();
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
      await expect(row.locator("[data-reset-question]")).toHaveCount(0);
      await expect(resetButton()).toBeFocused();
      expect(await confirmations()).toBe(before + 1);
      untouched();
      expect(infinitarySettings(repo, userDataDir).copies.length).toBeGreaterThan(0);
    });

    await test.step("a confirmed reset quits the app and asks its next start to wipe the folder", async () => {
      await app.evaluate(() => {
        (globalThis as SecretsJourneyGlobal).secretsJourney.confirmation = true;
      });
      const exited = new Promise<void>((done) => app.process().once("exit", () => done()));
      await resetButton().click();
      await row.getByRole("button", { name: m.settingsGeneralReset(), exact: true }).click();
      await exited;
      expect(existsSync(mark)).toBe(true);
      expect(existsSync(removed)).toBe(true);
      // An isolated run reaches nothing outside its own folder.
      expect(listing(homeDir)).toEqual(homeBefore);
    });
    await launched.close();

    await test.step("the project keeps its files and branches, and only Infinitary's settings go", async () => {
      expect(git("rev-parse", "main", "my-notes")).toBe(ownCommits);
      expect(existsSync(join(repo, "README.md"))).toBe(true);
      // Discarding the open task kept its unmerged commit under refs/infinitary/kept/.
      expect(git("for-each-ref", "--contains", taskWork, "refs/infinitary/kept/")).not.toBe("");
      expect(infinitarySettings(repo, userDataDir)).toEqual({
        remotes: [],
        marks: [],
        copies: [],
      });
    });

    await test.step("the next start opens on the welcome screen with nothing kept", async () => {
      relaunched = await launchApp({
        userDataDir,
        homeDir,
        env: { OPENAI_API_KEY: "sk-reset-journey" },
      });
      await expect(relaunched.page.locator('[data-first-run-gate="open"]')).toBeVisible({
        timeout: 20_000,
      });
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(join(userDataDir, SENTINEL))).toBe(false);
      // A fresh install makes only its own personal workspace; the adopted project is gone.
      const projects = await relaunched.page.evaluate(() => window.infinitary.repos.list());
      expect(projects.filter((project) => project.kind !== "personal")).toEqual([]);
      const aside = `${basename(userDataDir)}${RESETTING_SUFFIX}`;
      expect(listing(dirname(userDataDir)).filter((name) => name.startsWith(aside))).toEqual([]);
    });
  } finally {
    await relaunched?.close();
    await launched.close();
  }
});
