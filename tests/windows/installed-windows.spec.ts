import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { GIT_FOR_WINDOWS } from "../../src/core/windowsGit";
import { GIT_SETUP_WORDS } from "../../src/main/windowsGitSetup";
import { windowsAppUserModelId } from "../../src/main/windowsStartup";
import {
  CANCEL_PROMPT_MARKER,
  MOCK_COMPLETION_TEXT,
  SPAWN_PROMPT_MARKER,
} from "../e2e/mockProvider";
import { promptInput } from "../e2e/prompt";
import { reportLine, startedLine, taskKey } from "../e2e/rails";
import { scratchDir } from "../helpers/scratchDirs";
import { launchInstalled } from "../installed/installedApp";
import {
  JOB_PIDS_FILE,
  stepMark,
  WINDOWS_CREW_MARKER,
  WINDOWS_CREW_STEPS,
  windowsCrew,
} from "./windowsCrew";
import {
  pressDialogButton,
  removalEntries,
  screenshot,
  startMenuEntry,
  stillRunning,
  topAppProcesses,
  uninstallerOf,
} from "./windowsMachine";

/**
 * The Windows installer on a fresh Windows 11 PC (docs/windows.md, "The
 * checks"; INF-4243's piece 1). windows.yml has run the installer the way
 * a person's double-click does, silently, with the app opening at its end.
 * The journey checks the install, presses the Git for Windows offer's
 * install button as a person would, runs a crew turn whose commands use
 * that Git, stops the crewmate's job, and removes the app.
 */

const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
const keep = (name: string, text: string) => {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, name), text);
};

