import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  CARE_WORDS,
  PROJECT_DELIVERY_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { LAND_PROMPT_MARKER, MOCK_FM_CHAT_TEXT } from "./mockProvider";
import { addedProjects, addFromSetupCard, projectRow } from "./projects";
import { promptInput } from "./prompt";
import { putInLine, reportLine, startedLine, taskKey } from "./rails";
import { ADOPT_REPO_PROMPT_MARKER, projectSetup } from "./scenarios/projectSetup";
import {
  AMBIGUOUS_PROMPT_MARKER,
  CONFIGURE_REPO_PROMPT_MARKER,
  MOCK_WHICH_PROJECT_TITLE,
  UNREGISTER_REPO_PROMPT_MARKER,
  workspaceInference,
} from "./scenarios/workspaceInference";
import { cardMeta, shownCard } from "./stack";

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

  // Exactly one concise decision card, from Firstmate itself.
  await expect(shownCard(page, MOCK_WHICH_PROJECT_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(cardMeta(page, MOCK_WHICH_PROJECT_TITLE)).toHaveText(MOCK_WHICH_PROJECT_TITLE);

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
  const betaName = repoBeta.split("/").at(-1) as string;
  await test.step("a request naming repo B lands in repo B with no picker anywhere", async () => {
    await expect(page.getByRole("button", { name: /Task repository/ })).toHaveCount(0);

    const input = promptInput(page);
    await input.click();
    await input.fill(`commission a crewmate: bump the deps in ${betaName}`);
    await input.press("Enter");

    const key = await taskKey(page, `bump the deps in ${betaName}`);
    await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
    await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
    await waitForFirstmateIdle(page, 20_000);

    // The worktree landed on repo B; repo A stayed untouched.
    const betaTrees = execFileSync("git", ["-C", repoBeta, "worktree", "list"]).toString();
    expect(betaTrees.split("\n").filter((line) => line.includes("fm/task-"))).toHaveLength(1);
    const alphaTrees = execFileSync("git", ["-C", repoAlpha, "worktree", "list"]).toString();
    expect(alphaTrees.split("\n").filter((line) => line.includes("fm/task-"))).toHaveLength(0);
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
    await expect
      .poll(() =>
        execFileSync("git", ["-C", repoBeta, "worktree", "list"])
          .toString()
          .split("\n")
          .filter((line) => line.includes("fm/task-")),
      )
      .toHaveLength(0);
    await expect
      .poll(() => execFileSync("git", ["-C", repoBeta, "branch", "--list"]).toString())
      .not.toContain("fm/task-");
    await setBetaAutonomy(page, false);
  });
});

test("an agent-made posture change shows up live in the settings badges", async () => {
  const { page } = launched;
  const repos = await page.evaluate(() => window.infinitary.repos.list());
  const alpha = repos.find((repo) => repo.path === repoAlpha);
  const beta = repos.find((repo) => repo.path === repoBeta);
  if (!alpha || !beta) throw new Error("Both adopted projects must be registered");
  const alphaRow = projectRow(page, alpha.id);
  const betaRow = projectRow(page, beta.id);
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
  // Both adopted projects ask first. Other settings can offer autonomy as
  // an option, so read each project's own row and its stored flag.
  await expect.poll(storedAutonomy).toEqual({ alpha: false, beta: false });
  for (const row of [alphaRow, betaRow]) {
    await expect(row.getByRole("button", { expanded: false })).toBeVisible();
    await expect(row.getByText(AUTONOMY_WORDS.asksFirst, { exact: true })).toBeVisible();
    await expect(row.getByText(AUTONOMY_WORDS.putsInItself, { exact: true })).toHaveCount(0);
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
  await expect(betaRow.getByText(AUTONOMY_WORDS.putsInItself, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(betaRow.getByText(AUTONOMY_WORDS.asksFirst, { exact: true })).toHaveCount(0);
  await expect(alphaRow.getByText(AUTONOMY_WORDS.asksFirst, { exact: true })).toBeVisible();
  await expect(alphaRow.getByText(AUTONOMY_WORDS.putsInItself, { exact: true })).toHaveCount(0);
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

test("the captain can set project policy from the accordion in settings", async () => {
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
  const row = projectRow(page, alpha.id);
  const header = row.getByRole("button", { expanded: false });
  const testInfo = test.info();
  await expect(header).toBeVisible();
  await expect(header.getByText(AUTONOMY_WORDS.asksFirst, { exact: true })).toBeVisible();
  await row.screenshot({ path: testInfo.outputPath("collapsed-asks-first.png") });
  await header.click();
  await expect(row.getByRole("button", { expanded: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: CARE_WORDS.standard })).toBeChecked();
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

  // Collapsing and reopening keep the stored permission and switch state.
  await row.getByRole("button", { expanded: true }).click();
  await expect(header.getByText(AUTONOMY_WORDS.putsInItself, { exact: true })).toBeVisible();
  await expect.poll(storedAutonomy).toBe(true);
  await row.screenshot({ path: testInfo.outputPath("collapsed-merges-on-its-own.png") });
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
  await page.getByRole("radio", { name: CARE_WORDS.reviewed }).click();
  await expect(page.getByRole("radio", { name: CARE_WORDS.reviewed })).toBeChecked();
  await expect
    .poll(
      async () => {
        const repos = await page.evaluate(() => window.infinitary.repos.list());
        return repos.find((repo) => repo.name === alphaName);
      },
      { timeout: 10_000 },
    )
    .toMatchObject({ delivery: "direct-pr", autonomy: true, rigor: "reviewed" });
  await page.keyboard.press("Escape");
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
