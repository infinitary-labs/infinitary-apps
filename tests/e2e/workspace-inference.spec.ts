import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { PROJECT_ROW_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { cardMetaWords, FIRSTMATE_CARD_META } from "../../src/shared/cards";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  PROJECT_DELIVERY_WORDS,
  RIGOR_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { LAND_PROMPT_MARKER, MOCK_FM_CHAT_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  addedProjects,
  addFromSetupCard,
  projectLine,
  projectRowWords,
  projectSettings,
  taskBranch,
  taskWorktrees,
} from "./projects";
import { promptInput } from "./prompt";
import { latestContext, servedContext } from "./providerRequest";
import { putInLine, reportLine, startedLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { ADOPT_REPO_PROMPT_MARKER, projectSetup } from "./scenarios/projectSetup";
import {
  AMBIGUOUS_PROMPT_MARKER,
  CONFIGURE_REPO_PROMPT_MARKER,
  MOCK_WHICH_PROJECT_TITLE,
  UNREGISTER_REPO_PROMPT_MARKER,
  workspaceInference,
} from "./scenarios/workspaceInference";
import { cardMeta, expectNoCard, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Workspace inference (phase C acceptance): with two managed repos, a
 * request naming repo B lands in repo B - no picker anywhere; a genuinely
 * ambiguous request yields exactly one clarifying decision card, and the
 * answer routes back into the Firstmate agent's conversation. The fleet
 * itself is agent-operated end to end: both repos are adopted by asking
 * the agent, and agent-made posture changes and removals show up live in
 * the settings list.
 */

let launched: LaunchedApp;
let repoAlpha: string;
let repoBeta: string;

function initGitRepo(prefix: string): string {
  const dir = scratchDir(prefix);
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
  repoAlpha = initGitRepo("infinitary-alpha-");
  repoBeta = initGitRepo("infinitary-beta-");
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [workspaceInference, projectSetup],
  });
  // Adopt both repos by asking the agent: its app_change project-setup puts
  // up the setup card, and the captain's Add project links each into the
  // fleet in place. Each turn, and the one that hears the answer, is
  // awaited so the next converse starts a fresh turn instead of steering.
  const input = promptInput(launched.page);
  for (const [index, path] of [repoAlpha, repoBeta].entries()) {
    await input.click();
    await input.fill(`${ADOPT_REPO_PROMPT_MARKER}${path}`);
    await input.press("Enter");
    await addFromSetupCard(launched.page, basename(path));
    await expect
      .poll(() => addedProjects(launched.page), { timeout: 30_000 })
      .toHaveLength(index + 1);
    await waitForFirstmateIdle(launched.page);
  }
});

test.afterAll(async () => {
  await launched.close();
});

