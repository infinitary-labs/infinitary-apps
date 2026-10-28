import type { CatalogModelView } from "@shared/quota";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import type { QuotaService } from "../quota/quotaService";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { modelChoiceOf } from "./modelChoice";
import { Router } from "./router";

// INF-1714, the captain's ruling: the task record's Why this model shows how
// its crewmate got its model. The readings are INF-1680's recorded candidates:
// Claude at 20% scored -1.08, Codex at 4% scored -3.30, both running out.
const AT = Date.parse("2026-10-27T17:40:00Z");
const CLAUDE = { provider: "anthropic-claude", id: "claude-opus-5-5" };
const CODEX = { provider: "openai-codex", id: "gpt-6-astra" };
const RECORDED: CatalogModelView[] = [
  {
    provider: "codex",
    id: CODEX.id,
    label: "GPT-6 Astra",
    effectivePercentRemaining: 4,
    spendPriority: -3.3,
    lastsThroughReset: false,
  },
  {
    provider: "claude",
    id: CLAUDE.id,
    label: "Claude Opus 5.5",
    effectivePercentRemaining: 20,
    spendPriority: -1.08,
    lastsThroughReset: false,
  },
];
const BUILD = { kind: "implement", basis: "plan", basis_verified: true } as const;
const WORKSPACE = { repoDir: "", worktreeDir: "", branch: "" };

function world() {
  const db = freshDatabase();
  let models = RECORDED;
  const tasks = new TaskService({ db, now: () => Date.now() });
  const router = new Router({
    decisions: new DecisionStore(db),
    settings: new SettingsStore(db),
    quota: {
      latestModels: () => ({ generatedAt: "now", models }),
      latest: () => undefined,
    } as unknown as QuotaService,
    availableModels: () => [CLAUDE, CODEX],
  });
  const record = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    return task;
  };
  return {
    db,
    tasks,
    router,
    record,
    setModels: (next: CatalogModelView[]) => {
      models = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});
afterEach(() => vi.useRealTimers());

describe("modelChoiceOf (INF-1714)", () => {
  it("explains a crewmate's model from the readings it was decided on", () => {
    const w = world();
    seedTask(w.tasks, { id: "audit-1", title: "Audit the release notes", status: "queued" });
    expect(modelChoiceOf(w.record("audit-1"), new DecisionStore(w.db))).toBeUndefined();
    const routed = w.router.decide("audit-1", "Audit the release notes", BUILD);
    expect(routed?.choice).toEqual(CLAUDE);
    w.tasks.dispatch("audit-1", {
      workspace: WORKSPACE,
      accountId: null,
      assignee: "crewmate",
      model: routed?.choice,
    });
    const choice = modelChoiceOf(w.record("audit-1"), new DecisionStore(w.db));
    expect(choice).toMatchObject({
      decidedBy: "band",
      floorPercent: CREW_NEAR_FLOOR_PERCENT,
      candidates: [
        {
          model: `${CLAUDE.provider}/${CLAUDE.id}`,
          picked: true,
          band: "conserve",
          percentRemaining: 20,
        },
        {
          model: `${CODEX.provider}/${CODEX.id}`,
          picked: false,
          band: "near_floor",
          percentRemaining: 4,
        },
      ],
    });

    // A later reading and a reopened ledger leave the explanation as decided.
    w.setModels(RECORDED.map((model) => ({ ...model, effectivePercentRemaining: 90 })));
    expect(modelChoiceOf(w.record("audit-1"), new DecisionStore(w.db))).toEqual(choice);
    w.db.close();
  });

  it("records no comparison for a choice made before the bands", () => {
    const w = world();
    seedTask(w.tasks, { id: "older", title: "Older start", status: "queued" });
    new DecisionStore(w.db).recordRouting({
      taskId: "older",
      provider: CODEX.provider,
      model: CODEX.id,
      bucket: "medium",
      served: "medium",
      rule: "R4",
      reasons: [],
    });
    w.tasks.dispatch("older", {
      workspace: WORKSPACE,
      accountId: null,
      assignee: "crewmate",
      model: CODEX,
    });
    expect(modelChoiceOf(w.record("older"), new DecisionStore(w.db))).toBeUndefined();
    w.db.close();
  });
});
