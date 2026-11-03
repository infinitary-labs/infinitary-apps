import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import { HERE } from "../../src/shared/deviceNames";
import { computerMoveLine, MOVE_LABELS, moveOutOfReach } from "../../src/shared/recordBar";
import { RUNS_ON_THIS_MAC } from "../../src/shared/repos";
import type { TaskView } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_PROVIDER_ID, mockModelsJson } from "./mockProvider";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { seedQuotaFixture } from "./quotaFixtures";
import { expandDock, nowRow, recordBar, recordCard } from "./rails";
import { HELD_MOVE_TURN_MARKER, heldMoveTurn } from "./scenarios/heldMoveTurn";
import { starterFor } from "./starters";
import { pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * Moving a started task to another computer (INF-1713; docs/helper.md,
 * "Moving a started task"): the captain's "moving a task from one machine
 * to another". From its record, by keys, a task started here moves to a
 * computer that runs work once its crewmate's turn is over, keeps its key,
 * branch and files, and its working copy here is removed.
 *
 * The home is the built app; the computer is the helper as the work mode
 * composes it, in this test's own process, joined as another macOS user on
 * this Mac, signed in to the same stand-in model the home's crew runs on.
 */

const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };
const MINI = "Mac mini";
const GROK = starterFor("xai", "medium");

const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
});