test("an ambiguous request yields one clarifying card whose answer reaches Firstmate", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${AMBIGUOUS_PROMPT_MARKER}: bump the deps`);
  await input.press("Enter");

  // Exactly one concise decision card, from Firstmate itself: its head names
  // the first mate, never the question it filed (INF-2714).
  await expect(shownCard(page, MOCK_WHICH_PROJECT_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(cardMeta(page, MOCK_WHICH_PROJECT_TITLE)).toHaveText(
    cardMetaWords(FIRSTMATE_CARD_META),
  );

  const alphaName = repoAlpha.split("/").at(-1) as string;
  const betaName = repoBeta.split("/").at(-1) as string;
  // Earlier adoption turns also carry project snapshots. Only the current
  // snapshot supplies actions: no duplicate alpha and no missing beta.
  await expect(page.getByRole("button", { name: alphaName, exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: betaName, exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: alphaName, exact: true }).click();
  // The choice routes back as an [fm-op] message; nothing card-worthy
  // means no card and no scraped feed line.
  await expect(shownCard(page, MOCK_WHICH_PROJECT_TITLE)).toHaveCount(0, {
    timeout: 10_000,
  });
  await waitForFirstmateIdle(page);
  await expect(page.getByText(MOCK_FM_CHAT_TEXT)).toHaveCount(0);
});

/**
 * No project picker is up: no card asks which project, and no card offers a
 * project by its name as a choice, the way the which-project card does.
 */
async function expectNoProjectPicker(page: Page, projects: readonly string[]): Promise<void> {
  await expectNoCard(page, MOCK_WHICH_PROJECT_TITLE);
  const offered = (await page.evaluate(() => window.infinitary.cards.list())).flatMap((card) =>
    card.actions.map((action) => action.label),
  );
  for (const project of projects) expect(offered).not.toContain(project);
}

/** Repo beta's standing autonomy flag, returning its id. */
async function setBetaAutonomy(page: Page, autonomy: boolean): Promise<string> {
  const name = repoBeta.split("/").at(-1) as string;
  return await page.evaluate(
    async ([repoName, flag]) => {
      const repos = await window.infinitary.repos.list();
      const id = repos.find((repo) => repo.name === repoName)?.id ?? "";
      await window.infinitary.repos.configure(id, { autonomy: flag as boolean });
      return id;
    },
    [name, autonomy] as [string, boolean],
  );
}

test("a request naming repo B lands in repo B with no picker anywhere, and landing it cleans everything up (Q5)", async () => {
  const { page } = launched;
  const alphaName = repoAlpha.split("/").at(-1) as string;
  const betaName = repoBeta.split("/").at(-1) as string;
  /** The branch the started task's working copy is on, which the land removes. */
  let betaBranch = "";
  await test.step("a request naming repo B lands in repo B with no picker anywhere", async () => {
    await expectNoProjectPicker(page, [alphaName, betaName]);

    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} bump the deps in ${betaName}`);
    await input.press("Enter");

    const key = await taskKey(page, `bump the deps in ${betaName}`);
    await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
    await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
    await waitForFirstmateIdle(page, 20_000);
    // No picker anywhere: no card asks which project, and no card offers a
    // project as a choice, the way the which-project card above does.
    await expectNoProjectPicker(page, [alphaName, betaName]);

    // The worktree landed on repo B, on the task's branch; repo A stayed untouched.
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    betaBranch = await taskBranch(page, board.tasks.find((row) => row.key === key)?.id ?? "");
    expect(betaBranch).not.toBe("");
    const betaTrees = taskWorktrees(repoBeta);
    expect(betaTrees).toHaveLength(1);
    expect(betaTrees[0]).toContain(`[${betaBranch}]`);
    expect(taskWorktrees(repoAlpha)).toHaveLength(0);
  });

  await test.step("landing a finished task merges locally and cleans everything up (Q5)", async () => {
    // A Firstmate land is held where autonomy is off (contract v3.8), and both
    // adopted repos start ask-first. This step is about the landing MECHANICS -
    // the fast-forward, the worktree, the branch - so the repository grants the
    // autonomy that lets the fleet land, and gives it back below so the two
    // settings tests still open on a fleet with none.
    const beta = await setBetaAutonomy(page, true);
    await expect
      .poll(async () => {
        const repos = await page.evaluate(() => window.infinitary.repos.list());
        return repos.find((repo) => repo.id === beta)?.autonomy;
      })
      .toBe(true);
    const input = promptInput(page);
    await input.click();
    await input.fill(`${LAND_PROMPT_MARKER}bump the deps in ${betaName}`);
    await input.press("Enter");

    await expect(putInLine(page, await taskKey(page, `bump the deps in ${betaName}`))).toBeVisible({
      timeout: 30_000,
    });
    // Worktree removal is the first half of deleteTask; the branch goes
    // immediately after. Poll both so we do not read the branch list in the
    // gap (and so we are not looking for a Land/Done card that no longer exists).
    await expect.poll(() => taskWorktrees(repoBeta)).toHaveLength(0);
    await expect
      .poll(() =>
        execFileSync("git", ["-C", repoBeta, "branch", "--list", betaBranch]).toString().trim(),
      )
      .toBe("");
    await setBetaAutonomy(page, false);
  });
});

