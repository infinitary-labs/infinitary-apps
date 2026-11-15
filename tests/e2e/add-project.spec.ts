import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { projectKeyInUseWords } from "../../src/core/tasks/projectKey";
import {
  ADD_PROJECT_WORDS,
  newProjectWords,
  TASK_KEY_WORDS,
} from "../../src/renderer/src/settings/addProjectWords";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { redirectGitClone } from "./homeFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { projectRow } from "./projects";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { assertReadableSettingsFeedback, assertSettingsFits } from "./settings";
import { focusOn, pressKey, pressWindowKey, typeInto } from "./windowKeys";

// Optional task evidence export is outside the working copy, like the host's evidence folder.
const evidence = process.env.INFINITARY_TASK_EVIDENCE;

test("adds folders and new projects in Settings without waking Firstmate, opens duplicates and reports refusals", async () => {
  const home = scratchDir("infinitary-add-local-home-");
  const missing = join(home, "missing-private-project");
  redirectGitClone(home, "https://github.com/octo/private-notes.git", missing);
  const launched = await launchApp({
    withMockProvider: true,
    homeDir: home,
    env: { GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    const { app, page } = launched;
    const requestsBefore = launched.mockProvider?.requests();
    const folder = realpathSync(scratchDir("infinitary-settings-adopt-"));
    writeFileSync(join(folder, "notes.txt"), "keep this untracked\n");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const add = page.locator("[data-add-project]");
    await expect(add.getByRole("button", { name: "GitHub repo", exact: true })).toBeVisible();
    if (evidence) await page.screenshot({ path: join(evidence, "add-project-controls.png") });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    await add.getByRole("button", { name: ADD_PROJECT_WORDS.folderHere }).click();
    await expect(add.getByRole("status")).toContainText(ADD_PROJECT_WORDS.startedGit);
    let repos = await page.evaluate(() => window.infinitary.repos.list());
    const adopted = repos.find((repo) => repo.path === folder);
    if (!adopted) throw new Error("Folder not added");
    await expect(
      projectRow(page, adopted.id).getByRole("button", { expanded: true }),
    ).toBeVisible();
    expect(execFileSync("git", ["-C", folder, "status", "--short"], { encoding: "utf8" })).toBe(
      "?? notes.txt\n",
    );
    await add.getByRole("button", { name: ADD_PROJECT_WORDS.folderHere }).click();
    await expect(add.getByRole("status")).toContainText("already added");
    expect(
      (await page.evaluate(() => window.infinitary.repos.list())).filter(
        (repo) => repo.path === folder,
      ),
    ).toHaveLength(1);
    const chosen = realpathSync(scratchDir("infinitary-add-chosen-folder-"));
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, chosen);
    await page
      .locator('[data-setting="projects-folder"]')
      .getByRole("button", { name: "Choose folder" })
      .click();
    await expect(page.locator("[data-projects-folder-path]")).toHaveText(chosen);
    await add.getByRole("button", { name: "New project", exact: true }).click();
    await expect(add).toContainText(newProjectWords(chosen));
    await add.getByLabel("Name", { exact: true }).fill("launch-site");
    // The project's tasks take the key typed here, not one made from its name.
    const taskKey = add.getByLabel(TASK_KEY_WORDS.label, { exact: true });
    await taskKey.fill("web");
    await expect(add).toContainText(TASK_KEY_WORDS.next("WEB"));
    if (evidence) await add.screenshot({ path: join(evidence, "new-project-form.png") });
    await add.getByRole("button", { name: "Start project" }).click();
    await expect(add.getByRole("status")).toContainText("Added launch-site.");
    await expect(taskKey).toHaveValue("");
    repos = await page.evaluate(() => window.infinitary.repos.list());
    const created = repos.find((repo) => repo.name === "launch-site");
    expect(created).toMatchObject({
      kind: "project",
      delivery: "local-only",
      autonomy: false,
      rigor: "standard",
    });
    if (!created) throw new Error("New project not added");
    expect(created.path).toBe(
      join((await page.evaluate(() => window.infinitary.repos.folder())).path, "launch-site"),
    );
    await expect(
      projectRow(page, created.id).getByRole("button", { expanded: true }),
    ).toBeVisible();
    await assertSettingsFits(page);
    if (evidence) await page.screenshot({ path: join(evidence, "new-project-open.png") });
    const keys = () => page.evaluate(() => window.infinitary.projects.list());
    expect((await keys()).find((project) => project.name === "launch-site")?.key).toBe("WEB");
    // A key another project has is refused, and nothing is started.
    await add.getByLabel("Name", { exact: true }).fill("launch-pad");
    await taskKey.fill("WEB");
    await add.getByRole("button", { name: "Start project" }).click();
    await assertReadableSettingsFeedback(
      add.getByRole("status"),
      projectKeyInUseWords("WEB", "launch-site", false),
    );
    await expect(taskKey).toHaveValue("WEB");
    expect((await keys()).some((project) => project.name === "launch-pad")).toBe(false);
    await taskKey.fill("");
    await add.getByLabel("Name", { exact: true }).fill("../outside");
    await add.getByRole("button", { name: "Start project" }).click();
    await assertReadableSettingsFeedback(add.getByRole("status"), "name");
    await add.getByRole("button", { name: "GitHub repo", exact: true }).click();
    await expect(add.getByText("Your GitHub repos", { exact: true })).toHaveCount(0);
    // INF-1007: a signed-out project host opens its sign-in in Integrations.
    await expect(add.getByRole("button", { name: "Sign in to GitHub", exact: true })).toBeVisible();
    await add.getByLabel("Paste a GitHub link").fill("https://gitlab.com/octo/notes");
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add.getByRole("status")).toContainText(ADD_PROJECT_WORDS.otherHost);
    await add.getByLabel("Paste a GitHub link").fill("https://github.com/octo/private-notes.git");
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await assertReadableSettingsFeedback(
      add.getByRole("status"),
      "GitHub did not let this app add private-notes. Sign in to GitHub at the top of this tab, then try again.",
    );
    if (evidence) await add.screenshot({ path: join(evidence, "github-signin-refusal.png") });
    const operations = await page.evaluate(async () =>
      (await window.infinitary.tasks.board()).tasks.filter((task) => task.kind === "operation"),
    );
    expect(
      operations.filter((task) => task.title === `Set up project ${adopted.name}`),
    ).toHaveLength(1);
    expect(
      operations.filter((task) => task.title === `Set up project ${created.name}`),
    ).toHaveLength(1);
    expect(launched.mockProvider?.requests()).toBe(requestsBefore);
    if (evidence)
      writeFileSync(
        join(evidence, "local-project-results.json"),
        JSON.stringify({ repos, operations }, null, 2),
      );
  } finally {
    await launched.close();
  }
});

