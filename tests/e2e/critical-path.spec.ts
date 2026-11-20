import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { WELCOME_TITLE } from "@shared/welcome";
import { GATE_HOME_TITLE } from "../../src/renderer/src/app/firstRunGateWords";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { gitIdentityHome } from "./homeFixtures";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { mockProviderOverrideModelsJson } from "./mockModels";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { windowShot } from "./pictures";
import { projectSettings, taskWorktrees } from "./projects";
import { promptInput } from "./prompt";
import { putInLine, startedLine, taskKey } from "./rails";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  DESTINATION_STORY_MARKER,
  DESTINATION_STORY_TITLE,
  destinationStory,
} from "./scenarios/destinationStory";
import { expectNoCard, factsStrip, noteDone, shownCard, stageAtRest } from "./stack";

/**
 * The critical path (INF-2480, captain: "path six-steps (launch, sign in,
 * project, first mate, crewmate card, merge)"; INF-2507): the one journey
 * every pull request runs. It walks a fresh install from the gate to a
 * merged change in the real app, with only a person's own actions: a key
 * pasted through the gate's own chip, a project started in Settings, a
 * message to the first mate, and a click on the crewmate's merge button.
 *
 * Each section takes the strongest case of the journeys it stands for: the
 * gate (first-launch), a key signed in through the gate's own chip
 * (first-launch), a project started in Settings (add-project), a message
 * that starts a crewmate (phase1-shell, task-crewmate), its saved-story card
 * (story-destinations) and the merge click (settle-effects). Their other
 * cases stay where they are.
 *
 * Its data is a fresh profile and HOME, a git identity in that HOME as a
 * person's own computer has, the mock provider behind the key the gate
 * signs in, and the saved-story scenario its crewmate follows
 * (`tests/e2e/scenarios/destinationStory.ts`). It shares no sign-in,
 * keychain, account or folder with another journey. Its completion signal
 * is the project's own main branch holding the crewmate's commit, read
 * from git, with the task closed as landed.
 */

const PROJECT = "meterlab";
/**
 * Grok, signed in with a pasted key: its starter model is one routing
 * picks. OpenRouter's key, the gate's other no-browser sign-in, has a
 * journey of its own (`openrouter-crew.spec.ts`, INF-2523).
 */
const KEY_PROVIDER = "xai";
const why = MOCK_GITHUB_STORY.why[0];
if (!why) throw new Error("The story fixture needs its reason.");

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
    .toString()
    .trim();

/** Where each section stood, kept with the run's results. */
const picture = (name: string) => test.info().outputPath(`${name}.png`);

