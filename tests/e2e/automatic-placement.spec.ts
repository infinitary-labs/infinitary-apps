import { mkdirSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskStore } from "../../src/core/storage/taskStore";
import { HERE } from "../../src/shared/deviceNames";
import {
  AUTOMATIC_COMPUTER,
  PLACEMENT_DEMANDS,
  PLACEMENT_WAIT,
  placementWait,
} from "../../src/shared/placement";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { seedRepo } from "./githubStub";
import { type LaunchedApp, type LaunchOptions, launchApp, SHORT_TICK } from "./launch";
import { MOCK_PROVIDER_ID, mockModelsJson, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { holdCpuBusy, homeReading, replayedCpu } from "./placementCpu";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { providerMessages, served } from "./providerRequest";
import { reportLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./scenarios/gitStatus";
import { starterFor } from "./starters";
import { pressWindowKey, typeInto } from "./windowKeys";

/**
 * A new task in a project set to Automatic, the default for every project
 * that lives on a host (docs/helper.md, "Automatic starts"), starts on this
 * computer after a controlled busy-to-ready CPU transition (INF-1129,
 * captain-approved). The real sampler consumes captured CPU counters;
 * memory, including macOS page and pressure reads, and the program,
 * project-access and identity facts still come from this computer. A Mac in
 * ordinary use keeps almost no memory page empty, so counting only empty pages left
 * every such task waiting for a computer with room (FI3-1733); a virtual
 * machine, such as the hosted Linux runner, once read no identity and waited
 * the same way (FI3-1738). This journey runs that whole path on the
 * computer the suite runs on.
 */

const PROJECT = "ledger";

/**
 * The words a task waits with while the sampler reads too little spare
 * processing capacity for it, from their owner.
 */
const BUSY_WAIT = placementWait(
  [{ name: HERE.This, rejections: ["cpu-busy"], capacity: null }],
  PLACEMENT_DEMANDS.standard,
).words;

/** Keep both successful and failed CI runs' observed task and sampler states. */
async function recordCpuState(app: LaunchedApp, task: TaskDetail, phase: string): Promise<void> {
  const reading = await homeReading(app);
  await test.info().attach(`cpu-${phase}.json`, {
    body: JSON.stringify({ task, reading }, null, 2),
    contentType: "application/json",
  });
  console.info(
    "Automatic placement observation:",
    JSON.stringify({
      phase,
      task: task.key,
      status: task.status,
      startedAt: task.startedAt,
      wait: task.runsOn?.reason,
      reading,
    }),
  );
}

/** Wait for a compared task, rejecting waits unrelated to the CPU immediately. */
async function placementState(detail: () => Promise<TaskDetail>): Promise<string> {
  const task = await detail();
  if (task.startedAt !== null) return "started";
  const words = task.runsOn?.reason;
  return words ?? PLACEMENT_WAIT;
}

/**
 * The order, not a wall-clock busy allowance: observed CPU wait, release,
 * automatic start. No other work on the shared Mac can postpone the release.
 */
async function startsAfterCpuRelease(
  app: LaunchedApp,
  detail: () => Promise<TaskDetail>,
  release: () => Promise<void>,
): Promise<void> {
  let state = "";
  await expect
    .poll(
      async () => {
        state = await placementState(detail);
        return state;
      },
      { timeout: 90_000 },
    )
    .not.toBe(PLACEMENT_WAIT);
  expect(state).toBe(BUSY_WAIT);
  const waiting = await detail();
  expect(waiting).toMatchObject({ status: "open", startedAt: null, startPolicy: "when-ready" });
  expect(waiting.placement).toBeUndefined();
  await recordCpuState(app, waiting, "busy");

  await release();
  await expect
    .poll(
      async () => {
        state = await placementState(detail);
        return state === BUSY_WAIT || state === PLACEMENT_WAIT ? "waiting" : state;
      },
      { timeout: 90_000 },
    )
    .not.toBe("waiting");
  expect(state).toBe("started");
  await expect
    .poll(() => homeReading(app), { timeout: 90_000 })
    .toMatchObject({
      status: "fresh",
      observation: { cpu: replayedCpu("available"), memory: { totalBytes: totalmem() } },
    });
  await recordCpuState(app, await detail(), "available");
}

/**
 * The crew's model is a real routing choice, as a person's is: an isolated
 * Grok key whose catalog entry the router picks, served by the mock
 * provider (retrieval-routing.spec.ts seeds its lookup model the same way).
 */
function seedGrokCrew(userDataDir: string): Pick<LaunchOptions, "env" | "modelsJson"> {
  const model = starterFor("xai", "medium");
  const quota = join(userDataDir, "quota");
  mkdirSync(quota);
  const generatedAt = new Date().toISOString();
  writeFileSync(join(quota, "snapshot.json"), JSON.stringify({ generatedAt, providers: [] }));
  writeFileSync(
    join(quota, "models.json"),
    JSON.stringify({
      generatedAt,
      models: [{ provider: "grok", id: model, label: "Mock Grok", effectivePercentRemaining: 80 }],
    }),
  );
  const account = join(userDataDir, "accounts", "xai", "acct_crew");
  mkdirSync(account, { recursive: true });
  writeFileSync(
    join(account, "auth.json"),
    JSON.stringify({ xai: { type: "api_key", key: "disposable-key" } }),
  );
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
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
  return {
    env: { INFINITARY_QUOTA_FIXTURE_DIR: quota },
    modelsJson: (port) => {
      const config = JSON.parse(mockModelsJson(port));
      config.providers.xai = {
        ...config.providers[MOCK_PROVIDER_ID],
        models: [{ id: model, name: "Mock Grok", input: ["text", "image"] }],
      };
      return JSON.stringify(config);
    },
  };
}

/** A project that lives on a host, set to Automatic, as every such project is by default. */
function seedAutomaticProject(userDataDir: string): void {
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor, runs_on) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick', ?)",
  ).run(
    "repo-ledger",
    repoDir,
    PROJECT,
    Date.now(),
    `https://github.com/o/${PROJECT}.git`,
    AUTOMATIC_COMPUTER,
  );
  seedHostedOrigins(db, userDataDir);
  db.close();
}

