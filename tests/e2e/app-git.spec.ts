import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { writeLoginShellStub } from "../../src/core/loginShellStub";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, taskKey } from "./rails";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./scenarios/gitStatus";

/**
 * The app brings its own git (git integration phase 2, `docs/forge.md`
 * "The app's own git"). Most people who use Firstmate have never installed
 * developer tools, so their Mac has no git a Dock-launched app could run.
 *
 * This launches the app on a search path that holds no git at all - the
 * system folders without /usr/bin, whose `git` is Apple's installer
 * prompt - with a login shell that adds nothing, on a project kept on this
 * Mac, and asks for work whose crewmate runs `git --version` and
 * `git status` in its working copy. The host made that working copy with
 * the app's git, and the crewmate's shell found the app's git first: the
 * captain reads its version and the working copy's branch in the feed.
 */

// Only the Mac app brings its own git; on Linux the app runs the git on its
// search path (docs/forge.md, "The app's own git").
test.skip(process.platform !== "darwin", "the app's own git is the Mac's");

const NO_GIT_PATH = "/bin:/usr/sbin:/sbin";
let launched: LaunchedApp;
let vendoredVersion: string;

test.beforeAll(async () => {
  for (const dir of NO_GIT_PATH.split(":")) expect(existsSync(join(dir, "git"))).toBe(false);
  // The tree `pnpm install` vendored for this Mac (scripts/ensure-bundled-git.ts).
  const vendored = join(builtAppDir(), "vendor", "git", `darwin-${process.arch}`);
  vendoredVersion = execFileSync(join(vendored, "bin", "git"), ["--version"], {
    encoding: "utf8",
  }).trim();
  const userDataDir = scratchDir("infinitary-app-git-");
  const project = join(userDataDir, "ledger");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", project);
  git("-C", project, "config", "user.name", "Test");
  git("-C", project, "config", "user.email", "test@localhost");
  git("-C", project, "commit", "--allow-empty", "-m", "init");
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  ).run("repo-ledger", project, "ledger", 1, "init", null, "local-only");
  db.close();
  // The person's shell adds nothing either: its path is the launch's own.
  const { shell } = writeLoginShellStub(scratchDir("infinitary-login-shell-"), {});
  launched = await launchApp({
    scenarios: [gitStatus],
    withMockProvider: true,
    userDataDir,
    env: { PATH: NO_GIT_PATH, SHELL: shell },
  });
});

test.afterAll(async () => {
  await launched.close();
});

test("a crewmate's git works on a Mac whose search path holds no git", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  const title = `${GIT_STATUS_PROMPT_MARKER} in ledger`;
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");

  await expect(
    reportLine(page, await taskKey(page, title)).filter({
      hasText: new RegExp(`${MOCK_GIT_REPORT_PREFIX} ${vendoredVersion} on ## fm/`),
    }),
  ).toBeVisible({ timeout: 45_000 });
});
