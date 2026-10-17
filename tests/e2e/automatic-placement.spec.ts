import { mkdirSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { AUTOMATIC_COMPUTER } from "../../src/shared/placement";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { seedRepo } from "./githubStub";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import {
  GIT_STATUS_PROMPT_MARKER,
  MOCK_GIT_REPORT_PREFIX,
  MOCK_PROVIDER_ID,
  mockModelsJson,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { providerMessages, served } from "./providerRequest";
import { reportLine, taskKey } from "./rails";
import { starterFor } from "./starters";
import { pressWindowKey, typeInto } from "./windowKeys";

/**
 * A new task in a project set to Automatic, the default for every project
 * that lives on a host (docs/helper.md, "Automatic starts"), starts on this
 * computer from its own readings. Nothing here stands in for them: the
 * memory comes from this computer's own reading, including macOS page and
 * pressure reads on a Mac, the CPU from the sampler's real window, and the
 * program, project-access and identity
 * facts from the real git, ioreg or machine id. A Mac in ordinary use keeps
 * almost no memory page empty, so a rule that counted only empty pages left
 * every such task waiting for a computer with room (FI3-1733); a virtual
 * machine, such as the hosted Linux runner, once read no identity and waited
 * the same way (FI3-1738). This journey runs that whole path on the
 * computer the suite runs on.
 */

const PROJECT = "ledger";

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

test("a new task in an Automatic project starts on this computer from its own readings", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-automatic-placement-");
  seedAutomaticProject(userDataDir);
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    ...seedGrokCrew(userDataDir),
  });
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    const asked = await askForTask(app);
    const { key } = asked;
    id = asked.id;

    // Automatic committed this computer (null names the home), not a wait.
    // A start that read a busy processor, as a two-processor virtual machine
    // can while the app itself starts, waits for the next sweep, a minute on.
    await expect
      .poll(async () => (await detail()).placement?.computerId, { timeout: 90_000 })
      .toBeNull();
    const here = (await detail()).placement?.candidates.find(
      (candidate) => candidate.computerId === null,
    );
    expect(here?.rejections).toEqual([]);
    // The reading it chose from is this computer's own, fresh, not a figure a test supplied.
    expect(here?.reading).toMatchObject({
      status: "fresh",
      observation: { memory: { totalBytes: totalmem() } },
    });

    // And the crewmate ran here, in a working copy of its own branch.
    await expect(ranOnItsBranch(app, key)).toBeVisible({ timeout: 45_000 });
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
  const app = await launchApp({ userDataDir, withMockProvider: true });
  let id: string | undefined;
  const detail = () =>
    app.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id ?? "");
  try {
    const asked = await askForTask(app);
    id = asked.id;
    // As above, a busy first reading starts on the next sweep, a minute on.
    await expect(ranOnItsBranch(app, asked.key)).toBeVisible({ timeout: 120_000 });
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
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    ...seedGrokCrew(userDataDir),
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
    // next sweep, a minute on.
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