test("an agent-made posture change shows up live in the settings badges", async () => {
  const { page } = launched;
  const repos = await page.evaluate(() => window.infinitary.repos.list());
  const alpha = repos.find((repo) => repo.path === repoAlpha);
  const beta = repos.find((repo) => repo.path === repoBeta);
  if (!alpha || !beta) throw new Error("Both adopted projects must be registered");
  const alphaRow = projectLine(page, alpha.id);
  const betaRow = projectLine(page, beta.id);
  const storedAutonomy = () =>
    page.evaluate(
      async (ids) => {
        const current = await window.infinitary.repos.list();
        return {
          alpha: current.find((repo) => repo.id === ids.alpha)?.autonomy,
          beta: current.find((repo) => repo.id === ids.beta)?.autonomy,
        };
      },
      { alpha: alpha.id, beta: beta.id },
    );

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  // Both adopted projects ask first, the default, so each line says only
  // that it is linked and merges locally (INF-1495). Other settings can
  // offer autonomy as an option, so read each project's own line and its
  // stored flag.
  const askingFirst = [PROJECT_ROW_WORDS.linked, PROJECT_ROW_WORDS.localMerge];
  await expect.poll(storedAutonomy).toEqual({ alpha: false, beta: false });
  for (const [row, repo] of [
    [alphaRow, alpha],
    [betaRow, beta],
  ] as const) {
    await expect(row.getByRole("button")).toBeVisible();
    await expect(projectRowWords(page, repo.id)).toHaveText(askingFirst);
  }
  const before = await storedAutonomy();
  const priorOperations = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.filter(
    (t) => t.kind === "operation" && t.repo?.name === beta.name,
  );
  const testInfo = test.info();
  await page.screenshot({ path: testInfo.outputPath("projects-before-autonomy.png") });

  // The user asks in conversation; app_change project-settings flips only beta's flag
  // and the still-open settings list re-renders its badge without a reload.
  await page.evaluate(
    (text) => window.infinitary.conversation.send(text),
    `${CONFIGURE_REPO_PROMPT_MARKER}${beta.name} autonomous`,
  );
  await expect.poll(storedAutonomy, { timeout: 30_000 }).toEqual({ alpha: false, beta: true });
  await expect(projectRowWords(page, beta.id)).toHaveText(
    [...askingFirst, PROJECT_ROW_WORDS.mergesOnItsOwn],
    { timeout: 30_000 },
  );
  await expect(projectRowWords(page, alpha.id)).toHaveText(askingFirst);
  const newOperations = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.filter(
    (t) =>
      t.kind === "operation" &&
      t.repo?.name === beta.name &&
      !priorOperations.some((old) => old.id === t.id),
  );
  expect(newOperations).toHaveLength(1);
  const operation = newOperations[0];
  if (!operation) throw new Error("The catalog change must file its operation");
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), operation.id);
  expect(detail?.events.some((e) => e.kind === "status" && e.actor === "firstmate")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("projects-after-autonomy.png") });
  const statePath = testInfo.outputPath("project-autonomy-state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      { alpha, beta, before, after: await storedAutonomy(), operation: detail },
      null,
      2,
    ),
  );
  await testInfo.attach("project-autonomy-state", {
    path: statePath,
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
});

