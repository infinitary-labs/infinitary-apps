/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/routing/
 * @journey-area src/core/storage/decisionStore.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogRefreshesSettled, createModelRuntime } from "../../src/core/pi/modelRuntime";
import { clampThinkingLevel } from "../../src/core/pi/session";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { SLOTS, type Slot, TRACKED_FAMILIES } from "../../src/shared/modelSlots";
import type { Reasoning } from "../../src/shared/reasoning";
import {
  DEFAULT_ROUTING_POLICY,
  type RuleId,
  type WorkShape,
} from "../../src/shared/routingPolicy";
import type { PlanItem } from "../../src/shared/taskPlan";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";

type ModelExample = { provider: string; id: string; label: string };

/**
 * The shape a crewmate was commissioned with and the routing decision
 * recorded for it. The shape's stamped `rigor` is its care: Quick lowers the
 * reasoning its session opens at.
 */
export type CrewRouting = { shape: WorkShape; rule: RuleId; asked: Slot; served: Slot };

export type CrewRosterOptions = {
  /** Task ids are `<idPrefix>-<index>`. */
  idPrefix?: string;
  title?: (index: number) => string;
  /** A crewmate's own progress note, the newest row of that record's Activity. */
  note?: (index: number) => string | undefined;
  /**
   * How each crewmate's model was chosen. A shape's `basis` may name
   * `<idPrefix>-basis`, a finished task seeded beside the crew when any
   * crewmate is routed.
   */
  routing?: (index: number) => CrewRouting | undefined;
  /**
   * A pull request the crewmate opened and its checks, recorded the way the
   * forge's reads record them, before its own note.
   */
  change?: (index: number) =>
    | {
        prNumber: number;
        ci: "green" | "red" | "pending";
        /** How long ago, in ms, the host says its first check started. */
        startedAgo?: number;
      }
    | undefined;
  /** The plan a crewmate's note carries (FI3-734), sent with its note. */
  plan?: (index: number) => PlanItem[] | undefined;
};

/** Actual bundled model definitions, isolated account and idle workspaces.
 * The quota fixture prevents HTTP; model availability still crosses the real
 * per-account runtime and the label lookup includes the by-name pool.
 */
