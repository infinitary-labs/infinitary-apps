import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { PROJECT_ROW_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { DISCARD_PROMPT_MARKER, LAND_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  addedProjects,
  addFromSetupCard,
  projectLine,
  projectRowWords,
  taskWorktrees,
} from "./projects";
import { promptInput } from "./prompt";
import { putInLine, startedLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import {
  ADOPT_REPO_PROMPT_MARKER,
  CLONE_REPO_PROMPT_MARKER,
  INIT_REPO_PROMPT_MARKER,
  projectSetup,
} from "./scenarios/projectSetup";

/**
 * Phase 3 acceptance under the orchestrator loop, agent-first fleet: the
 * user sets up repos purely by asking the agent - adopt links an existing
 * folder into the app-owned fleet root in place, init and clone create
 * real projects there - and Settings only displays the result. Two
 * commissioned tasks on an adopted repo run in parallel in separate
 * worktrees, with the repo inferred from the request (no picker anywhere);
 * settling a task - discard or land - removes its worktree and branch while
 * the task record and its session JSONL survive (task-system P0, captain
 * decision D2: sessions are never removed wholesale).
 */

type TaskRow = {
  id: string;
  key: string;
  project_id: string;
  status: string;
  closed_reason: string | null;
  workspace_state: string;
  closed_at: number | null;
  /** The branch its start made, which a close removes from the project. */
  branch: string;
};

/** Whether the project still has the named branch. */
function branchListed(repo: string, branch: string): boolean {
  return execFileSync("git", ["-C", repo, "branch", "--list", branch]).toString().trim() !== "";
}

/** The record as the app's own database holds it, read read-only. */
function taskRow(userDataDir: string, taskId: string): TaskRow | undefined {
  return readSavedData(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT id, key, project_id, status, closed_reason, workspace_state, closed_at, branch FROM tasks WHERE id = ?",
        )
        .get(taskId) as TaskRow | undefined,
  );
}

let launched: LaunchedApp;
let registeredRepo: string;

function initGitRepo(): string {
  const dir = scratchDir("infinitary-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  writeFileSync(join(dir, "README.md"), "# Test repo\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

test.beforeAll(async () => {
  registeredRepo = initGitRepo();
  launched = await launchApp({ scenarios: [projectSetup], withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("adopts a local repo by asking the agent and refuses a missing folder", async () => {
  const { page, userDataDir } = launched;
  const input = promptInput(page);

  // A folder that does not exist is refused by the app_change project-setup tool: the
  // turn completes with no repo and no scraped close-out feed line.
  await askFirstmate(page, `${ADOPT_REPO_PROMPT_MARKER}/no/such/infinitary/folder`);
  expect(await addedProjects(page)).toHaveLength(0);

  // The real setup is one conversational ask and the captain's Add project
  // on the setup card it puts up - no settings step anywhere. Adoption is a
  // linked reference: the folder stays in place and the app-owned fleet
  // root gains a symlink to it.
  await input.click();
  await input.fill(`${ADOPT_REPO_PROMPT_MARKER}${registeredRepo}`);
  await input.press("Enter");
  await addFromSetupCard(page, basename(registeredRepo));
  await expect.poll(() => addedProjects(page), { timeout: 30_000 }).toHaveLength(1);
  const repoName = registeredRepo.split("/").at(-1) as string;
  const link = join(userDataDir, "fleet", repoName);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(registeredRepo);

  // Settings shows the fleet: the collapsed row says only how it differs
  // from a new project - linked from outside the projects folder, with its
  // path, and a repo with no remote merges locally; asking first is the
  // default, so the line does not say it. Remove lives only on its page.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  const [linked] = await addedProjects(page);
  const row = projectLine(page, linked?.id ?? "");
  await expect(row.getByText(registeredRepo)).toBeVisible();
  await expect(projectRowWords(page, linked?.id ?? "")).toHaveText([
    PROJECT_ROW_WORDS.linked,
    PROJECT_ROW_WORDS.localMerge,
  ]);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("creates and clones projects inside the app-owned fleet root", async () => {
  const { page, userDataDir } = launched;
  const input = promptInput(page);
  const before = (await addedProjects(page)).length;

  // A brand-new project: a real git repo in the fleet root, seeded with a
  // first commit so task worktrees can branch immediately.
  await waitForFirstmateIdle(page);
  await input.click();
  await input.fill(`${INIT_REPO_PROMPT_MARKER}zephyr`);
  await input.press("Enter");
  await addFromSetupCard(page, "zephyr");
  await expect.poll(() => addedProjects(page), { timeout: 30_000 }).toHaveLength(before + 1);
  const zephyrDir = join(userDataDir, "fleet", "zephyr");
  expect(lstatSync(zephyrDir).isDirectory()).toBe(true);
  const head = execFileSync("git", ["-C", zephyrDir, "rev-parse", "--verify", "HEAD"])
    .toString()
    .trim();
  expect(head).toMatch(/^[0-9a-f]{40}$/);

  // An existing remote: cloned into the fleet root, shipping direct-pr.
  const origin = initGitRepo();
  await waitForFirstmateIdle(page);
  await input.click();
  await input.fill(`${CLONE_REPO_PROMPT_MARKER}${origin}`);
  await input.press("Enter");
  await addFromSetupCard(page, basename(origin));
  await expect.poll(() => addedProjects(page), { timeout: 30_000 }).toHaveLength(before + 2);

  const repos = await page.evaluate(() => window.infinitary.repos.list());
  expect(repos.find((repo) => repo.name === "zephyr")).toMatchObject({
    setupKind: "init",
    delivery: "local-only",
    autonomy: false,
  });
  const cloned = repos.find((repo) => repo.setupKind === "clone");
  expect(cloned).toMatchObject({ origin, delivery: "direct-pr" });
  expect(cloned?.path).toBe(join(userDataDir, "fleet", cloned?.name as string));
  expect(existsSync(join(cloned?.path as string, ".git"))).toBe(true);
});

test("two commissioned tasks get separate worktrees; discarding one and landing the other keep their records and sessions (D2)", async () => {
  const { page, userDataDir } = launched;
  // Each step keeps the minute it had as a test of its own.
  test.setTimeout(3 * 60_000);
  // A project of its own, set up the way Settings' "Folder on this Mac" does.
  const repo = initGitRepo();
  await page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
  const repoName = repo.split("/").at(-1) as string;

  await test.step("two commissioned tasks on the project get separate worktrees", async () => {
    // No picker exists anywhere: the repo is inferred because the request
    // names it, through the Firstmate agent's context block.
    await expect(page.getByRole("button", { name: /Task repository/ })).toHaveCount(0);

    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} first parallel task in ${repoName}`);
    await input.press("Enter");
    await expect(
      startedLine(page, await taskKey(page, `first parallel task in ${repoName}`)),
    ).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} second parallel task in ${repoName}`);
    await input.press("Enter");
    await expect(
      startedLine(page, await taskKey(page, `second parallel task in ${repoName}`)),
    ).toBeVisible({ timeout: 30_000 });

    // Two live worktrees, not a card stack.
    await expect(page.locator("[data-card-pager]")).toHaveCount(0);

    // Each task got its own worktree on its own branch, both on the
    // project.
    const taskLines = taskWorktrees(repo);
    expect(taskLines).toHaveLength(2);
    const worktreeDirs = readdirSync(join(userDataDir, "worktrees"));
    expect(worktreeDirs).toHaveLength(2);
    // Each working copy is on the branch its task's record names.
    for (const id of worktreeDirs) {
      const branch = taskRow(userDataDir, id)?.branch ?? "";
      expect(branch).not.toBe("");
      expect(taskLines.filter((line) => line.endsWith(`[${branch}]`))).toHaveLength(1);
    }
  });

  await test.step("discarding a task removes its worktree but keeps its record and session jsonl (D2)", async () => {
    const before = readdirSync(join(userDataDir, "worktrees"));
    expect(before).toHaveLength(2);

    // Both tasks are idle. Discard via conversation.
    await waitForFirstmateIdle(page, 20_000);
    const input = promptInput(page);
    await input.click();
    await input.fill(`${DISCARD_PROMPT_MARKER}first parallel task in ${repoName}`);
    await input.press("Enter");

    await expect
      .poll(() => readdirSync(join(userDataDir, "worktrees")).length, { timeout: 15_000 })
      .toBe(1);
    const after = readdirSync(join(userDataDir, "worktrees"));
    const removed = before.find((dir) => !after.includes(dir)) as string;
    const removedBranch = taskRow(userDataDir, removed)?.branch ?? "";
    expect(removedBranch).not.toBe("");
    // Settling removes the worktree and branch before it marks the record's
    // workspace removed. Wait for both the branch and the final record write.
    await expect.poll(() => branchListed(repo, removedBranch), { timeout: 15_000 }).toBe(false);
    expect(existsSync(join(userDataDir, "worktrees", removed))).toBe(false);
    // The session JSONL survives the discard (captain decision D2), and so
    // does the record: closed as discarded, its worktree noted as removed.
    expect(existsSync(join(userDataDir, "crewmates", removed, "sessions"))).toBe(true);
    await expect
      .poll(() => taskRow(userDataDir, removed)?.workspace_state, { timeout: 15_000 })
      .toBe("removed");
    expect(taskRow(userDataDir, removed)).toMatchObject({
      status: "dropped",
      closed_reason: "discarded",
      workspace_state: "removed",
    });
    expect(taskRow(userDataDir, removed)?.closed_at).toBeGreaterThan(0);
    // The surviving task's session data stays too.
    const survivor = after[0] as string;
    expect(existsSync(join(userDataDir, "crewmates", survivor, "sessions"))).toBe(true);
    expect(taskRow(userDataDir, survivor)).toMatchObject({ status: "active", closed_reason: null });
  });

  await test.step("landing a task closes its record as done and keeps the row and session (D2)", async () => {
    const [survivor] = readdirSync(join(userDataDir, "worktrees")) as [string];
    const survivorBranch = taskRow(userDataDir, survivor)?.branch ?? "";
    expect(survivorBranch).not.toBe("");
    await waitForFirstmateIdle(page, 20_000);
    // A Firstmate land is held where autonomy is off (contract v3.8), and a
    // repository is set up ask-first. This test is about the RECORD a land
    // leaves, so the repository grants the autonomy that lets the fleet land.
    await expect
      .poll(
        async () =>
          await page.evaluate(async (name) => {
            const repos = await window.infinitary.repos.list();
            const id = repos.find((repo) => repo.name === name)?.id ?? "";
            await window.infinitary.repos.configure(id, { autonomy: true });
            return (await window.infinitary.repos.list()).find((repo) => repo.id === id)?.autonomy;
          }, repoName),
        { timeout: 10_000 },
      )
      .toBe(true);
    const input = promptInput(page);
    await input.click();
    await input.fill(`${LAND_PROMPT_MARKER}second parallel task in ${repoName}`);
    await input.press("Enter");

    await expect(
      putInLine(page, await taskKey(page, `second parallel task in ${repoName}`)),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => branchListed(repo, survivorBranch), { timeout: 15_000 }).toBe(false);
    expect(existsSync(join(userDataDir, "worktrees", survivor))).toBe(false);
    // The row survives landing: done/landed, keyed under the repo's project,
    // with its session JSONL still on disk for Observe and the corpus export.
    // The worktree goes first and the row records it after, so wait for the row.
    await expect
      .poll(() => taskRow(userDataDir, survivor)?.workspace_state, { timeout: 15_000 })
      .toBe("removed");
    const row = taskRow(userDataDir, survivor);
    expect(row).toMatchObject({
      status: "done",
      closed_reason: "landed",
      workspace_state: "removed",
    });
    expect(row?.project_id).not.toBe("scratch");
    expect(existsSync(join(userDataDir, "crewmates", survivor, "sessions"))).toBe(true);
  });
});