test("the captain can set project policy from a project's page in settings", async () => {
  const { page } = launched;
  const alphaName = repoAlpha.split("/").at(-1) as string;
  // Pull requests require an approved address. Keep the accordion journey’s
  // fixture local and disposable, without changing its policy assertions.
  const origin = scratchDir("infinitary-policy-origin-");
  execFileSync("git", ["-C", origin, "init", "--bare", "--initial-branch=main"], {
    env: hostEnv({ HOME: launched.homeDir }),
  });
  execFileSync("git", ["-C", repoAlpha, "remote", "add", "origin", origin], {
    env: hostEnv({ HOME: launched.homeDir }),
  });
  await page.evaluate(
    async ({ name, origin }) => {
      const repo = (await window.infinitary.repos.list()).find((repo) => repo.name === name);
      if (!repo) throw new Error("The policy fixture must be registered");
      await window.infinitary.repos.configure(repo.id, { origin });
    },
    { name: alphaName, origin },
  );

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  const alpha = await page.evaluate(async (name) => {
    const repos = await window.infinitary.repos.list();
    return repos.find((repo) => repo.name === name);
  }, alphaName);
  if (!alpha) throw new Error("The adopted project must be registered");
  const line = projectLine(page, alpha.id);
  const header = line.getByRole("button");
  const row = projectSettings(page, alpha.id);
  const testInfo = test.info();
  await expect(header).toBeVisible();
  // Asking first is the default, so the line does not say it.
  await expect(projectRowWords(page, alpha.id)).toHaveText([
    PROJECT_ROW_WORDS.linked,
    PROJECT_ROW_WORDS.localMerge,
  ]);
  await line.screenshot({ path: testInfo.outputPath("collapsed-asks-first.png") });
  await header.click();
  await expect(row).toBeVisible();
  await expect(page.getByRole("radio", { name: RIGOR_WORDS.standard })).toBeChecked();
  const approvalSwitch = page.getByRole("switch", { name: AUTONOMY_SWITCH_NAME });
  const stateLabel = row.locator("[data-switch-state-label]");
  const storedAutonomy = () =>
    page.evaluate(async (name) => {
      const repos = await window.infinitary.repos.list();
      return repos.find((repo) => repo.name === name)?.autonomy;
    }, alphaName);

  // The row asks before putting work in: on means the stored autonomy flag is false.
  await expect(approvalSwitch).toHaveAttribute("aria-checked", "true");
  await expect(stateLabel).toHaveText(AUTONOMY_WORDS.asksFirst);
  await expect.poll(storedAutonomy).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("dark-settings-projects-asks-first.png") });
  await row.screenshot({ path: testInfo.outputPath("expanded-asks-first.png") });
  await page.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["direct-pr"] }).click();
  await approvalSwitch.click();
  await expect(approvalSwitch).toHaveAttribute("aria-checked", "false");
  await expect(stateLabel).toHaveText(AUTONOMY_WORDS.putsInItself);
  await expect.poll(storedAutonomy).toBe(true);
  // Capture the fully settled off state, not the knob in motion.
  await approvalSwitch.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: testInfo.outputPath("dark-settings-projects-puts-in-itself.png"),
  });
  await row.screenshot({ path: testInfo.outputPath("expanded-merges-on-its-own.png") });

  // Going back to the list and reopening keep the stored permission and switch state.
  await page.locator("[data-project-back]").click();
  await expect(projectRowWords(page, alpha.id)).toHaveText([
    PROJECT_ROW_WORDS.linked,
    PROJECT_ROW_WORDS.mergesOnItsOwn,
  ]);
  await expect.poll(storedAutonomy).toBe(true);
  await line.screenshot({ path: testInfo.outputPath("collapsed-merges-on-its-own.png") });
  await header.click();
  await expect(approvalSwitch).toHaveAttribute("aria-checked", "false");
  await expect(stateLabel).toHaveText(AUTONOMY_WORDS.putsInItself);
  await approvalSwitch.click();
  await expect(approvalSwitch).toHaveAttribute("aria-checked", "true");
  await expect(stateLabel).toHaveText(AUTONOMY_WORDS.asksFirst);
  await expect.poll(storedAutonomy).toBe(false);
  await approvalSwitch.click();
  await expect(approvalSwitch).toHaveAttribute("aria-checked", "false");
  await expect(stateLabel).toHaveText(AUTONOMY_WORDS.putsInItself);
  await page.getByRole("radio", { name: RIGOR_WORDS.reviewed }).click();
  await expect(page.getByRole("radio", { name: RIGOR_WORDS.reviewed })).toBeChecked();
  await expect
    .poll(
      async () => {
        const repos = await page.evaluate(() => window.infinitary.repos.list());
        return repos.find((repo) => repo.name === alphaName);
      },
      { timeout: 10_000 },
    )
    .toMatchObject({ delivery: "direct-pr", autonomy: true, rigor: "reviewed" });
  // Escape goes back to the list, then closes Settings.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