/** Ask Firstmate for a task in the project, and read its key and id back from the board. */
async function askForTask(app: LaunchedApp): Promise<{ key: string; id: string | undefined }> {
  const title = `${GIT_STATUS_PROMPT_MARKER} in ${PROJECT}`;
  const input = promptInput(app.page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const key = await taskKey(app.page, title);
  const id = (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
    (task) => task.key === key,
  )?.id;
  return { key, id };
}

/** The crewmate ran in a working copy of its own branch. */
function ranOnItsBranch(app: LaunchedApp, key: string) {
  return reportLine(app.page, key).filter({
    hasText: new RegExp(`${MOCK_GIT_REPORT_PREFIX} git version \\S+ on ## fm/`),
  });
}

test("a new task in an Automatic project waits for CPU room, then starts with this computer's memory and identity", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-automatic-placement-");
  seedAutomaticProject(userDataDir);
  const crew = seedGrokCrew(userDataDir);
  const app = await launchApp({
    scenarios: [gitStatus],
    userDataDir,
    withMockProvider: true,
    ...crew,
    env: { ...crew.env, ...SHORT_TICK },
  });
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    const release = await holdCpuBusy(app);
    const asked = await askForTask(app);
    const { key } = asked;
    id = asked.id;

    await startsAfterCpuRelease(app, detail, release);
    // Automatic committed this computer (null names the home), not a wait.
    expect((await detail()).placement?.computerId).toBeNull();
    const here = (await detail()).placement?.candidates.find(
      (candidate) => candidate.computerId === null,
    );
    expect(here?.rejections).toEqual([]);
    // The sampler is real: only CPU counters are replayed; memory is this computer's own.
    expect(here?.reading).toMatchObject({
      status: "fresh",
      observation: { cpu: replayedCpu("available"), memory: { totalBytes: totalmem() } },
    });

    // And the crewmate ran here, in a working copy of its own branch.
    const report = ranOnItsBranch(app, key);
    await expect(report).toBeVisible({ timeout: 45_000 });
    console.info("Automatic placement execution:", await report.innerText());
  } finally {
    // The record as it stands, for a run that waited instead.
    if (id)
      await test.info().attach("task.json", {
        body: JSON.stringify(await detail(), null, 2),
        contentType: "application/json",
      });
    await app.close();
  }
});