test("a fresh install signs in, adds a project, asks the first mate and merges its crewmate's change", async () => {
  test.setTimeout(3 * 60_000);
  const launched = await launchApp({
    withMockProvider: true,
    // The base runtime serves no model, so the gate shows; the key the gate
    // signs in reads the same file and sends every turn to the stand-in.
    modelsJson: (port) => mockProviderOverrideModelsJson(port, KEY_PROVIDER),
    scenarios: [destinationStory(true)],
    prepareHome: gitIdentityHome("Critical Path", "critical-path@localhost"),
    env: { INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")) },
  });
  try {
    const { app, page, mockProvider } = launched;
    if (!mockProvider) throw new Error("The journey needs its stand-in provider.");
    await resizeWindow(app, page, { width: 1280, height: 1000 });
    const input = promptInput(page);
    const gate = page.locator("[data-first-run-gate]");

    await test.step("launch: a fresh install opens on the gate with the message box closed", async () => {
      await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
      await expect(gate.locator("[data-gate-title]")).toHaveText(GATE_HOME_TITLE);
      await expect(input).toBeDisabled();
      await windowShot(page, picture("1-launch"));
    });

    await test.step("sign in: a key pasted through the gate's own chip opens the message box", async () => {
      await gate.locator(`[data-connect-provider="${KEY_PROVIDER}"]`).click();
      await gate.locator("[data-connect-method]").getByRole("button", { name: "API key" }).click();
      const aside = gate.locator("[data-connect-aside]");
      await aside.locator("input[type='password']").fill("xai-critical-path");
      await aside.getByRole("button", { name: "Submit" }).click();
      await expect(input).toBeEnabled();
      const welcome = shownCard(page, WELCOME_TITLE);
      await expect(welcome).toBeVisible();
      // Signing in asks no model anything; the first turn is the person's.
      expect(mockProvider.requests()).toBe(0);
      await stageAtRest(page);
      await windowShot(page, picture("2-signed-in"));
      await noteDone(page, welcome).click();
      await expectNoCard(page, WELCOME_TITLE);
    });

    let projectDir = "";
    await test.step("project: a new project started in Settings is a git project on main", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Projects", exact: true }).click();
      const add = page.locator("[data-add-project]");
      await add.getByRole("button", { name: "New project", exact: true }).click();
      await add.getByLabel("Name", { exact: true }).fill(PROJECT);
      await add.getByRole("button", { name: "Start project" }).click();
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.infinitary.repos.list())).some(
            (repo) => repo.name === PROJECT,
          ),
        )
        .toBe(true);
      const repo = (await page.evaluate(() => window.infinitary.repos.list())).find(
        (row) => row.name === PROJECT,
      );
      if (!repo) throw new Error("The new project is not on the list.");
      expect(repo).toMatchObject({ kind: "project", delivery: "local-only", autonomy: false });
      projectDir = repo.path;
      await expect(projectSettings(page, repo.id)).toBeVisible();
      expect(git(projectDir, "branch", "--show-current")).toBe("main");
      await windowShot(page, picture("3-project"));
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(input).toBeVisible();
      // Adding a project wakes no model.
      expect(mockProvider.requests()).toBe(0);
    });

    const title = `${PROJECT} ${DESTINATION_STORY_MARKER}`;
    let taskId = "";
    await test.step("first mate: a message starts a crewmate on the project in its own working copy", async () => {
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      const key = await taskKey(page, title);
      await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
      const board = await page.evaluate(() => window.infinitary.tasks.board());
      const task = board.tasks.find((row) => row.key === key);
      if (!task) throw new Error("The started task is not on the board.");
      taskId = task.id;
      // The first mate put it in the project the person named.
      expect(board.projects.find((project) => project.id === task.projectId)?.name).toBe(PROJECT);
      await expect.poll(() => taskWorktrees(projectDir)).toHaveLength(1);
      await windowShot(page, picture("4-first-mate"));
    });

    const card = shownCard(page, DESTINATION_STORY_TITLE);
    const merge = card.getByRole("button", { name: MERGE_WORDS.land, exact: true });
    await test.step("crewmate card: the crewmate's change comes back as a card that offers the merge", async () => {
      await expect(card).toBeVisible({ timeout: 60_000 });
      const frame = cardBody(page, DESTINATION_STORY_TITLE);
      await expect(frame.locator("body")).toContainText(why);
      await expect(factsStrip(frame).project).toHaveText(PROJECT);
      await expect(merge).toBeVisible();
      // A shown card grants nothing: the project's main has only its first commit.
      expect(git(projectDir, "rev-list", "--count", "main")).toBe("1");
      await stageAtRest(page);
      await windowShot(page, picture("5-crewmate-card"));
    });

    await test.step("merge: the merge click puts the change on the project's main and closes the task", async () => {
      await merge.click();
      await expect
        .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
        .toMatchObject({ status: "done", closedReason: "landed" });
      expect(git(projectDir, "show", "main:meter.txt")).toBe("reads on time");
      expect(git(projectDir, "log", "-1", "--format=%s", "main")).toBe(DESTINATION_STORY_TITLE);
      await expect(putInLine(page, await taskKey(page, title))).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => taskWorktrees(projectDir)).toEqual([]);
      await expectNoCard(page, DESTINATION_STORY_TITLE);
      await windowShot(page, picture("6-merged"));
    });
  } finally {
    await launched.close();
  }
});