/** A project where it lives, a bare repository on this disk, and the home's clone of it. */
function projectWithOrigin(): string {
  const root = scratchDir("infinitary-e2e-task-move-");
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

/**
 * A Grok key, the crew's one account (`automatic-placement.spec.ts` seeds
 * the same): its model answers at the stand-in. `dir` is an app's data
 * folder, the home's or the computer's.
 */
function seedGrokKey(dir: string): void {
  const account = join(dir, "accounts", "xai", "acct_crew");
  mkdirSync(account, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(account, "auth.json"),
    JSON.stringify({ xai: { type: "api_key", key: "disposable-key" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct_crew",
          providerId: "xai",
          kind: "api_key",
          label: "Crew",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
}

/** The stand-in's models, with Grok's crew model answering there too. */
function grokModels(port: number): string {
  const config = JSON.parse(mockModelsJson(port));
  config.providers.xai = {
    ...config.providers[MOCK_PROVIDER_ID],
    models: [{ id: GROK, name: "Mock Grok", input: ["text", "image"] }],
  };
  return JSON.stringify(config);
}

async function homeAndComputer() {
  process.env.PI_OFFLINE = "1";
  const userDataDir = scratchDir("infinitary-e2e-task-move-home-");
  seedGrokKey(userDataDir);
  const quota = join(userDataDir, "quota");

  const generatedAt = new Date().toISOString();
  seedQuotaFixture(
    quota,
    { generatedAt, providers: [] },
    {
      generatedAt,
      models: [{ provider: "grok", id: GROK, label: "Mock Grok", effectivePercentRemaining: 80 }],
    },
  );

  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [heldMoveTurn],
    modelsJson: grokModels,
    env: { INFINITARY_QUOTA_FIXTURE_DIR: quota },
  });
  apps.push(app);
  const { page } = app;
  const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const dataDir = scratchDir("infinitary-e2e-computer-");
  // The computer is signed in to the same Grok key, its model answering at the stand-in.
  const port = app.mockProvider?.port;
  if (!port) throw new Error("The stand-in provider did not start.");
  seedGrokKey(dataDir);
  mkdirSync(join(dataDir, "pi-base"), { recursive: true });
  writeFileSync(join(dataDir, "pi-base", "models.json"), grokModels(port));
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: MINI, user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  return { app, page, deviceId: joined.grant.deviceId, dataDir };
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

/** The started task with `title`, from the board. */
async function started(page: Page, title: string): Promise<{ key: string; id: string }> {
  const { tasks } = await page.evaluate(() => window.infinitary.tasks.board());
  const task = tasks.find((each) => each.title === title);
  if (!task) throw new Error(`No task "${title}" was started`);
  return { key: task.key, id: task.id };
}

const view = (page: Page, id: string): Promise<TaskView | undefined> =>
  page.evaluate(
    (taskId) =>
      window.infinitary.tasks
        .board()
        .then((board) => board.tasks.find((task) => task.id === taskId)),
    id,
  );

test("a started task moves to another computer and back from its record, by keys, with its branch and files", async () => {
  test.setTimeout(240_000);
  const { app, page, deviceId, dataDir } = await homeAndComputer();
  const { repo } = await page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({ kind: "adopt", path, name: "website" });
    // Its tasks start here, so the move is the only thing that takes one there.
    await window.infinitary.devices.runsOn(result.repo.id, null);
    return result;
  }, projectWithOrigin());

  // e2e-typed-words: the captain asks for a task in the project
  await ask(app, "Fix the footer in website.", [
    {
      name: "spawn_crewmate",
      args: {
        title: "Fix the footer",
        goal: "The footer is fixed.",
        user_words: "Fix the footer in website.",
        repo_id: repo.id,
        shape: { skipped_plan_because: "A one-line fix" },
      },
    },
  ]);
  const { key, id } = await started(page, "Fix the footer");
  const here = join(app.userDataDir, "worktrees", id);
  const there = join(dataDir, "worktrees", id);

  await test.step("its crewmate's turn ends here, and it leaves work git does not hold yet", async () => {
    await expect
      .poll(async () => (await view(page, id))?.activity, { timeout: 60_000 })
      .toBe("idle");
    expect((await view(page, id))?.executionDeviceId ?? null).toBeNull();
    writeFileSync(join(here, "notes.md"), "the footer's colours\n");
    writeFileSync(join(here, "README.md"), "# website\n\nFooter.\n");
    await expect.poll(async () => (await view(page, id))?.movable).toBe(true);
  });

  await test.step("from its record, by keys: Move to a computer, the Mac mini, Move", async () => {
    await expandDock(page, "now");
    await pressKey(nowRow(page, key), "Enter");
    await expect(recordCard(page)).toBeVisible();
    await expect(page.locator("[data-record-move-open]")).toHaveAccessibleName(MOVE_LABELS.open);
    await runFromSearch(app.app, page, "task.move-computer");
    await expect(recordBar(page)).toHaveAttribute("data-record-footer", "move");
    const mini = page.locator(`[data-record-move-to="${deviceId}"]`);
    await expect(mini).toBeFocused();
    await expect(mini).toContainText(MINI);
    await pressKey(mini, "Space");
    await expect(mini).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Tab");
    const move = page.locator("[data-record-move-confirm]");
    await expect(move).toBeFocused();
    await expect(move).toHaveAccessibleName(MOVE_LABELS.move);
    await page.keyboard.press("Enter");
  });

  await test.step("it runs on the Mac mini, with its branch and the work it left, and nothing here", async () => {
    await expect
      .poll(async () => (await view(page, id))?.executionDeviceId, { timeout: 60_000 })
      .toBe(deviceId);
    await expect
      .poll(async () => (await view(page, id))?.computerMove, { timeout: 30_000 })
      .toBeUndefined();
    const task = await view(page, id);
    expect(task).toMatchObject({ key, status: "active" });
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: there }).toString().trim(),
    ).toBe(`fm/task-${id}`);
    expect(readFileSync(join(there, "notes.md"), "utf8")).toBe("the footer's colours\n");
    expect(readFileSync(join(there, "README.md"), "utf8")).toBe("# website\n\nFooter.\n");
    await expect.poll(() => existsSync(here), { timeout: 30_000 }).toBe(false);
    // Its record's Activity says who moved it, from where to where.
    const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    expect(detail.events.map((event) => event.text)).toContain(
      `the captain moved it from ${HERE.this} to ${MINI}; it keeps its key, branch, working copy and files`,
    );
  });

  // The plan's return move: a computer the task ran on before takes it back
  // from nothing it left, never from its old copy or closed conversation.
  await test.step("by keys again, it moves back here, and nothing is left on the Mac mini", async () => {
    await expect
      .poll(async () => (await view(page, id))?.activity, { timeout: 60_000 })
      .toBe("idle");
    await expect.poll(async () => (await view(page, id))?.movable).toBe(true);
    await expect(recordCard(page)).toBeVisible();
    await runFromSearch(app.app, page, "task.move-computer");
    const home = page.locator(`[data-record-move-to="${RUNS_ON_THIS_MAC}"]`);
    await expect(home).toBeFocused();
    await pressKey(home, "Space");
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-record-move-confirm]")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await view(page, id))?.executionDeviceId ?? null, { timeout: 60_000 })
      .toBeNull();
    await expect
      .poll(async () => (await view(page, id))?.computerMove, { timeout: 30_000 })
      .toBeUndefined();
    expect(await view(page, id)).toMatchObject({ key, status: "active" });
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: here }).toString().trim(),
    ).toBe(`fm/task-${id}`);
    expect(readFileSync(join(here, "notes.md"), "utf8")).toBe("the footer's colours\n");
    expect(readFileSync(join(here, "README.md"), "utf8")).toBe("# website\n\nFooter.\n");
    await expect.poll(() => existsSync(there), { timeout: 30_000 }).toBe(false);
    const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    expect(detail.events.map((event) => event.text)).toContain(
      `the captain moved it from ${MINI} to ${HERE.this}; it keeps its key, branch, working copy and files`,
    );
  });
});

