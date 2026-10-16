import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { projectKeyInUseWords } from "../../src/core/tasks/projectKey";
import {
  FOLDER_HERE_WORDS,
  newProjectWords,
  OTHER_HOST_WORDS,
  STARTED_GIT_WORDS,
  TASK_KEY_WORDS,
} from "../../src/renderer/src/settings/addProjectWords";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { projectRow } from "./projects";
import { assertReadableSettingsFeedback, assertSettingsFits } from "./settings";

// Optional task evidence export is outside the working copy, like the host's evidence folder.
const evidence = process.env.INFINITARY_TASK_EVIDENCE;

test("adds folders and new projects in Settings without waking Firstmate, opens duplicates and reports refusals", async () => {
  const home = scratchDir("infinitary-add-local-home-");
  const missing = join(home, "missing-private-project");
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "${missing}"]\n\tinsteadOf = https://github.com/octo/private-notes.git\n`,
  );
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
    await add.getByRole("button", { name: FOLDER_HERE_WORDS }).click();
    await expect(add.getByRole("status")).toContainText(STARTED_GIT_WORDS);
    let repos = await page.evaluate(() => window.infinitary.repos.list());
    const adopted = repos.find((repo) => repo.path === folder);
    if (!adopted) throw new Error("Folder not added");
    await expect(
      projectRow(page, adopted.id).getByRole("button", { expanded: true }),
    ).toBeVisible();
    expect(execFileSync("git", ["-C", folder, "status", "--short"], { encoding: "utf8" })).toBe(
      "?? notes.txt\n",
    );
    await add.getByRole("button", { name: FOLDER_HERE_WORDS }).click();
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
    await expect(add.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    await add.getByLabel("Paste a GitHub link").fill("https://gitlab.com/octo/notes");
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add.getByRole("status")).toContainText(OTHER_HOST_WORDS);
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
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "${source}"]\n\tinsteadOf = https://github.com/octo/field-notes.git\n`,
  );
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
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "${source}"]\n\tinsteadOf = https://${enterprise}/octo/field-notes.git\n`,
  );
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
