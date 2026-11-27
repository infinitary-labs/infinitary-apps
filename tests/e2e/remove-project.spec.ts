import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { feedLineFrom } from "../../src/shared/feed";
import * as m from "../../src/shared/i18n/messages.generated";
import { REPO_REMOVAL_LINE, repoRemovalQuestion, repoRemovalRefusal } from "../../src/shared/repos";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { redirectGitClone } from "./homeFixtures";
import { launchApp } from "./launch";
import { openProject, projectLine } from "./projects";

// Optional task evidence export is outside the working copy, like the host's evidence folder.
const evidence = process.env.INFINITARY_TASK_EVIDENCE;

/** The task still on the busy project, in this spec's own words. */
const BUSY_TITLE = "Write the help page";

async function addFolder(page: import("@playwright/test").Page, folder: string) {
  const { repo } = await page.evaluate(
    (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
    folder,
  );
  return repo;
}

async function openProjects(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
}

test("removes a project from its page after one question, leaves its folder, and says who did it", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page } = launched;
    const folder = scratchDir("infinitary-remove-project-");
    writeFileSync(join(folder, "keep.txt"), "mine\n");
    const repo = await addFolder(page, folder);
    await openProjects(page);
    await expect(projectLine(page, repo.id)).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${repo.name}` })).toHaveCount(0);
    const row = await openProject(page, repo.id);
    const line = row.locator("[data-remove-project]");
    await expect(line).toContainText(REPO_REMOVAL_LINE);
    if (evidence) await row.screenshot({ path: join(evidence, "remove-line-resting.png") });
    await line.getByRole("button", { name: `Remove ${repo.name}` }).click();
    await expect(line).toContainText(repoRemovalQuestion(repo.name, repo.path));
    const cancel = line.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeFocused();
    if (evidence) await row.screenshot({ path: join(evidence, "remove-line-asking.png") });
    // Enter lands on Cancel: it takes the question back and removes nothing.
    await page.keyboard.press("Enter");
    await expect(line).toContainText(REPO_REMOVAL_LINE);
    expect((await page.evaluate(() => window.infinitary.repos.list())).map((r) => r.id)).toContain(
      repo.id,
    );
    await line.getByRole("button", { name: `Remove ${repo.name}` }).click();
    await line.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(projectLine(page, repo.id)).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.infinitary.repos.list())).map((r) => r.id),
    ).not.toContain(repo.id);
    expect(existsSync(join(folder, "keep.txt"))).toBe(true);
    const feed = await page.evaluate(() => window.infinitary.feed.recent());
    expect(feed.map((entry) => entry.text)).toContain(
      feedLineFrom({
        type: "repo_unregistered",
        actor: "captain",
        repoId: repo.id,
        name: repo.name,
      })?.text,
    );
    const personal = (await page.evaluate(() => window.infinitary.repos.list())).find(
      (r) => r.kind === "personal",
    );
    if (personal) {
      const workspace = await openProject(page, personal.id);
      await expect(workspace.locator("[data-remove-project]")).toHaveCount(0);
    }
  } finally {
    await launched.close();
  }
});

test("names the tasks still on a project up front and writes nothing", async () => {
  const first = await launchApp({ withMockProvider: true });
  const folder = scratchDir("infinitary-remove-busy-");
  const repo = await addFolder(first.page, folder);
  await first.close();
  const db = openDatabase(first.userDataDir);
  const seeded = seedTask(new TaskService({ db }), {
    id: "busy-task",
    title: BUSY_TITLE,
    repoId: repo.id,
    status: "queued",
  });
  db.close();

  const launched = await launchApp({ withMockProvider: true, userDataDir: first.userDataDir });
  try {
    const { page } = launched;
    await openProjects(page);
    const row = await openProject(page, repo.id);
    const line = row.locator("[data-remove-project]");
    await line.getByRole("button", { name: `Remove ${repo.name}` }).click();
    // A queued task may already have started by now: either state blocks.
    const refusal = (status: "planned" | "working") =>
      repoRemovalRefusal(repo.name, [{ key: seeded.key, title: BUSY_TITLE, status }]).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
    await expect(line.locator("[data-remove-notice]")).toHaveText(
      new RegExp(`^(?:${refusal("planned")}|${refusal("working")})$`),
    );
    await expect(line.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    if (evidence) await row.screenshot({ path: join(evidence, "remove-line-busy.png") });
    expect((await page.evaluate(() => window.infinitary.repos.list())).map((r) => r.id)).toContain(
      repo.id,
    );
    const feed = await page.evaluate(() => window.infinitary.feed.recent());
    expect(feed.some((entry) => entry.text.includes("removed"))).toBe(false);
  } finally {
    await launched.close();
  }
});

test("adds a removed project back from its address by linking the folder it left, files and all", async () => {
  const home = scratchDir("infinitary-add-back-home-");
  const userDataDir = scratchDir("infinitary-add-back-data-");
  const source = realpathSync(scratchDir("infinitary-add-back-source-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "test: start",
  );
  // Git's real URL mapping targets a local disposable source, never github.com.
  redirectGitClone(home, "https://github.com/octo/field-notes.git", source);
  seedGitHubSignIn(userDataDir);
  const github = await startGitHubStub();
  github.setProjects([{ fullName: "octo/field-notes" }]);
  const launched = await launchApp({
    homeDir: home,
    userDataDir,
    withMockProvider: true,
    env: { ...github.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    const { page } = launched;
    const notice = page.locator("[data-repository-notice]");
    const addFromGitHub = async () => {
      const add = page.locator("[data-add-project]");
      await add.getByRole("button", { name: "GitHub repo", exact: true }).click();
      await expect(add.getByText("octo/field-notes", { exact: true })).toBeVisible();
      await add.getByRole("button", { name: "Add", exact: true }).first().click();
    };
    const projects = async () =>
      (await page.evaluate(() => window.infinitary.repos.list())).filter(
        (repo) => repo.kind !== "personal",
      );
    await openProjects(page);
    await addFromGitHub();
    await expect(notice).toHaveText(m.settingsAddProjectAdded({ name: "field-notes" }));
    const [first] = await projects();
    if (!first) throw new Error("field-notes was not added");
    writeFileSync(join(first.path, "draft.md"), "not committed yet\n");

    const line = page.locator("[data-remove-project]");
    await line.getByRole("button", { name: `Remove ${first.name}` }).click();
    await line.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(projectLine(page, first.id)).toHaveCount(0);
    expect(existsSync(join(first.path, "draft.md"))).toBe(true);

    await addFromGitHub();
    await expect(notice).toHaveText(m.settingsAddProjectAddedLeftFolder({ name: "field-notes" }));
    const [again] = await projects();
    expect(again).toMatchObject({ name: "field-notes", path: first.path, setupKind: "clone" });
    expect(again?.id).not.toBe(first.id);
    expect(readFileSync(join(first.path, "draft.md"), "utf8")).toBe("not committed yet\n");
    expect(readdirSync(join(userDataDir, "fleet")).filter((name) => name !== "personal")).toEqual([
      "field-notes",
    ]);
    if (evidence) await page.screenshot({ path: join(evidence, "add-back-notice.png") });
  } finally {
    await launched.close();
    await github.close();
  }
});