/** A small Node project with one test file and a build, committed with the found Git. */
function nodeProject(git: string): string {
  const dir = scratchDir("infinitary-windows-repo-");
  const run = (...args: string[]) => execFileSync(git, ["-C", dir, ...args]);
  run("init", "--initial-branch=main");
  run("config", "user.name", "Test");
  run("config", "user.email", "test@localhost");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "sum",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", test: "node --test" },
        packageManager: process.env.INFINITARY_WINDOWS_PNPM ?? undefined,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src", "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  writeFileSync(
    join(dir, "test", "sum.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.mjs";\n\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
  );
  writeFileSync(
    join(dir, "build.mjs"),
    'import { mkdirSync, copyFileSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\ncopyFileSync("src/sum.mjs", "dist/sum.mjs");\n',
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\njob-pids.txt\n");
  run("add", "-A");
  run("commit", "-m", "init");
  return dir;
}

test("the Windows installer installs for this person, offers Git, runs a crew turn and removes cleanly", async () => {
  test.setTimeout(20 * 60_000);
  const appData = process.env.APPDATA as string;
  const localAppData = process.env.LOCALAPPDATA as string;
  let executable = "";

  await test.step("it installed for this person alone, with a Start menu entry carrying the app's identity", () => {
    const entries = removalEntries();
    keep("removal-entries.json", JSON.stringify(entries, null, 2));
    expect(entries.map((entry) => entry.hive)).toEqual(["HKCU"]);
    // The NSIS installer writes no InstallLocation: its uninstaller sits in the install's folder.
    const location = entries[0] ? dirname(uninstallerOf(entries[0])) : "";
    expect(location.toLowerCase().startsWith(join(localAppData, "Programs").toLowerCase())).toBe(
      true,
    );
    executable = join(location, "Infinitary.exe");
    expect(existsSync(executable)).toBe(true);
    process.env.INFINITARY_INSTALLED_APP = executable;
    const start = startMenuEntry();
    keep("start-menu.json", JSON.stringify(start, null, 2));
    expect(start?.appId).toBe(windowsAppUserModelId(true));
  });

  await test.step("it opened after install the way the Start menu opens it", async () => {
    await expect.poll(() => topAppProcesses().length, { timeout: 60_000 }).toBeGreaterThan(0);
    const top = topAppProcesses();
    keep("opened-after-install.json", JSON.stringify(top, null, 2));
    // A shell open of the Start menu entry: Explorer starts it, never the installer.
    expect(top.map((process) => process.parent.toLowerCase())).toEqual(["explorer.exe"]);
  });

  const gitRoot = join(localAppData, "Programs", "Git");
  await test.step("with no Git on the PC, it offers Git for Windows and installs it on the person's yes", async () => {
    const [opened] = topAppProcesses();
    if (!opened) throw new Error("the app is not running");
    // The PC had no Git: the offer's dialog is up before any window.
    await expect
      .poll(
        () =>
          pressDialogButton(
            opened.pid,
            GIT_SETUP_WORDS.ask.buttons[0],
            evidence && join(evidence, "git-offer-tree.json"),
          ),
        {
          timeout: 60_000,
          intervals: [500],
        },
      )
      .toBe(true);
    if (evidence) screenshot(join(evidence, "git-download.png"));
    // The download, its checks and Git's own installer, then the window.
    // Git's installer writes git.exe before the files it loads, so the check is
    // that the installed Git answers, not that its file exists.
    const gitVersion = (): string => {
      try {
        return execFileSync(join(gitRoot, "cmd", "git.exe"), ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    };
    await expect
      .poll(gitVersion, { timeout: 10 * 60_000, intervals: [2_000] })
      .toBe(`git version ${GIT_FOR_WINDOWS.version}.windows.1`);
    keep("git-version.txt", gitVersion());
    // The app goes on to open its window once Git is in place.
    await expect
      .poll(
        () =>
          readdirSync(join(appData, "infinitary"), { withFileTypes: true }).some((entry) =>
            entry.name.endsWith(".db"),
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    if (evidence) screenshot(join(evidence, "first-window.png"));
    // taskkill fails the whole tree when one of its programs ended on its own
    // between the walk and the kill (a helper the app had already closed), so
    // the claim is the poll below: no program of the app is left.
    try {
      execFileSync("taskkill", ["/PID", String(opened.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    await expect.poll(() => topAppProcesses().length, { timeout: 30_000 }).toBe(0);
  });

  await test.step("a crewmate's commands run in that Git's Git Bash, and stopping its job ends every program under it", async () => {
    const launched = await launchInstalled({ scenarios: [windowsCrew] });
    try {
      const { page, mockProvider } = launched;
      const health = await page.evaluate(() => window.infinitary.app.healthcheck());
      expect(health.platform).toBe("win32");
      const repo = nodeProject(join(gitRoot, "cmd", "git.exe"));
      await page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
      const title = `${WINDOWS_CREW_MARKER} in ${basename(repo)}`;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      const key = await taskKey(page, title);
      await expect(startedLine(page, key)).toBeVisible({ timeout: 60_000 });
      await expect(
        // The turn's report; a later turn the running job wakes may report again.
        reportLine(page, key)
          .filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) })
          .first(),
      ).toBeVisible({ timeout: 10 * 60_000 });
      const bodies = mockProvider.requestBodies().join("\n");
      keep("crew-requests.txt", bodies);
      for (const step of WINDOWS_CREW_STEPS)
        expect(bodies.includes(stepMark(step.id)), `${step.id}: ${step.command}`).toBe(true);
      if (evidence) await page.screenshot({ path: join(evidence, "crew-turn.png") });

      // The job's program and its own child, both still running.
      const pidsFile = await jobPidsFile(join(gitRoot, "cmd", "git.exe"), repo);
      const pids = readFileSync(pidsFile, "utf8").trim().split(" ").map(Number);
      keep("job-pids.txt", pids.join(" "));
      expect(stillRunning(pids)).toEqual(pids);
      await input.fill(`${CANCEL_PROMPT_MARKER}${title}`);
      await input.press("Enter");
      await expect.poll(() => stillRunning(pids), { timeout: 60_000 }).toEqual([]);
    } finally {
      await launched.close();
    }
  });

  await test.step("removing it in Windows Settings' way keeps the saved work", async () => {
    const [entry] = removalEntries();
    if (!entry) throw new Error("no removal entry");
    // The removal entry's own command, silently, as Settings runs it.
    execFileSync(uninstallerOf(entry), ["/S"]);
    // NSIS's uninstaller runs on from a copy of itself: the app's files go
    // first, then its Start menu entry and removal entry.
    await expect.poll(() => existsSync(executable), { timeout: 120_000 }).toBe(false);
    await expect.poll(() => removalEntries(), { timeout: 60_000 }).toEqual([]);
    await expect.poll(() => startMenuEntry(), { timeout: 60_000 }).toBe(null);
    const kept = readdirSync(join(appData, "infinitary"));
    keep("kept-after-removal.json", JSON.stringify(kept, null, 2));
    expect(kept.some((name) => name.endsWith(".db"))).toBe(true);
  });
});

/** The job's numbers file, in the task's working copy under the project's worktrees. */
async function jobPidsFile(git: string, repo: string): Promise<string> {
  let found = "";
  await expect
    .poll(
      () => {
        const worktrees = execFileSync(git, ["-C", repo, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        })
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length));
        found =
          worktrees.map((dir) => join(dir, JOB_PIDS_FILE)).find((file) => existsSync(file)) ?? "";
        return found;
      },
      { timeout: 60_000 },
    )
    .not.toBe("");
  return found;
}
