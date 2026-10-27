import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import {
  CLASSIFIER_SYSTEM_MARKER,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockModelsJson,
} from "./mockProvider";
import { promptInput } from "./prompt";
import {
  OPERATION_ASK,
  OPERATION_CLOSE,
  OPERATION_TITLE,
  operationTask,
} from "./scenarios/operationTask";
import { starterFor } from "./starters";
import { usageSummary } from "./usage";

// INF-1430 piece 2: the effect, report, requested tier, tool boundary and durable close.
// Disposable folder and scripted model; no accounts, devices or shared services.
test("an operation makes its named effect and closes finished from reported evidence", async () => {
  const userDataDir = scratchDir("infinitary-operation-");
  const { repoDir } = seedRepo(userDataDir);
  const operationModel = starterFor("xai", "medium");
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
      models: [
        { provider: "grok", id: operationModel, label: "Mock", effectivePercentRemaining: 80 },
      ],
    }),
  );
  const env = { INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir };
  const modelsJson = (port: number) => {
    const config = JSON.parse(mockModelsJson(port));
    config.providers.xai = {
      ...config.providers[MOCK_PROVIDER_ID],
      models: [{ id: operationModel, name: "Mock Grok", input: ["text", "image"] }],
    };
    return JSON.stringify(config);
  };
  const accountDir = join(userDataDir, "accounts", "xai", "acct_operation");
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
          id: "acct_operation",
          providerId: "xai",
          kind: "api_key",
          label: "Operation test",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
  const db = openDatabase(userDataDir);
  db.prepare(
    "INSERT INTO repos (id,path,name,added_at,setup_kind,delivery,autonomy) VALUES (?,?,?,?,'adopt','direct-pr',0)",
  ).run("repo-meterlab", repoDir, "meterlab", Date.now());
  new SettingsStore(db).setModelSlots({
    version: 1,
    assignments: {
      [`xai/${operationModel}`]: ["medium"],
      [`${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`]: ["high"],
    },
    seen: [`xai/${operationModel}`, `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`],
  });
  const tasks = new TaskService({ db });
  const decisions = new DecisionStore(db);
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [operationTask],
    env,
    modelsJson,
  });
  try {
    await launched.page.evaluate(() => window.infinitary.quota.refresh());
    await promptInput(launched.page).fill(OPERATION_ASK);
    await promptInput(launched.page).press("Enter");
    await expect
      .poll(() => tasks.list().find((t) => t.title === OPERATION_TITLE)?.outcome)
      .toContain("ready");
    const task = tasks.list().find((t) => t.title === OPERATION_TITLE);
    if (!task) throw new Error("Operation missing");
    await expect.poll(() => tasks.get(task.id)?.activity).toBe("idle");
    expect(readFileSync(join(repoDir, "service.status"), "utf8")).toBe("ready\n");
    expect(task.shape).toMatchObject({
      deliverable: "operation",
      kind: "unclear",
      kind_source: "skipped:operation",
      in_place: { folder: true },
    });
    expect(decisions.routing({ taskIds: [task.id], chosen: true }).at(-1)).toMatchObject({
      rule: "R12",
      bucket: "medium",
    });
    const requests = launched.mockProvider?.requestBodies() ?? [];
    expect(requests.some((b) => b.includes(CLASSIFIER_SYSTEM_MARKER))).toBe(false);
    const worker = requests
      .map((b) => JSON.parse(b))
      .filter((b) => JSON.stringify(b.messages).includes("Operation shape:"));
    expect(worker.length).toBeGreaterThan(0);
    for (const body of worker) {
      const names = (body.tools ?? []).map(
        (t: { name?: string; function?: { name: string } }) => t.name ?? t.function?.name,
      );
      for (const name of ["prepare_change", "open_change", "check_change"])
        expect(names).not.toContain(name);
      expect(names).toContain("github_write");
    }
    const detail = await launched.page.evaluate(
      (id) => window.infinitary.tasks.detail(id),
      task.id,
    );
    expect(detail).toMatchObject({ deliverable: "operation", rigor: null });
    const usage = await usageSummary(launched.page, { period: "all", scope: "task" });
    expect(
      usage.where.projects
        .flatMap((p) => p.kinds)
        .some((k) => k.kind === "operation" && k.amount.records > 0),
    ).toBe(true);
    await waitForFirstmateIdle(launched.page);
    await promptInput(launched.page).fill(`${OPERATION_CLOSE}: operation task ${task.id}`);
    await promptInput(launched.page).press("Enter");
    await expect
      .poll(() => tasks.get(task.id))
      .toMatchObject({ status: "done", closedReason: "finished" });
    expect(readFileSync(join(repoDir, "service.status"), "utf8")).toBe("ready\n");
    expect(tasks.get(task.id)?.delivery?.prUrl ?? null).toBeNull();
  } finally {
    await launched.close();
    db.close();
  }
});