export async function crewRoster(count: number, options: CrewRosterOptions = {}) {
  const { idPrefix = "label-crew" } = options;
  const title = options.title ?? ((index: number) => `Label example ${index + 1}`);
  const userDataDir = scratchDir("infinitary-crew-labels-");
  const catalogDir = scratchDir("infinitary-label-catalog-");
  const authPath = join(catalogDir, "auth.json");
  writeFileSync(authPath, "{}", { mode: 0o600 });
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  let models: [ModelExample, ModelExample];
  /** What each example's session opens at, by served level and care, as Pi clamps it. */
  const opening = new Map<string, Reasoning>();
  const openingKey = (model: ModelExample, served: Slot, quick: boolean) =>
    `${model.provider}/${model.id}/${served}/${quick}`;
  try {
    const runtime = await createModelRuntime({
      authPath,
      modelsPath: join(catalogDir, "models.json"),
    });
    const all = runtime.getModels("openrouter");
    const rule = TRACKED_FAMILIES.openrouter;
    if (!rule || rule === "every") throw new Error("OpenRouter starter catalog is missing");
    const short = all.find((model) => model.id === rule.ids[1]);
    const longest = [...all]
      .filter((model) => model.reasoning)
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!short || !longest) throw new Error("Missing bundled model examples");
    const row = (model: { provider: string; id: string; name: string }): ModelExample => ({
      provider: model.provider,
      id: model.id,
      label: model.name,
    });
    models = [row(short), row(longest)];
    for (const model of models)
      for (const served of SLOTS)
        for (const quick of [false, true]) {
          // The level the supervisor asks for at that served level.
          const requested = (DEFAULT_ROUTING_POLICY.effort?.[served] ?? "medium") as
            | "low"
            | "medium"
            | "high"
            | "xhigh";
          opening.set(
            openingKey(model, served, quick),
            clampThinkingLevel(model, runtime, requested, quick),
          );
        }
  } finally {
    await catalogRefreshesSettled();
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }

  seedAccountStore(userDataDir, "openrouter", "acct_labels", { recursive: true });
  seedAccountAuth(
    userDataDir,
    "openrouter",
    "acct_labels",
    { openrouter: { type: "api_key", key: "fixture-key" } },
    { mode: 0o600 },
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: "acct_labels",
        providerId: "openrouter",
        kind: "api_key",
        label: "Preview examples",
        enabled: true,
        createdAt: Date.now(),
      },
    ],
    {},
    { mode: 0o600 },
  );
  const quotaDir = scratchDir("infinitary-label-quota-");
  const generatedAt = new Date().toISOString();
  writeFileSync(join(quotaDir, "snapshot.json"), JSON.stringify({ generatedAt, providers: [] }));
  writeFileSync(join(quotaDir, "models.json"), JSON.stringify({ generatedAt, models }));
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  /** The reasoning each routed crewmate's dispatch recorded, by task id. */
  const openings: Record<string, Reasoning> = {};
  const decisions = new DecisionStore(db);
  if (options.routing) {
    seedTask(tasks, {
      id: `${idPrefix}-basis`,
      title: "The work the crew builds on",
      status: "idle",
      outcome: "Reproduced and understood.",
      createdAt: Date.now() - (count + 1),
    });
    tasks.close(`${idPrefix}-basis`, { status: "done", reason: "answered", actor: "captain" });
  }
  for (let i = 0; i < count; i++) {
    const model = models[i % models.length];
    if (!model) throw new Error("Crew model example is missing");
    const worktreeDir = join(userDataDir, "crew", String(i));
    mkdirSync(worktreeDir, { recursive: true });
    const routing = options.routing?.(i);
    const reasoning = routing
      ? opening.get(openingKey(model, routing.served, routing.shape.rigor === "quick"))
      : undefined;
    if (reasoning) openings[`${idPrefix}-${i}`] = reasoning;
    seedTask(tasks, {
      id: `${idPrefix}-${i}`,
      title: title(i),
      status: "idle",
      worktreeDir,
      model,
      ...(reasoning ? { reasoning } : {}),
      ...(routing ? { shape: routing.shape } : {}),
      outcome: "Preview crew waiting for the captain.",
      // In roster order, and before each row's own dispatch and report.
      createdAt: Date.now() - (count - i),
    });
    if (routing) {
      decisions.recordRouting({
        taskId: `${idPrefix}-${i}`,
        provider: model.provider,
        model: model.id,
        bucket: routing.asked,
        rule: routing.rule,
        served: routing.served,
        reasons: [],
      });
    }
    const change = options.change?.(i);
    if (change) {
      const label = `#${change.prNumber}`;
      const prUrl = `https://github.com/example/crew/pull/${change.prNumber}`;
      seedDelivery(
        tasks,
        `${idPrefix}-${i}`,
        { mode: "direct-pr", prNumber: change.prNumber, changeLabel: label, prUrl },
        { kind: "pr_opened", text: `opened ${label}` },
      );
      seedDelivery(
        tasks,
        `${idPrefix}-${i}`,
        {
          ci: change.ci,
          ciAt: Date.now(),
          ...(change.startedAgo !== undefined
            ? { ciStartedAt: Date.now() - change.startedAgo }
            : {}),
        },
        { kind: "ci", text: `checks ${change.ci}` },
      );
    }
    const note = options.note?.(i);
    if (note) tasks.noteProgress(`${idPrefix}-${i}`, note, "crewmate", options.plan?.(i));
  }
  db.close();
  return { userDataDir, models, openings, env: { INFINITARY_QUOTA_FIXTURE_DIR: quotaDir } };
}