test("a new task in an Automatic project whose routing names no model starts on this computer's own default", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-automatic-default-");
  seedAutomaticProject(userDataDir);
  // No allowance catalog: routing names no model and defers to the runtime
  // default, as it does for a person whose only model is a custom connection.
  // A project kept on This computer starts such a task on that default, and
  // Automatic waited for a computer with room instead (FI3-1739).
  const app = await launchApp({
    scenarios: [gitStatus],
    userDataDir,
    withMockProvider: true,
    env: SHORT_TICK,
  });
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    const release = await holdCpuBusy(app);
    const asked = await askForTask(app);
    id = asked.id;
    await startsAfterCpuRelease(app, detail, release);
    const report = ranOnItsBranch(app, asked.key);
    await expect(report).toBeVisible({ timeout: 45_000 });
    console.info("Automatic placement execution:", await report.innerText());
    // It ran on the default: no routing decision chose a model for it.
    expect((await detail()).tier).toBeNull();
  } finally {
    if (id)
      await test.info().attach("task.json", {
        body: JSON.stringify(await detail(), null, 2),
        contentType: "application/json",
      });
    await app.close();
  }
});

test("a premium ask in an Automatic project that no computer can serve waits on the premium reset, and Firstmate hears", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-automatic-premium-");
  seedAutomaticProject(userDataDir);
  // The only model is the crew's Grok, placed at medium: nothing here serves
  // premium. A project kept on This computer holds such an ask on the premium
  // reset and tells Firstmate, which may offer to start it lower; Automatic
  // waited quietly instead, and with no premium model placed nothing ended
  // that wait (FI3-1744).
  const crew = seedGrokCrew(userDataDir);
  const app = await launchApp({
    scenarios: [gitStatus],
    userDataDir,
    withMockProvider: true,
    ...crew,
    env: { ...crew.env, ...SHORT_TICK },
  });
  const mock = app.mockProvider;
  if (!mock) throw new Error("Asking Firstmate needs the mock provider");
  const title = "Fix the ledger footer";
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    // e2e-typed-words: the captain's own ask for a premium model
    const words = "Fix the ledger footer with a premium model.";
    await waitForFirstmateIdle(app.page);
    const answer = mock.scriptFirstmateTurn(
      served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
      [
        {
          name: "spawn_crewmate",
          args: {
            title,
            goal: "The footer is fixed.",
            user_words: words,
            repo_id: "repo-ledger",
            shape: { premium_ask: true, skipped_plan_because: "A one-line fix" },
          },
        },
      ],
    );
    const input = promptInput(app.page);
    await pressWindowKey(app.app, "l", ["meta"]);
    await expect(input).toBeFocused();
    await typeInto(input, words);
    await input.press("Enter");
    await expect.poll(answer.outcome, { timeout: 30_000 }).toMatchObject({ state: "closed" });
    id = (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (task) => task.title === title,
    )?.id;
    if (!id) throw new Error("The premium ask filed no task");

    // Held on the premium reset, not merely queued for the next sweep. A
    // first reading that could not compare this computer asks again on the
    // next sweep, a tick on.
    await expect.poll(async () => (await detail()).flags.held, { timeout: 90_000 }).toBe(true);
    expect((await detail()).status).toBe("open");

    // Firstmate hears what could serve it now, once.
    const told = renderWake({
      facts: {
        kind: "reasoning-wait",
        task: { id, title },
        requested: "premium",
        served: "medium",
        empty: true,
      },
    });
    const heard = () =>
      mock
        .requestBodies()
        .map(
          (body) =>
            providerMessages(body).filter(
              (message) => message.role === "user" && message.text.includes(told),
            ).length,
        )
        .filter((count) => count > 0);
    await expect.poll(heard, { timeout: 30_000 }).not.toHaveLength(0);
    expect(heard().every((count) => count === 1)).toBe(true);
  } finally {
    if (id)
      await test.info().attach("task.json", {
        body: JSON.stringify(await detail(), null, 2),
        contentType: "application/json",
      });
    await app.close();
  }
});

