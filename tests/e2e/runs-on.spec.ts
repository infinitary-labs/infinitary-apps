import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { type HelperRun, startHelper } from "../../src/core/helper/run";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import { HERE } from "../../src/shared/deviceNames";
import { runsHereOnly, runsOnLine } from "../../src/shared/repos";
import { signInPlace } from "../../src/shared/signIns";
import { RUNS_ON_SOURCE_WORDS } from "../../src/shared/taskPolicies";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import {
  expandDock,
  feedLine,
  nowFrame,
  nowRow,
  recordCard,
  recordFact,
  recordFrame,
} from "./rails";
import { pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * A project's Runs on (docs/helper.md, "Runs on"; design skill
 * `components/devices/RunsOn`): with a computer that runs work on the list,
 * Settings -> Projects offers where each project's tasks run, its collapsed
 * row says where, the feed says what changed, and asking Firstmate sets the
 * same row. A project kept on this Mac only runs here.
 *
 * The home is the built app in development, where the multi-machine gate is
 * open; the computer is the helper as the work mode composes it, in this
 * test's own process, joined as another macOS user on this Mac.
 */

const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };
/** How the home's words place the computer: another user on this Mac. */
const PLACE = signInPlace({ name: "Mac mini", user: BUILDER.name, onThisMac: true });

const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
});

/** A project where it lives, a bare repository on this disk, and the home's clone of it. */
function projectWithOrigin(): string {
  const root = scratchDir("infinitary-e2e-runs-on-");
  const origin = join(root, "origin.git");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  git(website, ["add", "-A"]);
  git(website, ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  return website;
}

async function homeAndComputer(): Promise<{ app: LaunchedApp; page: Page; deviceId: string }> {
  process.env.PI_OFFLINE = "1";
  const app = await launchApp({ withMockProvider: true });
  apps.push(app);
  const { page } = app;
  const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const dataDir = scratchDir("infinitary-e2e-computer-");
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  return { app, page, deviceId: joined.grant.deviceId };
}

/** These journeys exercise explicit choices, independently of the default mode. */
async function projectOnThisComputer(page: Page, path = projectWithOrigin()) {
  return page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({
      kind: "adopt",
      path,
      name: "Fixture setup",
    });
    await window.infinitary.devices.runsOn(result.repo.id, null);
    // Setup's feed line cannot stand in for the later in-journey change.
    const repo = await window.infinitary.repos.configure(result.repo.id, { name: "website" });
    return { ...result, repo };
  }, path);
}