// INF-1117 approved direction A: keyboard edits persist and reach the next
// model context without repetition. Uses only the launcher's private HOME,
// two local projects and mock model; completion is saved data and request content.
test("Scope is saved by keys and shown once in the first mate's next context", async () => {
  const { page, mockProvider, userDataDir } = launched;
  const alpha = (await addedProjects(page)).find((repo) => repo.path === repoAlpha);
  if (!alpha || !mockProvider) throw new Error("The isolated scope fixture must be ready");
  const scope = "Tools and dashboards for our astronomy club.";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  const header = projectLine(page, alpha.id).getByRole("button");
  // Settings loads projects asynchronously; counting before the line arrives
  // used to skip opening it and tried to focus an absent details field.
  await expect(header).toBeVisible();
  await pressKey(header, "Enter");
  const row = projectSettings(page, alpha.id);
  await expect(row).toBeVisible();
  // Scope opens the repository's Details; the project's Name sits in its own
  // box above, so the test reaches Scope directly.
  const field = row.getByRole("textbox", { name: "Scope", exact: true });
  await focusOn(field);
  await expect(field).toBeFocused();
  await field.fill(scope);
  const save = row.getByRole("button", { name: "Save details", exact: true });
  await pressKey(save, "Enter");
  await expect
    .poll(() =>
      readSavedData(userDataDir, (db) =>
        db.prepare("SELECT scope FROM repos WHERE id = ?").get(alpha.id),
      ),
    )
    .toEqual({ scope });
  // Escape goes back to the list, then closes Settings.
  await pressKey(field, "Escape");
  await page.keyboard.press("Escape");
  // The project the repository belongs to, by its key, as the record keeps it:
  // the context names it beside the scope (INF-4220).
  const record = readSavedData(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT projects.key AS project FROM repos JOIN projects ON projects.id = repos.project_id WHERE repos.id = ?",
        )
        .get(alpha.id) as { project: string } | undefined,
  );
  if (!record) throw new Error("The scope fixture's repository must name its project");
  const { project } = record;
  const contexts = () =>
    mockProvider
      .requestBodies()
      .slice(before)
      .map(
        (body) =>
          latestContext(body) as ReturnType<typeof latestContext> & { project_scopes?: unknown },
      )
      .filter(Boolean);
  let before = mockProvider.requestBodies().length;
  const input = promptInput(page);
  await input.fill("What work belongs in the astronomy project?");
  await pressKey(input, "Enter");
  await expect.poll(contexts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        project_scopes: expect.objectContaining({
          projects: expect.arrayContaining([
            { repo_id: alpha.id, name: alpha.name, project, scope },
          ]),
        }),
      }),
    ]),
  );
  await waitForFirstmateIdle(page);
  before = mockProvider.requestBodies().length;
  await input.fill("Thank you. What is next?");
  await pressKey(input, "Enter");
  await expect.poll(() => contexts().length).toBeGreaterThan(0);
  // Sent once: the next input carries no scopes of its own.
  const served = mockProvider
    .requestBodies()
    .slice(before)
    .map((body) => servedContext(body))
    .filter(Boolean);
  expect(served.every((context) => context?.project_scopes === undefined)).toBe(true);
  await waitForFirstmateIdle(page);
});

test("an agent-made removal shows up live in the settings list", async () => {
  const { page } = launched;
  const alphaName = repoAlpha.split("/").at(-1) as string;

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  await expect(page.getByText(repoAlpha)).toBeVisible();

  // The user asks in conversation (the same bridge the voice input uses);
  // the agent's app_change project-remove removes the row and the open settings list
  // follows without a reload.
  await page.evaluate(
    (text) => window.infinitary.conversation.send(text),
    `${UNREGISTER_REPO_PROMPT_MARKER}${alphaName}`,
  );
  await expect(page.getByText(repoAlpha)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(repoBeta)).toBeVisible();
  await page.keyboard.press("Escape");
});
