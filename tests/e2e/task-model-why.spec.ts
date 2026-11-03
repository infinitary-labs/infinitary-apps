import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { CLAUDE_MODELS } from "../../src/core/claude/claudeModels";
import type { QuotaService } from "../../src/core/quota/quotaService";
import { Router } from "../../src/core/routing/router";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { MODEL_WHY_WORDS, modelChoiceLine } from "../../src/shared/modelChoice";
import { modelReasonLine } from "../../src/shared/modelReason";
import type { CatalogModelView } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import {
  claudeDefaultStore,
  seedClaudeCredentialFile,
  seedSignedInClaudeStore,
  writeMockClaudeClient,
} from "./mockClaudeClient";
import { heroShot, regionShot } from "./pictures";
import {
  expandDock,
  nowRow,
  openGroup,
  recordCard,
  restOnRow,
  rowSummaryBody,
  taskFact,
} from "./rails";
import { starterFor } from "./starters";
import { pressKey } from "./windowKeys";

// INF-1714, the captain's pick A: the full task record explains why its
// crewmate got its model under Why this model, the model's reason folded in,
// and the hover summary shows none of it. The readings are INF-1680's
// recorded burst: Claude at 20% and Codex at 4%, both projected to run out
// before reset; the acceptance is that Claude wins.
const HOUR = 3600_000;
const CLAUDE = { provider: "anthropic-claude", id: starterFor("anthropic-claude", "high") };
const CODEX = { provider: "openai-codex", id: starterFor("openai-codex", "high") };
const CLAUDE_ACCOUNT = "acct_cl_personal";
const CODEX_ACCOUNT = "acct_cx_work";
const TITLE = "Audit the alpha release notes";

function seedAccounts(userDataDir: string, fixtureDir: string, now: number): void {
  writeFileSync(
    join(fixtureDir, "snapshot.json"),
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      fetchedAt: now,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: CLAUDE_ACCOUNT,
          accountLabel: "Personal",
          status: "ok",
          stale: false,
          measuredAt: now - 4 * 60_000,
          windows: [
            {
              id: "seven_day",
              label: "weekly",
              percentRemaining: 20,
              resetsAtMs: now + 40 * HOUR,
              windowSeconds: 604_800,
            },
          ],
        },
        {
          provider: "codex",
          label: "Codex",
          accountId: CODEX_ACCOUNT,
          accountLabel: "Work",
          status: "ok",
          stale: false,
          measuredAt: now - 3 * 60_000,
          windows: [
            {
              id: "weekly",
              label: "weekly",
              percentRemaining: 4,
              resetsAtMs: now + 30 * HOUR,
              windowSeconds: 604_800,
            },
          ],
        },
      ],
    }),
  );
  const accountsDir = join(userDataDir, "accounts");
  mkdirSync(join(accountsDir, "openai-codex", CODEX_ACCOUNT), { recursive: true });
  writeFileSync(
    join(accountsDir, "openai-codex", CODEX_ACCOUNT, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "fake",
        refresh: "fake",
        expires: now + 30 * 24 * HOUR,
      },
    }),
  );
  mkdirSync(join(accountsDir, "anthropic-claude", CLAUDE_ACCOUNT), { recursive: true });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: CLAUDE_ACCOUNT,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: 1,
        },
        {
          id: CODEX_ACCOUNT,
          providerId: "openai-codex",
          kind: "subscription_oauth",
          label: "Work",
          enabled: true,
          createdAt: 2,
        },
      ],
      pins: {},
    }),
  );
}