test("a move waits for the crewmate's turn, the record says what it waits for, and Cancel move keeps the task here", async () => {
  test.setTimeout(240_000);
  const { app, page, deviceId } = await homeAndComputer();
  const { repo } = await page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({ kind: "adopt", path, name: "website" });
    await window.infinitary.devices.runsOn(result.repo.id, null);
    return result;
  }, projectWithOrigin());
  const mock = app.mockProvider;
  if (!mock) throw new Error("The stand-in provider did not start.");
  // The crewmate's first step is held open, so its turn is mid-way.
  const words = `Fix the header in website ${HELD_MOVE_TURN_MARKER}.`;
  await ask(app, words, [
    {
      name: "spawn_crewmate",
      args: {
        title: "Fix the header",
        goal: `The header is fixed ${HELD_MOVE_TURN_MARKER}.`,
        user_words: words,
        repo_id: repo.id,
        shape: { skipped_plan_because: "A one-line fix" },
      },
    },
  ]);
  const { key, id } = await started(page, "Fix the header");
  await expect.poll(() => mock.heldRequests(), { timeout: 60_000 }).toBe(1);

  await expandDock(page, "now");
  await pressKey(nowRow(page, key), "Enter");
  await expect(recordCard(page)).toBeVisible();
  await runFromSearch(app.app, page, "task.move-computer");
  const mini = page.locator(`[data-record-move-to="${deviceId}"]`);
  await expect(mini).toBeFocused();
  await pressKey(mini, "Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");

  const line = page.locator("[data-record-move]");
  await expect(line).toHaveAttribute("data-record-move", "waiting");
  await expect(line).toHaveText(
    computerMoveLine({
      from: HERE.this,
      to: MINI,
      state: "waiting",
      waitingFor: ["its crewmate's current turn ends"],
    }),
  );
  const cancel = page.locator("[data-record-move-cancel]");
  await expect(cancel).toHaveAccessibleName(MOVE_LABELS.cancelMove);
  await pressKey(cancel, "Enter");
  await expect.poll(async () => (await view(page, id))?.computerMove).toBeUndefined();
  await expect(line).toHaveCount(0);
  // The turn carries on here, and the task never left.
  mock.releaseHeldCrew();
  await expect.poll(async () => (await view(page, id))?.activity, { timeout: 60_000 }).toBe("idle");
  expect((await view(page, id))?.executionDeviceId ?? null).toBeNull();
  expect(existsSync(join(app.userDataDir, "worktrees", id))).toBe(true);
});

