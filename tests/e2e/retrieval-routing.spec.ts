import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import {
  CLASSIFIER_SYSTEM_MARKER,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockModelsJson,
  RETRIEVAL_TASK_ASK,
} from "./mockProvider";
import { regionShot } from "./pictures";
import { promptInput } from "./prompt";
import {
  RETRIEVAL_CARD_TITLE,
  RETRIEVAL_SOURCE,
  RETRIEVAL_TASK_TITLE,
  retrievalTask,
} from "./scenarios/retrievalTask";
import { shownCard, shownEntry } from "./stack";
import { starterFor } from "./starters";
import { usageSummary, usageTab } from "./usage";
import { runFromSearch } from "./windowKeys";

/** Scripted words exercise real dispatch, file reading, storage, answer and closure; not model judgment. */
test("a bounded lookup requests low, reads its source and stays an answer after restart", async () => {
  // The isolated account's real catalog entry is explicitly assigned low for this journey.
  const lookupModel = starterFor("xai", "medium");
  const userDataDir = scratchDir("infinitary-retrieval-");
  const { repoDir } = seedRepo(userDataDir);
  writeFileSync(join(repoDir, "release-info.json"), `${RETRIEVAL_SOURCE}\n`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  git("add", ".");
  git("commit", "-m", "test: seed release facts");
  const originalHead = git("rev-parse", "HEAD");
  const fixtureDir = join(userDataDir, "quota");
  mkdirSync(fixtureDir);
  writeFileSync(
    join(fixtureDir, "snapshot.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), providers: [] }),
  );
  writeFileSync(
    join(fixtureDir, "models.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      models: [{ provider: "grok", id: lookupModel, label: "Mock", effectivePercentRemaining: 80 }],
    }),
  );
  const env = { INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir };
  const modelsJson = (port: number) => {
    const config = JSON.parse(mockModelsJson(port));
    config.providers.xai = {
      ...config.providers[MOCK_PROVIDER_ID],
      models: [{ id: lookupModel, name: "Mock Grok", input: ["text", "image"] }],
    };
    return JSON.stringify(config);
  };
  const accountDir = join(userDataDir, "accounts", "xai", "acct_lookup");
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(
    join(accountDir, "auth.json"),
    JSON.stringify({ xai: { type: "api_key", key: "disposable-key" } }),
  );
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct_lookup",
          providerId: "xai",
          kind: "api_key",
          label: "Lookup test",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, delivery, autonomy) VALUES (?, ?, ?, ?, 'adopt', 'direct-pr', 0)",
  ).run("repo-meterlab", repoDir, "meterlab", Date.now());
  new SettingsStore(db).setModelSlots({
    version: 1,
    assignments: {
      [`xai/${lookupModel}`]: ["low"],
      [`${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`]: ["high"],
    },
    seen: [`xai/${lookupModel}`, `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`],
  });
  const tasks = new TaskService({ db });
  const decisions = new DecisionStore(db);
  let launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [retrievalTask],
    env,
    modelsJson,
  });
  const evidence = process.env.INFINITARY_RETRIEVAL_EVIDENCE;
  try {
    await launched.page.evaluate(() => window.infinitary.quota.refresh());
    const input = promptInput(launched.page);
    await input.fill(RETRIEVAL_TASK_ASK);
    await input.press("Enter");
    await expect(shownCard(launched.page, RETRIEVAL_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    const board = await launched.page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((row) => row.title === RETRIEVAL_TASK_TITLE);
    if (!task) throw new Error("Lookup task missing");
    const row = () => tasks.get(task.id);
    await expect.poll(() => row()?.delivery?.captainWait).toBeTruthy();
    expect(row()?.shape).toMatchObject({
      kind: "retrieval",
      kind_source: `classifier:xai/${lookupModel}`,
      deliverable: "answer",
    });
    expect(row()?.intent?.userWords).toBe(RETRIEVAL_TASK_ASK);
    expect(row()?.difficulty).toBe("low");
    expect(decisions.routing({ taskIds: [task.id], chosen: true }).at(-1)).toMatchObject({
      rule: "R10",
      bucket: "low",
      served: "low",
    });
    const detail = await launched.page.evaluate(
      (id) => window.infinitary.tasks.detail(id),
      task.id,
    );
    expect(detail).toMatchObject({
      deliverable: "answer",
      rigor: null,
      modelReason: { rule: "R10", asked: "low", served: "low" },
    });
    expect(git("rev-parse", "HEAD")).toBe(originalHead);
    expect(git("status", "--porcelain")).toBe("");
    const bodies = launched.mockProvider?.requestBodies() ?? [];
    expect(bodies.some((body) => body.includes(CLASSIFIER_SYSTEM_MARKER))).toBe(true);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "lookup-requests.json"),
        JSON.stringify(
          bodies.map((body) => JSON.parse(body)),
          null,
          2,
        ),
      );
      writeFileSync(
        join(evidence, "lookup-state.json"),
        JSON.stringify(
          { task: row(), detail, routing: decisions.routing({ taskIds: [task.id] }) },
          null,
          2,
        ),
      );
      await regionShot(shownEntry(launched.page), join(evidence, "lookup-answer.png"));
    }
    const savedShape = row()?.shape;
    const savedRouting = decisions.routing({ taskIds: [task.id] });
    const homeDir = launched.homeDir;
    await launched.close();
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [retrievalTask],
      userDataDir,
      homeDir,
      env,
      modelsJson,
    });
    await expect(shownCard(launched.page, RETRIEVAL_CARD_TITLE)).toBeVisible();
    expect(row()?.shape).toEqual(savedShape);
    expect(decisions.routing({ taskIds: [task.id] })).toEqual(savedRouting);
    expect(
      (launched.mockProvider?.requestBodies() ?? []).some((body) =>
        body.includes(CLASSIFIER_SYSTEM_MARKER),
      ),
    ).toBe(false);

    // A person's close reaches the author, whose finished report lets Firstmate close it answered.
    await shownEntry(launched.page).getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => row()?.closedReason, { timeout: 30_000 }).toBe("answered");
    expect(row()?.delivery?.prUrl ?? null).toBeNull();
    expect(row()?.delivery?.landedAt ?? null).toBeNull();
    await runFromSearch(launched.app, launched.page, "settings.usage");
    const usage = await usageSummary(launched.page, { period: "all", scope: "all" });
    expect(
      usage.where.projects
        .flatMap((project) => project.kinds)
        .some((kind) => kind.kind === "retrieval" && kind.amount.records > 0),
    ).toBe(true);
    await expect(
      usageTab(launched.page).section.locator('[data-usage-kind="retrieval"]'),
    ).toBeVisible();
  } finally {
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "lookup-final-state.json"),
        JSON.stringify(
          {
            tasks: tasks.list(),
            routing: db.prepare("SELECT * FROM routing_decisions").all(),
            slots: new SettingsStore(db).getModelSlots(),
            quota: await launched.page.evaluate(() => window.infinitary.quota.models()),
            requests: launched.mockProvider?.requestBodies().map((body) => JSON.parse(body)),
          },
          null,
          2,
        ),
      );
    }
    await launched.close();
    db.close();
  }
});