/** One crew start, routed by the real router over INF-1680's readings and dispatched. */
function startCrewTask(userDataDir: string): string {
  const models: CatalogModelView[] = [
    {
      provider: "codex",
      id: CODEX.id,
      label: "Codex",
      effectivePercentRemaining: 4,
      spendPriority: -3.3,
      lastsThroughReset: false,
    },
    {
      provider: "claude",
      id: CLAUDE.id,
      label: "Claude",
      effectivePercentRemaining: 20,
      spendPriority: -1.08,
      lastsThroughReset: false,
    },
  ];
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    const decisions = new DecisionStore(db);
    const router = new Router({
      decisions,
      settings: new SettingsStore(db),
      quota: {
        latestModels: () => ({ generatedAt: new Date().toISOString(), models }),
        latest: () => undefined,
      } as unknown as QuotaService,
      availableModels: () => [CLAUDE, CODEX],
    });
    const id = "audit-notes";
    seedTask(tasks, { id, title: TITLE, status: "queued" });
    const routed = router.decide(id, TITLE, {
      kind: "implement",
      basis: "plan",
      basis_verified: true,
    });
    // INF-1714's acceptance: the larger remaining allowance wins over a near-floor one.
    expect(routed?.choice).toEqual(CLAUDE);
    decisions.recordAccount({
      taskId: id,
      provider: CLAUDE.provider,
      accountId: CLAUDE_ACCOUNT,
      reasons: [],
      facts: {
        kind: "account-candidates",
        candidates: [
          { accountId: CLAUDE_ACCOUNT, label: "Personal", percentRemaining: 20, status: "picked" },
        ],
      },
    });
    tasks.dispatch(id, {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: CLAUDE_ACCOUNT,
      assignee: "crewmate",
      model: CLAUDE,
    });
    // The crewmate finished; its record keeps the explanation.
    tasks.close(id, { status: "done", reason: "settled", actor: "host" });
    return id;
  } finally {
    db.close();
  }
}

/** The record of a finished task, opened by keys from its row in the open Done group. */
async function openRecord(app: LaunchedApp, key: string): Promise<Locator> {
  await pressKey(nowRow(app.page, key), "Enter");
  await expect(recordCard(app.page)).toBeVisible();
  return taskFact(recordCard(app.page), "why");
}

/**
 * Why this model as the record draws it: open, its sentence, and each ranked
 * model's name and whether it was chosen. Read once the model list has named
 * the chosen model, which loads after launch.
 */
async function readWhy(why: Locator) {
  const rows = why.locator("li");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator("[data-task-why-name]")).not.toContainText(CLAUDE.id, {
    timeout: 20_000,
  });
  // INF-2384: the chosen row must resolve to the catalog's friendly name,
  // not merely to any string that happens to omit the raw id.
  const name = CLAUDE_MODELS.find((model) => model.id === CLAUDE.id)?.name;
  expect(name).toBeDefined();
  await expect(rows.first().locator("[data-task-why-name]")).toHaveText(
    `${name} · ${MODEL_WHY_WORDS.chosen}`,
  );
  return {
    open: await why.evaluate((el) => (el as HTMLDetailsElement).open),
    line: await why.locator("[data-task-why-line]").textContent(),
    models: await rows.evaluateAll((items) =>
      items.map((item) => ({
        name: item.querySelector("[data-task-why-name]")?.textContent ?? "",
        picked: item.hasAttribute("data-picked"),
      })),
    ),
  };
}