test("lists and adds GitHub repos using the app sign-in, filters and marks added repos", async () => {
  const home = scratchDir("infinitary-add-github-home-");
  const userDataDir = scratchDir("infinitary-add-github-data-");
  const source = realpathSync(scratchDir("infinitary-add-github-source-"));
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
    "test: initial project",
  );
  // Git's real URL mapping targets a local disposable source, never github.com.
  redirectGitClone(home, "https://github.com/octo/field-notes.git", source);
  seedGitHubSignIn(userDataDir);
  const github = await startGitHubStub();
  github.setProjects([{ fullName: "octo/field-notes", private: true }, { fullName: "octo/other" }]);
  const launched = await launchApp({
    homeDir: home,
    userDataDir,
    withMockProvider: true,
    env: { ...github.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    const { page } = launched;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const add = page.locator("[data-add-project]");
    await add.getByRole("button", { name: "GitHub repo", exact: true }).click();
    await expect(add.getByText("Your GitHub repos", { exact: true })).toBeVisible();
    await expect(add.getByText("octo/field-notes", { exact: false })).toBeVisible();
    await add.getByLabel("Find a repo").fill("field");
    await expect(add.getByText("octo/other", { exact: true })).toHaveCount(0);
    if (evidence) await add.screenshot({ path: join(evidence, "github-repo-form.png") });
    await add.getByRole("button", { name: "Add", exact: true }).first().click();
    await expect(add.getByRole("status")).toContainText("Added field-notes.");
    await expect(add.getByText("added", { exact: true })).toBeVisible();
    const repos = await page.evaluate(() => window.infinitary.repos.list());
    const repo = repos.find((row) => row.name === "field-notes");
    expect(repo).toMatchObject({
      setupKind: "clone",
      origin: "https://github.com/octo/field-notes.git",
      delivery: "direct-pr",
      autonomy: false,
    });
    if (!repo) throw new Error("GitHub project not added");
    await expect(projectRow(page, repo.id).getByRole("button", { expanded: true })).toBeVisible();
    await assertSettingsFits(page);
    if (evidence) {
      await page.screenshot({ path: join(evidence, "github-project-open.png") });
      writeFileSync(
        join(evidence, "github-project-results.json"),
        JSON.stringify({ repo, requests: github.requests() }, null, 2),
      );
    }
  } finally {
    await launched.close();
    await github.close();
  }
});

test("clones a project from a GitHub Enterprise host the app is signed in to, as a GitHub project there", async () => {
  const enterprise = "github.example.com";
  const home = scratchDir("infinitary-add-enterprise-home-");
  const userDataDir = scratchDir("infinitary-add-enterprise-data-");
  const source = join(scratchDir("infinitary-add-enterprise-source-"), "field-notes");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  execFileSync(
    "git",
    [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "test: initial project",
    ],
    { encoding: "utf8" },
  );
  // Git's real URL mapping targets a local disposable source, never the host.
  redirectGitClone(home, `https://${enterprise}/octo/field-notes.git`, source);
  seedGitHubSignIn(userDataDir, "ghp_e2e_enterprise_key_0123456789", enterprise);
  const github = await startGitHubStub({ host: enterprise });
  github.setProjects([{ fullName: "octo/field-notes", private: true }, { fullName: "octo/other" }]);
  const launched = await launchApp({
    homeDir: home,
    userDataDir,
    withMockProvider: true,
    env: { ...github.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    const { page } = launched;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const add = page.locator("[data-add-project]");
    await add.getByRole("button", { name: `${enterprise} repo`, exact: true }).click();
    await expect(add.getByText("octo/field-notes", { exact: false })).toBeVisible();
    await add.getByLabel("Find a repo").fill("field");
    await add.getByRole("button", { name: "Add", exact: true }).first().click();
    await expect(add.getByRole("status")).toContainText("Added field-notes.");
    const repos = await page.evaluate(() => window.infinitary.repos.list());
    expect(repos.find((row) => row.name === "field-notes")).toMatchObject({
      setupKind: "clone",
      origin: `https://${enterprise}/octo/field-notes.git`,
      host: { kind: "github", name: enterprise },
      delivery: "direct-pr",
    });
    // The listing went to the host's own API, with its key.
    expect(github.requests()).toContain("GET /api/v3/user/repos");
  } finally {
    await launched.close();
    await github.close();
  }
});

/** The captain's words, answered by a Firstmate turn that makes `calls`; the tools' results. */
async function ask(launched: LaunchedApp, words: string, calls: ScriptedCall[]): Promise<string[]> {
  if (!launched.mockProvider) throw new Error("Asking Firstmate needs the mock provider");
  await waitForFirstmateIdle(launched.page);
  const answer = launched.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(launched.page);
  await pressWindowKey(launched.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await typeInto(input, words);
  await pressKey(input, "Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome().results;
}

/**
 * The captain's ask on INF-4220: a project may hold several repositories.
 * In Settings, by keys alone, a person adds a second repository to a project
 * from that project's own row; the two become one project with its name
 * above a row for each, and a task filed in the new repository takes the
 * project's task key, not one of its own.
 */
test("adds a second repository to a project by keys, and a task filed in it takes the project's key", async () => {
  const home = scratchDir("infinitary-add-repository-home-");
  const launched = await launchApp({
    withMockProvider: true,
    homeDir: home,
    env: { GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    const { app, page } = launched;
    const { repo: wallet } = await page.evaluate(() =>
      window.infinitary.repos.setup({ kind: "init", name: "wallet", key: "WAL" }),
    );
    const projectOf = async (name: string) =>
      (await page.evaluate(() => window.infinitary.projects.list())).find((project) =>
        project.repos?.some((repo) => repo.name === name),
      );
    const walletProject = await projectOf("wallet");
    if (!walletProject) throw new Error("The wallet project was not listed");

    await pressWindowKey(app, ",", ["meta"]);
    const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
    await focusOn(projectsTab);
    await pressKey(projectsTab, "Enter");
    const row = projectRow(page, wallet.id).getByRole("button", {
      name: m.settingsProjectsRowCollapsed({ name: "wallet" }),
    });
    await pressKey(row, "Enter");
    await expect(
      projectRow(page, wallet.id).getByRole("button", {
        name: m.settingsProjectsRowExpanded({ name: "wallet" }),
      }),
    ).toHaveAttribute("aria-expanded", "true");

    // The open row of a project of one offers Add a repository, into this project.
    const into = page.locator('[data-add-repository="WAL"]');
    await expect(into).toContainText(
      m.settingsAddRepositoryNext({ key: "WAL", project: walletProject.name }),
    );
    const fresh = into.getByRole("button", { name: m.settingsAddRepositoryNew(), exact: true });
    await pressKey(fresh, "Enter");
    const name = into.getByLabel(m.settingsAddProjectName(), { exact: true });
    await focusOn(name);
    await typeInto(name, "wallet-api");
    await pressKey(name, "Enter");

    // One project now: its name above a row for each repository.
    const group = page.locator('[data-project-group="WAL"]');
    const repositories = group.locator("[data-project-repositories]");
    await expect(repositories.locator("[data-project]")).toHaveCount(2);
    const repos = await page.evaluate(() => window.infinitary.repos.list());
    const api = repos.find((repo) => repo.name === "wallet-api");
    if (!api) throw new Error("wallet-api was not added");
    await expect(repositories.locator(`[data-project="${api.id}"]`)).toBeVisible();
    // The add began in the project of one's row, which gave way to the group:
    // the group's Add a repository row confirms it, and focus is on the new row.
    await expect(group.locator('[data-add-repository="WAL"]')).toContainText(
      m.settingsAddRepositoryAdded({ name: "wallet-api", project: walletProject.name }),
    );
    await expect(
      repositories.locator(`[data-project="${api.id}"]`).getByRole("button", {
        name: m.settingsProjectsRowCollapsed({ name: "wallet-api" }),
      }),
    ).toBeFocused();
    await assertSettingsFits(page);
    expect((await projectOf("wallet-api"))?.id).toBe(walletProject.id);

    // The project of several takes a name of its own, by keys.
    const projectName = group.getByLabel(m.settingsProjectsNameLabel(), { exact: true });
    await focusOn(projectName);
    await pressKey(projectName, "ControlOrMeta+a");
    await typeInto(projectName, "Wallet");
    await pressKey(projectName, "Enter");
    await expect(
      group.getByRole("button", { name: m.settingsProjectsRowExpanded({ name: "Wallet" }) }),
    ).toBeVisible();
    await expect.poll(async () => (await projectOf("wallet-api"))?.name).toBe("Wallet");

    // A task filed in the new repository takes the project's key.
    await pressWindowKey(app, "Escape");
    await expect(projectsTab).toHaveCount(0);
    const [planned] = await ask(launched, "File the balance endpoint.", [
      {
        name: "create_task",
        args: {
          title: "Balance endpoint",
          goal: "The service answers a wallet's balance.",
          user_words: "file the balance endpoint",
          repo_id: api.id,
        },
      },
    ]);
    const [, key] = /Planned (\S+) /.exec(planned ?? "") ?? [];
    expect(key).toMatch(/^WAL-\d+$/);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    expect(board.tasks.find((task) => task.key === key)?.projectId).toBe(walletProject.id);
  } finally {
    await launched.close();
  }
});