test("a computer out of reach cannot take a task: the picker says why, and the task stays here with its work", async () => {
  test.setTimeout(240_000);
  const { app, page, deviceId } = await homeAndComputer();
  const { repo } = await page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({ kind: "adopt", path, name: "website" });
    await window.infinitary.devices.runsOn(result.repo.id, null);
    return result;
  }, projectWithOrigin());
  // e2e-typed-words: the captain asks for a task in the project
  await ask(app, "Fix the sidebar in website.", [
    {
      name: "spawn_crewmate",
      args: {
        title: "Fix the sidebar",
        goal: "The sidebar is fixed.",
        user_words: "Fix the sidebar in website.",
        repo_id: repo.id,
        shape: { skipped_plan_because: "A one-line fix" },
      },
    },
  ]);
  const { key, id } = await started(page, "Fix the sidebar");
  const here = join(app.userDataDir, "worktrees", id);
  await expect.poll(async () => (await view(page, id))?.activity, { timeout: 60_000 }).toBe("idle");
  writeFileSync(join(here, "notes.md"), "the sidebar's width\n");

  // The Mac mini's app stops, so it is out of reach.
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  const outOfReach = moveOutOfReach(MINI);
  await expect
    .poll(
      async () => {
        const options = await page.evaluate(
          (taskId) => window.infinitary.task.moveOptions(taskId),
          id,
        );
        return options.ok ? options.destinations.find((each) => each.id === deviceId) : options;
      },
      { timeout: 60_000 },
    )
    .toMatchObject({ unavailable: outOfReach });

  await expandDock(page, "now");
  await pressKey(nowRow(page, key), "Enter");
  await expect(recordCard(page)).toBeVisible();
  await runFromSearch(app.app, page, "task.move-computer");
  const mini = page.locator(`[data-record-move-to="${deviceId}"]`);
  await expect(mini).toHaveAttribute("aria-disabled", "true");
  await expect(mini).toHaveAttribute("aria-description", outOfReach);
  await expect(page.locator("[data-record-move-confirm]")).toBeDisabled();

  // Asked of the first mate, the move is refused with the same reason.
  // e2e-typed-words: the captain asks for the move anyway
  const [refused] = await ask(app, `Move ${key} to the Mac mini.`, [
    { name: "move_task", args: { task_id: key, computer: deviceId } },
  ]);
  expect(refused).toContain(outOfReach);
  expect((await view(page, id))?.computerMove).toBeUndefined();
  expect((await view(page, id))?.executionDeviceId ?? null).toBeNull();
  expect(readFileSync(join(here, "notes.md"), "utf8")).toBe("the sidebar's width\n");
});

// Review INF-1772 R11, the captain: "Add the missing tests". A move that fails
// once its work reached the computer: the Mac mini's folder for the task's
// evidence is a link to somewhere else there, so it refuses to unpack after it
// made the working copy; what it made there is removed, and the task stays here.
test("a move that fails after its work reached the computer removes what it made there, and the task stays here with its work", async () => {
  test.setTimeout(240_000);
  const { app, page, deviceId, dataDir } = await homeAndComputer();
  const { repo } = await page.evaluate(async (path) => {
    const result = await window.infinitary.repos.setup({ kind: "adopt", path, name: "website" });
    await window.infinitary.devices.runsOn(result.repo.id, null);
    return result;
  }, projectWithOrigin());
  // e2e-typed-words: the captain asks for a task in the project
  await ask(app, "Fix the banner in website.", [
    {
      name: "spawn_crewmate",
      args: {
        title: "Fix the banner",
        goal: "The banner is fixed.",
        user_words: "Fix the banner in website.",
        repo_id: repo.id,
        shape: { skipped_plan_because: "A one-line fix" },
      },
    },
  ]);
  const { key, id } = await started(page, "Fix the banner");
  const here = join(app.userDataDir, "worktrees", id);
  const there = join(dataDir, "worktrees", id);
  await expect.poll(async () => (await view(page, id))?.activity, { timeout: 60_000 }).toBe("idle");
  writeFileSync(join(here, "notes.md"), "the banner's height\n");
  await expect.poll(async () => (await view(page, id))?.movable).toBe(true);
  const elsewhere = scratchDir("infinitary-e2e-task-move-elsewhere-");
  mkdirSync(join(dataDir, "tasks", id), { recursive: true });
  symlinkSync(elsewhere, join(dataDir, "tasks", id, "evidence"));

  // e2e-typed-words: the captain asks for the move
  const [moving] = await ask(app, `Move ${key} to the Mac mini.`, [
    { name: "move_task", args: { task_id: key, computer: deviceId } },
  ]);
  expect(moving).toContain(MINI);
  await expect
    .poll(
      async () => {
        const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
        return detail.events.some((event) =>
          event.text.startsWith(`its move to ${MINI} did not finish:`),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await view(page, id))?.computerMove, { timeout: 30_000 })
    .toBeUndefined();
  expect((await view(page, id))?.executionDeviceId ?? null).toBeNull();
  await expect.poll(() => existsSync(there), { timeout: 30_000 }).toBe(false);
  expect(readdirSync(elsewhere)).toEqual([]);
  expect(readFileSync(join(here, "notes.md"), "utf8")).toBe("the banner's height\n");
});