test("a task in an Automatic project that requires a system no computer runs waits, and Firstmate hears at once", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-automatic-system-");
  seedAutomaticProject(userDataDir);
  // INF-720, the captain's Fix 4: INF-653 and INF-665 required Linux, which
  // no computer paired with his runs, and each waited hours on "different
  // required system" until Firstmate happened to look. Nothing is paired
  // here, so this computer is the only one, and the task requires the
  // system it does not run, as its own facts read it.
  const here = process.platform === "linux" ? "linux" : "macos";
  const required = here === "macos" ? "linux" : "macos";
  const app = await launchApp({ scenarios: [gitStatus], userDataDir, withMockProvider: true });
  const mock = app.mockProvider;
  if (!mock) throw new Error("Asking Firstmate needs the mock provider");
  const title = "Compare the test failures on main";
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    // e2e-typed-words: the captain's own ask for a comparison on the other system
    const words = "Compare the two test failures on main on the other system.";
    await waitForFirstmateIdle(app.page);
    const answer = mock.scriptFirstmateTurn(
      served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
      [
        {
          name: "spawn_crewmate",
          args: {
            title,
            goal: "Each failure is named a baseline failure or a flake.",
            user_words: words,
            repo_id: "repo-ledger",
            shape: { skipped_plan_because: "A bounded comparison" },
            placement_requirements: { systems: [required] },
          },
        },
      ],
    );
    const input = promptInput(app.page);
    await pressWindowKey(app.app, "l", ["meta"]);
    await expect(input).toBeFocused();
    await typeInto(input, words);
    await input.press("Enter");
    await expect.poll(answer.outcome, { timeout: 30_000 }).toMatchObject({ state: "closed" });
    const filed = (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (task) => task.title === title,
    );
    id = filed?.id;
    if (!filed || !id) throw new Error("The ask filed no task");

    // Firstmate hears, once, that no computer runs what the task requires,
    // naming this computer's own system.
    const told = renderWake({
      facts: {
        kind: "system-wait",
        task: { id, key: filed.key, title },
        required: [required],
        computers: [{ name: HERE.This, system: here }],
      },
    });
    const heard = () =>
      mock
        .requestBodies()
        .map(
          (body) =>
            providerMessages(body).filter(
              (message) => message.role === "user" && message.text.includes(told),
            ).length,
        )
        .filter((count) => count > 0);
    await expect.poll(heard, { timeout: 30_000 }).not.toHaveLength(0);
    expect(heard().every((count) => count === 1)).toBe(true);
    // It waits, chosen nowhere and unstarted.
    const waiting = await detail();
    expect(waiting).toMatchObject({ status: "open", startedAt: null });
    expect(waiting.placement).toBeUndefined();
  } finally {
    if (id)
      await test.info().attach("task.json", {
        body: JSON.stringify(await detail(), null, 2),
        contentType: "application/json",
      });
    await app.close();
  }
});

// INF-1381: the captain confirmed the user's Dynamic routing switch is off.
// Real services, account vault, routing and Pi must still reach a coding turn.
// Only the provider endpoint and git-status response are disposable stand-ins.
test("Dynamic routing off starts crew on its signed-in account and explicit model", async () => {
  const userDataDir = scratchDir("infinitary-routing-off-");
  seedAutomaticProject(userDataDir);
  const crew = seedGrokCrew(userDataDir);
  const modelsJson = crew.modelsJson;
  if (typeof modelsJson !== "function")
    throw new Error("The isolated crew needs its model catalog");
  const db = openDatabase(userDataDir);
  new SettingsStore(db).setRoutingSettings({ dynamicRouting: false, pins: [] });
  db.close();
  const app = await launchApp({
    scenarios: [gitStatus],
    userDataDir,
    withMockProvider: true,
    ...crew,
    // No configured key on the model definition: only acct_crew can serve it.
    modelsJson: (port) => {
      const config = JSON.parse(modelsJson(port));
      delete config.providers.xai.apiKey;
      return JSON.stringify(config);
    },
    env: { ...crew.env, ...SHORT_TICK },
  });
  try {
    const { key, id } = await askForTask(app);
    const report = ranOnItsBranch(app, key);
    await expect(report).toBeVisible({ timeout: 45_000 });
    const detail = await app.page.evaluate(
      (taskId) => window.infinitary.tasks.detail(taskId),
      id ?? "",
    );
    expect(detail.model).toBe(`xai/${starterFor("xai", "medium")}`);
    const accountId = readSavedData(
      userDataDir,
      (saved) => new TaskStore(saved).get(id ?? "")?.accountId,
    );
    expect(accountId).toBe("acct_crew");
    await test.info().attach("routing-off-startup.json", {
      body: JSON.stringify(
        { model: detail.model, accountId, report: await report.innerText(), detail },
        null,
        2,
      ),
      contentType: "application/json",
    });
    console.info(
      "Routing-off execution:",
      JSON.stringify({ model: detail.model, accountId, report: await report.innerText() }),
    );
  } finally {
    await app.close();
  }
});