test("the task record explains why its crewmate got its model, and the hover summary does not", async () => {
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-model-why-");
  const fixtureDir = scratchDir("infinitary-model-why-quota-");
  seedAccounts(userDataDir, fixtureDir, Date.now());
  const taskId = startCrewTask(userDataDir);
  const options = {
    withMockProvider: true,
    userDataDir,
    env: {
      INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir,
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-model-why-claude-")),
    },
  };
  let launched = await launchApp({
    ...options,
    prepareHome: (homeDir) => {
      const store = claudeDefaultStore(homeDir);
      seedSignedInClaudeStore(store);
      // INF-2384: health reads the saved credential, not the client's marker.
      seedClaudeCredentialFile(store);
    },
  });
  const homeDir = launched.homeDir;
  // Where a picture-taking run keeps its pictures; a gate run takes none.
  const evidence = process.env.INFINITARY_MODEL_WHY_EVIDENCE;
  try {
    // INF-2384: this is a connected-account journey. Prove its prerequisite
    // through the app's own reads, before diagnosing a missing display name.
    const claude = await launched.page.evaluate(
      async ({ accountId, modelId }) => {
        const account = (await window.infinitary.accounts.list()).find(
          (each) => each.id === accountId,
        );
        const slots = await window.infinitary.models.slots();
        return {
          connected: account?.connected,
          models: [...slots.models, ...slots.byName].filter((model) => model.id === modelId),
        };
      },
      { accountId: CLAUDE_ACCOUNT, modelId: CLAUDE.id },
    );
    await test.info().attach("claude-model-prerequisite", {
      body: JSON.stringify(claude, null, 2),
      contentType: "application/json",
    });
    expect(claude.connected).toBe(true);
    const detail = await launched.page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
    expect(detail.modelChoice).toMatchObject({
      decidedBy: "band",
      candidates: [
        { model: `${CLAUDE.provider}/${CLAUDE.id}`, picked: true, band: "conserve" },
        { model: `${CODEX.provider}/${CODEX.id}`, picked: false, band: "near_floor" },
      ],
    });
    if (!detail.modelReason || !detail.modelChoice) throw new Error("No model reason saved");
    const reason = modelReasonLine(detail.modelReason);

    // Resting on the task's row opens its summary, which shows no Why this model.
    await expandDock(launched.page, "now");
    await openGroup(launched.page, "landed");
    await restOnRow(launched.page, detail.key);
    await expect(rowSummaryBody(launched.page)).toHaveAttribute("data-crew-summary", taskId);
    await expect(taskFact(rowSummaryBody(launched.page), "model")).toBeVisible();
    await expect(taskFact(rowSummaryBody(launched.page), "why")).toHaveCount(0);
    if (evidence)
      await regionShot(rowSummaryBody(launched.page), join(evidence, "after-summary.png"));
    await launched.page.mouse.move(4, 400);

    // The record's Why this model opens from the keyboard: the model's reason,
    // then how the allowance decided, then the models ranked as decided.
    let why = await openRecord(launched, detail.key);
    await expect(why.locator("summary")).toHaveText(MODEL_WHY_WORDS.summary);
    if (evidence)
      await regionShot(recordCard(launched.page), join(evidence, "after-record-closed.png"));
    await pressKey(why.locator("summary"), "Enter");
    const shown = await readWhy(why);
    if (evidence) {
      await regionShot(recordCard(launched.page), join(evidence, "after-record-open.png"));
      await heroShot(launched.app, launched.page, {
        region: recordCard(launched.page).locator("[data-record-strip]"),
        name: "crew-allowance-band",
      });
    }
    const names = new Map(
      detail.modelChoice.candidates.map((candidate, index) => [
        candidate.model,
        (shown.models[index]?.name ?? "").replace(` · ${MODEL_WHY_WORDS.chosen}`, ""),
      ]),
    );
    expect(shown).toEqual({
      open: true,
      line: `${reason}. ${modelChoiceLine(detail.modelChoice, (model) => names.get(model) ?? model)}`,
      models: [
        { name: expect.stringContaining(MODEL_WHY_WORDS.chosen), picked: true },
        { name: expect.not.stringContaining(MODEL_WHY_WORDS.chosen), picked: false },
      ],
    });
    // The model's reason lives only there: the footnote no longer says it.
    await expect(taskFact(recordCard(launched.page), "reason")).toHaveCount(0);

    // A new reading leaves the explanation as it was decided.
    await launched.page.evaluate(() => window.infinitary.quota.refresh());
    const refreshed = await readWhy(why);
    expect(refreshed).toEqual(shown);
    await launched.close();

    // A restart reads the same saved choice.
    launched = await launchApp({ ...options, homeDir });
    await expandDock(launched.page, "now");
    await openGroup(launched.page, "landed");
    why = await openRecord(launched, detail.key);
    await pressKey(why.locator("summary"), "Enter");
    const restarted = await readWhy(why);
    expect(restarted).toEqual(shown);
    await test.info().attach("why-this-model-readings", {
      body: JSON.stringify({ initial: shown, refreshed, restarted }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await launched.close();
  }
});