/** The captain's words, answered by a Firstmate turn that makes `calls`; the tools' results. */
async function ask(app: LaunchedApp, words: string, calls: ScriptedCall[]): Promise<string[]> {
  if (!app.mockProvider) throw new Error("Asking Firstmate needs the mock provider");
  await waitForFirstmateIdle(app.page);
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(app.page);
  await pressWindowKey(app.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+A");
  await typeInto(input, words);
  await input.press("Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome().results;
}

/** A filed task in a project, by asking Firstmate; its key and id. */
async function fileTask(app: LaunchedApp, title: string, repoId: string) {
  const [planned] = await ask(app, `File ${title}.`, [
    {
      name: "create_task",
      args: { title, goal: `${title}, done.`, user_words: `file ${title}`, repo_id: repoId },
    },
  ]);
  const [, key, id] = /Planned (\S+) .*\(task_id ([^)]+)\)/.exec(planned ?? "") ?? [];
  if (!key || !id) throw new Error(`No task was filed: ${planned}`);
  return { key, id };
}

/** Moves the keyboard to `target` with Tab, as a person would. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === el.ownerDocument.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("a project runs on a computer chosen in Settings or by asking, and one kept on this Mac runs here", async () => {
  const { page, deviceId } = await homeAndComputer();
  const website = projectWithOrigin();
  const { repo } = await projectOnThisComputer(page, website);
  await page.evaluate(() => window.infinitary.repos.setup({ kind: "init", name: "notes" }));

  await test.step("Settings -> Projects: choose the computer, and the row and the feed say so", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const row = page.locator(`[data-project="${repo.id}"]`);
    await row.getByRole("button", { name: /^website, / }).click();
    const runsOn = row.getByRole("combobox", { name: "Runs on" });
    await expect(runsOn).toHaveValue("");
    await runsOn.selectOption(deviceId);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.repos.list())).find(
            (entry) => entry.name === "website",
          )?.runsOn,
      )
      .toBe(deviceId);
    // Collapsed, the row says where its tasks run.
    await row.getByRole("button", { name: /^website, / }).click();
    await expect(row.getByText(`runs ${PLACE.where}`, { exact: true })).toBeVisible();

    // A project kept on this Mac only has nothing to choose.
    const notes = page.locator("[data-project]").filter({ hasText: "notes" });
    await notes.getByRole("button", { name: /^notes, / }).click();
    await expect(notes.getByRole("combobox", { name: "Runs on" })).toHaveCount(0);
    await expect(
      notes.getByText(runsHereOnly({ kind: "project", origin: null }) ?? ""),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(feedLine(page, runsOnLine("website", PLACE.where, true))).toBeVisible();
  });

  await test.step("asking Firstmate sets the same row back to this Mac", async () => {
    const input = promptInput(page);
    await input.fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "project-runs-on", value: { repoId: repo.id, deviceId: null } }),
    );
    await input.press("Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.repos.list())).find(
            (entry) => entry.name === "website",
          )?.runsOn,
      )
      .toBeNull();
    await expect(feedLine(page, runsOnLine("website", null, false))).toBeVisible();
  });
});

test("asking Firstmate sets where one filed task runs, its record says so, and its project moving leaves it", async () => {
  const { app, page, deviceId } = await homeAndComputer();
  const { repo } = await projectOnThisComputer(page);
  const { repo: notes } = await page.evaluate(() =>
    window.infinitary.repos.setup({ kind: "init", name: "notes" }),
  );
  const footer = await fileTask(app, "Fix the footer", repo.id);
  const tidy = await fileTask(app, "Tidy the notes", notes.id);
  const detail = (id: string) => page.evaluate((task) => window.infinitary.tasks.detail(task), id);

  await test.step("the record's Details says where it runs, from its project", async () => {
    await expect
      .poll(async () => (await detail(footer.id)).runsOn)
      .toEqual({ label: HERE.This, source: "project" });
    // A project kept on this Mac only has no other place to say.
    expect((await detail(tidy.id)).runsOn).toBeUndefined();
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressKey(nowRow(page, footer.key), "Enter");
    await expect(recordCard(page)).toBeVisible();
    await runFromSearch(app.app, page, "focus.card-body");
    await tabTo(page, recordFrame(page).locator('[data-record-section="details"] > summary'));
    await page.keyboard.press("Enter");
    await expect(recordFact(page, "runs-on")).toContainText(RUNS_ON_SOURCE_WORDS.project);
  });

  await test.step("asked, Firstmate sets the task's own Runs on, and the record says so", async () => {
    const [moved] = await ask(app, `Run ${footer.key} on the mini.`, [
      { name: "update_task", args: { task: footer.key, runs_on: deviceId } },
    ]);
    expect(moved).toContain(footer.key);
    await expect
      .poll(async () => (await detail(footer.id)).runsOn)
      .toEqual({ label: PLACE.label, source: "task" });
    expect((await detail(footer.id)).status).toBe("open");
    await expect(recordFact(page, "runs-on")).toContainText(RUNS_ON_SOURCE_WORDS.task);
  });

  await test.step("the project moves there and back, and the task stays where the captain put it", async () => {
    for (const where of [deviceId, null])
      await page.evaluate(({ id, at }) => window.infinitary.devices.runsOn(id, at), {
        id: repo.id,
        at: where,
      });
    expect((await detail(footer.id)).runsOn).toEqual({
      label: PLACE.label,
      source: "task",
    });
  });

  await test.step("a task of a project kept on this Mac is refused in plain words, and changes nothing", async () => {
    const [refused] = await ask(app, `Run ${tidy.key} on the mini.`, [
      { name: "update_task", args: { task: tidy.key, runs_on: deviceId } },
    ]);
    expect(refused).toContain(runsHereOnly({ kind: "project", origin: null }) ?? "");
    expect((await detail(tidy.id)).runsOn).toBeUndefined();
  });

  await test.step("a task with no project runs where the captain asks, and back here when he says project", async () => {
    const [planned] = await ask(app, "File finding the full disk.", [
      {
        name: "create_task",
        args: {
          title: "Find the full disk",
          goal: "Find out why the disk is full.",
          user_words: "on the mini, find out why its disk is full",
        },
      },
    ]);
    const [, , id] = /Planned (\S+) .*\(task_id ([^)]+)\)/.exec(planned ?? "") ?? [];
    if (!id) throw new Error(`No task was filed: ${planned}`);
    expect((await detail(id)).runsOn).toBeUndefined();
    await ask(app, "Run the full disk task on the mini.", [
      { name: "update_task", args: { task: id, runs_on: deviceId } },
    ]);
    await expect
      .poll(async () => (await detail(id)).runsOn)
      .toEqual({ label: PLACE.label, source: "task" });
    await ask(app, "Run the full disk task here again.", [
      { name: "update_task", args: { task: id, runs_on: "project" } },
    ]);
    await expect.poll(async () => (await detail(id)).runsOn).toBeUndefined();
  });

  await test.step("project follows the project's Runs on again", async () => {
    await ask(app, `Let ${footer.key} run where its project runs.`, [
      { name: "update_task", args: { task: footer.key, runs_on: "project" } },
    ]);
    await expect
      .poll(async () => (await detail(footer.id)).runsOn)
      .toEqual({ label: HERE.This, source: "project" });
    await expect(recordFact(page, "runs-on")).toContainText(RUNS_ON_SOURCE_WORDS.project);
  });
});
