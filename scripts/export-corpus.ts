/**
 * C4 - the dev-gated corpus export (PoC-2 capture; design record
 * `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3).
 *
 * The one command that packages everything the app has already captured into
 * an eval/training corpus: the supervision decisions from the tables
 * (`supervision_outcomes` with its migration-15 provenance and migration-16
 * missed-escalation label, joined to `cards` and `tasks`) and the
 * orchestrator's dispatch turns from the Pi JSONL transcripts - the latter by
 * calling C5's extractor, never by re-implementing it. Beside them, the
 * pre-S7c supervision archives (G1, `extract-supervision-turns.ts`, called
 * the same way; the app no longer writes these transcripts) and the R2
 * provenance rows (`decided`, `steered`,
 * `interrupted`) verbatim from the task timeline.
 *
 * It moves transcripts, which is exactly what Observe's hard gate exists to
 * contain, so it reuses that gate's development half verbatim
 * (`isDevObserveEnabled`, `src/core/observe/gate.ts`):
 * `app.isPackaged === false` OR `INFINITARY_DEV_OBSERVE=1`, and nothing else.
 * Never a setting, never a default-on packaged path. When the gate is shut
 * the export reads nothing and writes nothing.
 *
 * No schema change, no second store, no product surface, no telemetry: it
 * reads what is on disk and writes local files.
 *
 * Run it (Node 24 strips the types):
 *   pnpm export:corpus --out ./corpus
 *   pnpm export:corpus --user-data /path/to/exported/userData --out ./corpus
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingFrom } from "../src/shared/envSettings.ts";
import {
  type DevObserveGateInput,
  isDevObserveEnabled,
  OBSERVE_DISABLED_MESSAGE,
} from "../src/core/observe/gate.ts";
import { redactDeep, redactObserveText } from "../src/core/observe/redact.ts";
import { FIRSTMATE_CONTRACT_VERSION } from "../src/core/prompts/contractVersion.ts";
import {
  cardVersionAt,
  chosenEffectOf,
  declaredActionsOf,
  type DispatchRecord,
  defaultUserDataDir,
  EMPTY_TABLES,
  extractDispatchCorpus,
  type FleetTables,
  readFleetTables,
  resolutionOf,
} from "./extract-dispatch-corpus.ts";
import {
  escalationLineages,
  isCompletionCard,
  kindSourceClass,
  type MetricValue,
  type ObservedDispatch,
  type ObservedReview,
  observedReviews,
  overridesByHold,
  scoreRigor,
  scoreRouting,
} from "./interaction-metrics.ts";
import {
  carriesEvidenceHeadings,
  reportEvidenceHeadings,
  type Rigor,
  rigorRequiresEvidence,
} from "../src/shared/rigor.ts";
import {
  extractSupervisionTurns,
  type SupervisionTurnCounts,
  type SupervisionTurnRecord,
} from "./extract-supervision-turns.ts";
import {
  buildHumanSupervision,
  danglingAssets,
  HUMAN_SUPERVISION_FILE,
  HUMAN_SUPERVISION_LABELS_FILE,
  type HumanSupervisionManifest,
  type HumanSupervisionPack,
} from "./human-supervision.ts";

// --------------------------------------------------------------------------
// The supervision dataset (tables only - C1's provenance and C3's label)
// --------------------------------------------------------------------------

type TaskRow = FleetTables["tasks"] extends Map<string, infer T> ? T : never;
type CardRow = FleetTables["cards"] extends Map<string, infer T> ? T : never;

export type SupervisionCardJoin = {
  card_id: string;
  found: boolean;
  /** The stored `kind` column verbatim (one shape since cards/tasks/agents P1: "card"; older rows keep their word). */
  kind?: string;
  /** Whether the card offered choices: a decision is a card with actions, whatever its stored kind. */
  decision?: boolean;
  author?: string | null;
  title?: string;
  status?: string;
  created_at?: number;
  resolved_at?: number | null;
  chosen_action?: string | null;
  /** The body/actions from the persisted version covering the outcome. */
  body?: string;
  actions?: Record<string, unknown>[];
  actions_version?: "current" | "revision" | "unknown";
  description_version?: {
    requested_at: number;
    selected_at: number | null;
    basis: "current" | "revision" | "unknown";
    fallback: "creation" | null;
  };
  resolution_actions?: Record<string, unknown>[];
  resolution_version?: {
    requested_at: number | null;
    selected_at: number | null;
    basis: "current" | "revision" | "open" | "unknown";
  };
  chosen_effect?: Record<string, unknown> | null;
  effect_source?: "declared" | "legacy-id" | null;
  captain_contact?: "steer" | "settle" | "open" | "dismissed" | "withdrawn" | "none";
  /** Who resolved it, from the record's actor-labelled timeline. */
  resolved_by?: string | null;
  revisions?: number;
  resolution?: "open" | "acted" | "dismissed" | "retired" | "unknown";
  /** The captain-confirmed duplicate label (WI-14); null when unflagged. */
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  duplicate_at?: number | null;
};

export type SupervisionTaskJoin = {
  task_id: string;
  found: boolean;
  title?: string;
  status?: string;
  kind?: string;
  repo_id?: string | null;
  repo_name?: string | null;
  delivery?: string | null;
  autonomy?: boolean | null;
  /**
   * How the work was routed (intelligence-bucket routing S5): the `WorkShape`
   * the host computed at commission - which carries the classifier's own
   * stamp as `kind_source` - the policy rule that read it, the tier it asked
   * for, and the tier the ladder served. The dispatch dataset has carried
   * these since S2; they belong on a supervision record too, because whether
   * a verdict should have reached the captain is not independent of what the
   * work was taken to be, or of how strong a model was serving it. Null
   * throughout on a row routed before the shape existed.
   */
  shape?: Record<string, unknown> | null;
  tier?: string | null;
  rule?: string | null;
  served?: string | null;
};

export type SupervisionRecord = {
  dataset: "supervision";
  outcome_id: number;
  at: number;
  wake: string;
  wake_kind: string | null;
  /** What the supervision session actually filed. */
  observed_verdict: "routine" | "captain";
  summary: string;
  steered: boolean | null;
  /** C1's provenance stamp. Null throughout on a pre-migration-15 row. */
  provenance: {
    model: string | null;
    prompt_sha: string | null;
    tools_sha: string | null;
    versioned: boolean;
  };
  task: SupervisionTaskJoin;
  card: SupervisionCardJoin | null;
  label: {
    /**
     * The verdict the corpus trains toward. It is the observed one, except
     * where C3's captain-confirmed miss says a routine call should have
     * reached the captain - the one non-weak label in this dataset.
     */
    gold_verdict: "routine" | "captain";
    weak: boolean;
    confidence: "confirmed" | "corroborated" | "observed" | "contradicted";
    unknown: boolean;
    basis: "confirmed-miss" | "card-resolution" | "observation" | "missing-card-version";
    missed_escalation: boolean | null;
    missed_note: string | null;
    missed_at: number | null;
    evidence: string[];
  };
};

type OutcomeRow = {
  id: number;
  task_id: string;
  wake: string;
  verdict: string;
  summary: string;
  at: number;
  card_id?: string | null;
  model?: string | null;
  prompt_sha?: string | null;
  tools_sha?: string | null;
  steered?: number | null;
  wake_kind?: string | null;
  missed_escalation?: number | null;
  missed_note?: string | null;
  missed_at?: number | null;
};

/**
 * Read-only snapshot of the supervision table. A database that predates
 * migration 15 or 16 simply has no such columns; those rows are read as
 * unstamped rather than skipped, because "no label" is not "no row".
 */
export function readSupervisionOutcomes(dbPath: string): OutcomeRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // A table, or since migration 50 the view over the one decision ledger.
    const present = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all() as { name: string }[]
    ).some((row) => row.name === "supervision_outcomes");
    if (!present) return [];
    return db.prepare("SELECT * FROM supervision_outcomes ORDER BY id").all() as OutcomeRow[];
  } finally {
    db.close();
  }
}

function boolOrNull(value: number | null | undefined): boolean | null {
  return value == null ? null : value !== 0;
}

function joinTask(taskId: string, tables: FleetTables): SupervisionTaskJoin {
  const task = tables.tasks.get(taskId) as TaskRow | undefined;
  if (!task) return { task_id: taskId, found: false };
  const repo = task.repo_id ? tables.repos.get(task.repo_id) : undefined;
  const routing = tables.routing.get(taskId);
  return {
    task_id: taskId,
    found: true,
    title: redactObserveText(task.title),
    status: task.status,
    kind: task.kind,
    repo_id: task.repo_id,
    repo_name: repo?.name ?? null,
    delivery: repo?.delivery ?? null,
    autonomy: repo ? repo.autonomy !== 0 : null,
    shape: parseShape(task.shape_json),
    tier: task.difficulty,
    rule: routing?.rule ?? null,
    served: routing?.served ?? null,
  };
}

/** The stored `WorkShape`, or null when the row has none or it is unreadable. */
function parseShape(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function joinCard(cardId: string, at: number, tables: FleetTables): SupervisionCardJoin {
  const card = tables.cards.get(cardId) as CardRow | undefined;
  if (!card) return { card_id: cardId, found: false };
  const revisions = tables.cardRevisions.get(cardId) ?? [];
  const descriptionAt = at < card.created_at ? card.created_at : at;
  const descriptionFallback = at < card.created_at ? "creation" : null;
  const descriptionVersion = cardVersionAt(card, revisions, descriptionAt);
  const descriptionActions = descriptionVersion
    ? declaredActionsOf(descriptionVersion.actions_json)
    : [];
  const resolutionAt = card.resolved_at;
  const resolutionVersion =
    resolutionAt === null ? null : cardVersionAt(card, revisions, resolutionAt);
  const resolutionActions = resolutionVersion
    ? declaredActionsOf(resolutionVersion.actions_json)
    : [];
  const resolved = tables.cardResolved.get(cardId);
  const resolutionLegacy = resolutionVersion !== null && resolutionVersion.kind !== "card";
  const resolution =
    resolutionAt === null
      ? "open"
      : resolutionVersion
        ? resolutionOf(
            { ...card, actions_json: resolutionVersion.actions_json },
            resolved,
            { legacy: resolutionLegacy },
          )
        : "unknown";
  return {
    card_id: cardId,
    found: true,
    ...(descriptionVersion
      ? {
          kind: descriptionVersion.kind,
          decision: descriptionActions.length > 0,
          title: redactObserveText(descriptionVersion.title),
          body: redactObserveText(descriptionVersion.body),
          actions: descriptionActions,
        }
      : {}),
    author: card.author,
    actions_version: descriptionVersion?.basis ?? "unknown",
    description_version: {
      requested_at: at,
      selected_at: descriptionVersion ? descriptionAt : null,
      basis: descriptionVersion?.basis ?? "unknown",
      fallback: descriptionFallback,
    },
    ...(resolutionVersion ? { resolution_actions: resolutionActions } : {}),
    resolution_version: {
      requested_at: resolutionAt,
      selected_at: resolutionVersion ? resolutionAt : null,
      basis: resolutionAt === null ? "open" : (resolutionVersion?.basis ?? "unknown"),
    },
    status: card.status,
    created_at: card.created_at,
    resolved_at: resolutionAt,
    chosen_action: card.chosen_action,
    ...chosenEffectOf(resolutionActions, card.chosen_action, resolution, {
      legacy: resolutionLegacy,
      cardId: card.id,
      author: card.author,
    }),
    resolved_by: resolved?.actor ?? null,
    revisions: revisions.length,
    resolution,
    duplicate_of: card.duplicate_of ?? null,
    duplicate_note: card.duplicate_note ? redactObserveText(card.duplicate_note) : null,
    duplicate_at: card.duplicate_at ?? null,
  };
}

/**
 * Turn one outcome row plus its joins into a corpus record. The label rules
 * are the honest ones the design record asks for:
 *
 * - a captain-confirmed miss (C3) is the only *gold* label here: the captain
 *   said out loud that a routine call should have reached him;
 * - an escalation the captain acted on corroborates the `captain` verdict,
 *   and one he dismissed contradicts it (a decision card is dismissed only
 *   when it should not have been raised);
 * - everything else is observed - an absent join is absent evidence, never
 *   counter-evidence. Deriving under-escalation from later trouble is C2's
 *   job, deliberately not this export's.
 */
export function buildSupervisionRecord(row: OutcomeRow, tables: FleetTables): SupervisionRecord {
  const observed = row.verdict === "captain" ? "captain" : "routine";
  const card = row.card_id ? joinCard(row.card_id, row.at, tables) : null;
  const missed = boolOrNull(row.missed_escalation);
  const evidence: string[] = [];
  let confidence: SupervisionRecord["label"]["confidence"] = "observed";
  let basis: SupervisionRecord["label"]["basis"] = "observation";
  let gold: "routine" | "captain" = observed;
  let weak = true;
  const missingCardVersion = Boolean(
    card?.found &&
      (card.description_version?.basis === "unknown" || card.resolution_version?.basis === "unknown"),
  );

  if (missed) {
    gold = "captain";
    weak = false;
    confidence = "confirmed";
    basis = "confirmed-miss";
    evidence.push("captain confirmed this routine verdict was a missed escalation");
  } else if (card?.found) {
    basis = missingCardVersion ? "missing-card-version" : "card-resolution";
    const descriptionShape =
      card.description_version?.basis === "unknown"
        ? "unknown shape"
        : card.decision
          ? "decision"
          : "note";
    const resolutionShape =
      card.resolution_version?.basis === "unknown"
        ? "unknown shape"
        : card.resolution_actions?.length
          ? "decision"
          : "note";
    if (card.resolution === "acted") {
      confidence = "corroborated";
      evidence.push(
        `escalation showed a ${descriptionShape}; its resolution-time ${resolutionShape} was answered with "${card.chosen_action}" (${card.captain_contact})`,
      );
    } else if (card.resolution === "dismissed") {
      confidence = "contradicted";
      evidence.push(
        `escalation showed a ${descriptionShape}; its resolution-time ${resolutionShape} was dismissed with no action taken`,
      );
    } else if (card.resolution === "retired") {
      evidence.push(
        `escalation showed a ${descriptionShape}; the card was withdrawn ("${card.chosen_action}"), so the captain never answered it`,
      );
    } else if (card.resolution === "unknown") {
      evidence.push("escalation card has no persisted version covering its resolution");
    } else {
      evidence.push(`escalation showed a ${descriptionShape}; the card is still open`);
    }
  } else if (row.card_id && !card?.found) {
    evidence.push("card id recorded but no card row found");
  } else if (observed === "captain") {
    evidence.push("escalated with no card join recorded");
  } else {
    evidence.push("routine verdict, no captain contact by design");
  }

  const versioned = Boolean(row.model || row.prompt_sha || row.tools_sha);
  if (!versioned) evidence.push("no provenance stamp (row predates migration 15)");

  return {
    dataset: "supervision",
    outcome_id: row.id,
    at: row.at,
    wake: redactObserveText(row.wake ?? ""),
    wake_kind: row.wake_kind ?? null,
    observed_verdict: observed,
    summary: redactObserveText(row.summary ?? ""),
    steered: boolOrNull(row.steered),
    provenance: {
      model: row.model ?? null,
      prompt_sha: row.prompt_sha ?? null,
      tools_sha: row.tools_sha ?? null,
      versioned,
    },
    task: joinTask(row.task_id, tables),
    card,
    label: {
      gold_verdict: gold,
      weak,
      confidence,
      unknown: weak && basis === "missing-card-version",
      basis,
      missed_escalation: missed,
      missed_note: row.missed_note ? redactObserveText(row.missed_note) : null,
      missed_at: row.missed_at ?? null,
      evidence,
    },
  };
}

// --------------------------------------------------------------------------
// The R2 provenance rows (tables only)
// --------------------------------------------------------------------------

/** The task-event kinds R2 writes for an offline reader (`docs/provenance-capture.md`). */
export const PROVENANCE_EVENT_KINDS = ["decided", "steered", "interrupted"] as const;

export type ProvenanceEventRecord = {
  dataset: "provenance-event";
  event_id: number;
  task_id: string;
  at: number;
  actor: string;
  kind: (typeof PROVENANCE_EVENT_KINDS)[number];
  /** The decision id (`decided`) or the issuing decision (`steered` / `interrupted`). */
  ref: string | null;
  text: string;
  /** `DecisionRecord`, `SteerEventData` or `InterruptEventData`, verbatim; null if unparseable. */
  data: unknown;
};

/**
 * Every `decided` / `steered` / `interrupted` row, verbatim, in timeline
 * order. A database from before R2 (or before the task record) simply has
 * none. The rows are copied, never reinterpreted: joining them is the job
 * of the readers that consume them (G1 above, C2's direct-control class).
 */
export function readProvenanceEvents(dbPath: string): ProvenanceEventRecord[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const present = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).some((row) => row.name === "task_events");
    if (!present) return [];
    const rows = db
      .prepare(
        `SELECT id, task_id, at, actor, kind, ref, text, data_json FROM task_events
         WHERE kind IN (${PROVENANCE_EVENT_KINDS.map(() => "?").join(", ")})
         ORDER BY at ASC, id ASC`,
      )
      .all(...PROVENANCE_EVENT_KINDS) as {
      id: number;
      task_id: string;
      at: number;
      actor: string;
      kind: ProvenanceEventRecord["kind"];
      ref: string | null;
      text: string;
      data_json: string | null;
    }[];
    return rows.map((row) => {
      let data: unknown = null;
      try {
        data = row.data_json ? JSON.parse(row.data_json) : null;
      } catch {
        data = null;
      }
      return {
        dataset: "provenance-event",
        event_id: row.id,
        task_id: row.task_id,
        at: row.at,
        actor: row.actor,
        kind: row.kind,
        ref: row.ref,
        text: row.text,
        data,
      };
    });
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// The routing rollup (intelligence-bucket routing S5)
// --------------------------------------------------------------------------

/**
 * Every task the host commissioned with a work shape, in the form the one
 * home of the routing numbers takes (`scripts/interaction-metrics.ts`). A
 * row without a shape was never routed by the policy - a pre-S2 dispatch,
 * or a task that is not crewmate work - and is left out rather than counted
 * as an unknown tier.
 */
export function routingDispatches(tables: FleetTables): ObservedDispatch[] {
  const completion = completionCards(tables);
  const dispatches: ObservedDispatch[] = [];
  for (const [taskId, task] of tables.tasks) {
    const shape = parseShape(task.shape_json);
    // A policy edit can give queued work a shape without dispatching it.
    // Old databases lack started_at; retain their historical shape reading.
    if (!shape || task.started_at === null) continue;
    const escalation = shape.escalation;
    const from =
      escalation && typeof escalation === "object" && !Array.isArray(escalation)
        ? (escalation as Record<string, unknown>).from
        : null;
    // The rigor half (phase 4). A shaped row commissioned before the tiers
    // existed carries no rigor and shipped at quick, which is the reading
    // the C5 join already takes; a review task ships nothing and reports
    // no rigor at all.
    const rigor =
      shape.kind === "review"
        ? null
        : typeof shape.rigor === "string" && shape.rigor
          ? shape.rigor
          : "quick";
    const delivery = parseShape(task.delivery_json);
    const caps =
      (delivery?.ciCapAt !== undefined ? 1 : 0) +
      (delivery?.reviewCapAt !== undefined ? 1 : 0) +
      (tables.capResets.get(taskId) ?? 0);
    dispatches.push({
      taskId,
      tier: task.difficulty,
      served: tables.routing.get(taskId)?.served ?? null,
      kindSource: typeof shape.kind_source === "string" ? shape.kind_source : null,
      escalatedFrom: typeof from === "string" ? from : null,
      skippedPlanBecause: typeof shape.skipped_plan_because === "string" ? shape.skipped_plan_because : null,
      rigor,
      // What the row DELIVERS (Task B); a row shaped before the axis
      // existed shipped a change, which is what null reads as.
      deliverable: typeof shape.deliverable === "string" ? shape.deliverable : null,
      delivery: typeof delivery?.mode === "string" ? delivery.mode : null,
      hasPr: Boolean(delivery?.prUrl || delivery?.prNumber),
      ciRounds:
        typeof delivery?.ciRounds === "number"
          ? delivery.ciRounds
          : delivery?.ci !== undefined
            ? 0
            : null,
      capHits: caps,
      overrides: tables.overrides.get(taskId) ?? [],
      evidence:
        rigorRequiresEvidence(rigor as Rigor | undefined) && completion.has(taskId)
          ? carriesEvidenceHeadings(reportEvidenceHeadings(task.outcome))
          : null,
    });
  }
  return dispatches;
}

/**
 * Every task that settled with a completion card - one carrying a `settle
 * merge` effect. It is the DENOMINATOR of the evidence share: the contract's
 * five headings are read off the change's report (contract v3.6, captain
 * lock 3 - they left the card's open body and stayed required in the report
 * and the PR body), and only a change that actually shipped is asked for one.
 */
function completionCards(tables: FleetTables): Set<string> {
  const completion = new Set<string>();
  for (const card of tables.cards.values()) {
    if (card.task_id && isCompletionCard(card.actions_json)) completion.add(card.task_id);
  }
  return completion;
}

/**
 * Every verdict a reviewer returned, off the builders' own timelines, with
 * the report text the review task still holds so the findings can be
 * counted (delivery rigor phase 4). Same rows the replay gate scores.
 */
export function rigorReviews(tables: FleetTables): ObservedReview[] {
  const reports = new Map<string, string | null>();
  for (const [taskId, task] of tables.tasks) {
    const shape = parseShape(task.shape_json);
    if (shape?.kind === "review") reports.set(taskId, task.outcome);
  }
  return observedReviews(tables.reviewEvents, reports);
}

export type RigorRollup = {
  /**
   * Dispatches with a rigor to report: every shaped row that SHIPPED work
   * (quick by default). A review task is not one - it read a change.
   */
  dispatches: number;
  by_rigor: Record<string, number>;
  /** Every verdict a reviewer returned, by verdict and by the risk it stated. */
  reviews: number;
  by_verdict: Record<string, number>;
  by_risk: Record<string, number>;
  /** Changes a reviewer read at least once, and changes a cap ever held. */
  reviewed_changes: number;
  cap_hits: number;
  /**
   * How many overrides named each soft hold (INF-484 move 8): the count per
   * kind the weekly audit reads (docs/agents-reach.md). Its total is the
   * `hold_overrides` metric.
   */
  overrides_by_hold: Record<string, number>;
  /** The phase-4 numbers, scored by the one home so the replay agrees with this. */
  metrics: Record<string, number | null>;
};

export function rigorRollup(tables: FleetTables): RigorRollup {
  const dispatches = routingDispatches(tables);
  const reviews = rigorReviews(tables);
  const scores = scoreRigor(dispatches, reviews);
  const shipped = dispatches.filter((dispatch) => dispatch.rigor !== null);
  return {
    dispatches: shipped.length,
    by_rigor: tally(shipped.map((dispatch) => dispatch.rigor)),
    reviews: reviews.length,
    by_verdict: tally(reviews.map((review) => review.verdict)),
    by_risk: tally(reviews.map((review) => review.risk)),
    reviewed_changes: new Set(reviews.map((review) => review.taskId)).size,
    cap_hits: dispatches.reduce((sum, dispatch) => sum + dispatch.capHits, 0),
    overrides_by_hold: overridesByHold(dispatches),
    metrics: Object.fromEntries(
      Object.entries(scores).map(([id, value]) => [id, (value as MetricValue).value]),
    ),
  };
}

export type RoutingRollup = {
  dispatches: number;
  /** The slot the policy asked for, and the slot the ladder served. */
  by_tier: Record<string, number>;
  by_served: Record<string, number>;
  /** The policy row that answered (R0-R10). */
  by_rule: Record<string, number>;
  /** The classifier stamp verbatim, e.g. `classifier:xai/grok-4.6`. */
  by_kind_source: Record<string, number>;
  /** The same stamps folded to their class: classified, abstained, failed, skipped. */
  by_kind_source_class: Record<string, number>;
  escalated_lineages: number;
  /** The S5 numbers, scored by the one home so the replay agrees with this. */
  metrics: Record<string, number | null>;
};

export function routingRollup(tables: FleetTables): RoutingRollup {
  const dispatches = routingDispatches(tables);
  const scores = scoreRouting(dispatches);
  const rules: (string | null)[] = [];
  for (const taskId of tables.tasks.keys()) {
    const routing = tables.routing.get(taskId);
    if (routing) rules.push(routing.rule);
  }
  return {
    dispatches: dispatches.length,
    by_tier: tally(dispatches.map((dispatch) => dispatch.tier)),
    by_served: tally(dispatches.map((dispatch) => dispatch.served)),
    by_rule: tally(rules),
    by_kind_source: tally(dispatches.map((dispatch) => dispatch.kindSource)),
    by_kind_source_class: tally(
      dispatches.map((dispatch) => kindSourceClass(dispatch.kindSource)),
    ),
    escalated_lineages: escalationLineages(dispatches).length,
    metrics: Object.fromEntries(
      Object.entries(scores).map(([id, value]) => [id, (value as MetricValue).value]),
    ),
  };
}

// --------------------------------------------------------------------------
// The export
// --------------------------------------------------------------------------

export type CorpusExportOptions = {
  /** Observe's development gate, verbatim. Required: there is no ungated call path. */
  gate: DevObserveGateInput;
  dbPath?: string;
  sessionsDir?: string;
  /** The Claude-served Firstmate sessions (`firstmate/claude/`, W1 S11). */
  claudeSessionsDir?: string;
  sessionFiles?: string[];
  /** The supervision session's transcripts (G1). */
  supervisionSessionsDir?: string;
  supervisionSessionFiles?: string[];
  /** Directory the corpus files are written into. */
  outDir: string;
  includeOps?: boolean;
  now?: number;
  /**
   * The opt-in human-supervision view (docs/card-evidence.md): lifecycle
   * episodes from the card evidence, a label file, and the pictures they
   * show, read from `userDataDir`. With it the pack is frozen: written
   * whole beside the destination, checked, then published at once, into a
   * destination that must not already hold anything.
   */
  humanSupervision?: boolean;
  userDataDir?: string;
};

export type CorpusManifest = {
  generated_at: string;
  gate: { is_packaged: boolean; dev_observe_override: boolean };
  sources: { db: string | null; transcripts: string[]; supervision_transcripts: string[] };
  supervision: {
    records: number;
    by_verdict: Record<string, number>;
    by_confidence: Record<string, number>;
    confirmed_misses: number;
    with_provenance: number;
    without_provenance: number;
    by_model: Record<string, number>;
    by_prompt_sha: Record<string, number>;
    card_joined: number;
  };
  /** G1: the supervision triage turns, and how each one joined or why it did not. */
  supervision_turns: SupervisionTurnCounts & {
    backup_copies: string[];
    /** Tripwires, e.g. a taskless (`fleet`) outcome row. */
    warnings: string[];
  };
  /** R2's provenance rows, by kind. */
  provenance_events: { records: number; by_kind: Record<string, number> };
  /**
   * How the fleet's work was routed (S5): the tier distribution, the rules
   * that chose it, the classifier stamps, and the four S5 numbers scored by
   * `scripts/interaction-metrics.ts` - the same home the replay gate uses,
   * so a dogfood export and a replay report never disagree about what a
   * downgrade or an escalated lineage is.
   */
  routing: RoutingRollup;
  /**
   * How carefully the fleet shipped (delivery rigor phase 4): the tier
   * distribution, the verdicts the reviewers returned, the holds the caps
   * placed, and the phase-4 numbers scored by the same home the replay gate
   * reads - so a dogfood export and a replay report never disagree about
   * what a review round or a cap hit is.
   */
  rigor: RigorRollup;
  dispatch: {
    records: number;
    by_class: Record<string, number>;
    by_confidence: Record<string, number>;
    /**
     * The contract each turn's own session recorded. An unstamped turn is
     * counted as `unstamped`: the exporter's own version below is kept
     * separate so a historical turn is never dated to the export.
     */
    by_contract_version: Record<string, number>;
    /** Turns whose class rests on nothing but a card's shape. */
    unknown_intent: number;
    /** Copies of a session already read, and the turns they would have
     * double-counted; plus entries a fork copied from its parent. */
    excluded: {
      backup_copies: string[];
      backup_records: number;
      copied_entries: number;
    };
  };
  /** The contract THIS checkout serves - never stamped onto an input. */
  exporter_contract_version: string;
  /** Present only with `--human-supervision`: the view's own section, and each file's checksum. */
  human_supervision?: HumanSupervisionManifest & {
    files: Record<string, { sha256: string; bytes: number; records: number | null }>;
  };
};

export type CorpusExportResult =
  | { status: "blocked"; reason: string }
  /** A frozen pack is never written over: the destination already held something. */
  | { status: "refused"; reason: string }
  | {
      status: "exported";
      outDir: string;
      files: string[];
      manifest: CorpusManifest;
      supervision: SupervisionRecord[];
      supervisionTurns: SupervisionTurnRecord[];
      provenanceEvents: ProvenanceEventRecord[];
      dispatch: DispatchRecord[];
      humanSupervision?: HumanSupervisionPack;
    };

function tally(values: (string | null | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "unstamped";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function jsonl(records: unknown[]): string {
  return records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, jsonl(records));
}

/**
 * The whole command. The gate is checked FIRST, before a single file is read:
 * a packaged build without `INFINITARY_DEV_OBSERVE=1` must not so much as open a
 * transcript.
 */
export function exportCorpus(options: CorpusExportOptions): CorpusExportResult {
  if (!isDevObserveEnabled(options.gate)) {
    return { status: "blocked", reason: `${OBSERVE_DISABLED_MESSAGE}: the corpus export is local-development only` };
  }

  const dbPath = options.dbPath && existsSync(options.dbPath) ? resolve(options.dbPath) : null;
  const tables = dbPath ? readFleetTables(dbPath) : EMPTY_TABLES;
  // Every record is redacted as a whole on the way out, so a credential
  // cannot survive in a field nobody thought to redact - nor in a string
  // this export composed out of two harmless-looking halves.
  const supervision = dbPath
    ? readSupervisionOutcomes(dbPath).map((row) => redactDeep(buildSupervisionRecord(row, tables)))
    : [];

  const turnsResult = extractSupervisionTurns({
    gate: options.gate,
    dbPath: dbPath ?? undefined,
    sessionsDir: options.supervisionSessionsDir,
    sessionFiles: options.supervisionSessionFiles,
  });
  // The gate was checked above with the same input, so this cannot be blocked.
  if (turnsResult.status !== "extracted") return turnsResult;
  const supervisionTurns = turnsResult.records;
  const provenanceEvents = dbPath
    ? readProvenanceEvents(dbPath).map((record) => redactDeep(record))
    : [];

  const dispatchResult = extractDispatchCorpus({
    sessionFiles: options.sessionFiles,
    sessionsDir: options.sessionsDir,
    claudeSessionsDir: options.claudeSessionsDir,
    dbPath: dbPath ?? undefined,
    includeOps: options.includeOps,
  });
  const dispatch = dispatchResult.records.map((record) => redactDeep(record));

  const manifest: CorpusManifest = {
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    gate: {
      is_packaged: options.gate.isPackaged,
      dev_observe_override: settingFrom(options.gate.env ?? {}, "DEV_OBSERVE") === "1",
    },
    sources: {
      db: dbPath,
      transcripts: dispatchResult.sources,
      supervision_transcripts: turnsResult.sources,
    },
    supervision: {
      records: supervision.length,
      by_verdict: tally(supervision.map((r) => r.observed_verdict)),
      by_confidence: tally(supervision.map((r) => r.label.confidence)),
      confirmed_misses: supervision.filter((r) => r.label.missed_escalation).length,
      with_provenance: supervision.filter((r) => r.provenance.versioned).length,
      without_provenance: supervision.filter((r) => !r.provenance.versioned).length,
      by_model: tally(supervision.map((r) => r.provenance.model)),
      by_prompt_sha: tally(supervision.map((r) => r.provenance.prompt_sha)),
      card_joined: supervision.filter((r) => r.card?.found).length,
    },
    supervision_turns: {
      ...turnsResult.counts,
      backup_copies: turnsResult.backupCopies,
      warnings: turnsResult.warnings,
    },
    provenance_events: {
      records: provenanceEvents.length,
      by_kind: tally(provenanceEvents.map((r) => r.kind)),
    },
    routing: routingRollup(tables),
    rigor: rigorRollup(tables),
    dispatch: {
      records: dispatch.length,
      by_class: tally(dispatch.map((r) => r.observed_class)),
      by_confidence: tally(dispatch.map((r) => r.label.confidence)),
      by_contract_version: tally(dispatch.map((r) => r.contract?.version ?? null)),
      unknown_intent: dispatch.filter((r) => r.label.unknown).length,
      excluded: {
        backup_copies: dispatchResult.backupCopies,
        backup_records: dispatchResult.backupRecordsExcluded,
        copied_entries: dispatchResult.copiedEntriesExcluded,
      },
    },
    exporter_contract_version: FIRSTMATE_CONTRACT_VERSION,
  };

  const outDir = resolve(options.outDir);
  if (!options.humanSupervision) {
    const redactedManifest = redactDeep(manifest);
    mkdirSync(outDir, { recursive: true });
    const supervisionFile = join(outDir, "supervision.jsonl");
    const turnsFile = join(outDir, "supervision-turns.jsonl");
    const provenanceFile = join(outDir, "decisions.jsonl");
    const dispatchFile = join(outDir, "dispatch.jsonl");
    const manifestFile = join(outDir, "manifest.json");
    writeJsonl(supervisionFile, supervision);
    writeJsonl(turnsFile, supervisionTurns);
    writeJsonl(provenanceFile, provenanceEvents);
    writeJsonl(dispatchFile, dispatch);
    writeFileSync(manifestFile, `${JSON.stringify(redactedManifest, null, 2)}\n`);

    return {
      status: "exported",
      outDir,
      files: [supervisionFile, turnsFile, provenanceFile, dispatchFile, manifestFile],
      manifest: redactedManifest,
      supervision,
      supervisionTurns,
      provenanceEvents,
      dispatch,
    };
  }

  // The frozen pack (docs/card-evidence.md, "The export"): a destination
  // that already holds anything is refused - a reviewed freeze is never
  // written over - and the pack is staged beside it, checked, and published
  // with one rename, so a partial pack is never where a whole one would be.
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    return {
      status: "refused",
      reason: `${outDir} is not empty: a human-supervision pack is written only into a new or empty directory`,
    };
  }
  const pack = buildHumanSupervision({
    dbPath,
    userDataDir: resolve(options.userDataDir ?? (dbPath ? dirname(dbPath) : ".")),
  });
  const dangling = danglingAssets(pack);
  if (dangling.length > 0) {
    throw new Error(`human-supervision pack references assets it does not ship: ${dangling.join(", ")}`);
  }
  mkdirSync(dirname(outDir), { recursive: true });
  const staging = mkdtempSync(join(dirname(outDir), `.${basename(outDir)}.staging-`));
  try {
    const texts: [string, string, number | null][] = [
      ["supervision.jsonl", jsonl(supervision), supervision.length],
      ["supervision-turns.jsonl", jsonl(supervisionTurns), supervisionTurns.length],
      ["decisions.jsonl", jsonl(provenanceEvents), provenanceEvents.length],
      ["dispatch.jsonl", jsonl(dispatch), dispatch.length],
      [HUMAN_SUPERVISION_FILE, jsonl(pack.episodes), pack.episodes.length],
      [HUMAN_SUPERVISION_LABELS_FILE, jsonl(pack.labels), pack.labels.length],
    ];
    const files: Record<string, { sha256: string; bytes: number; records: number | null }> = {};
    for (const [name, text, records] of texts) {
      writeFileSync(join(staging, name), text);
      files[name] = { sha256: sha256Of(text), bytes: Buffer.byteLength(text), records };
    }
    for (const asset of pack.assets) {
      const to = join(staging, asset.to);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(asset.from, to);
      const bytes = readFileSync(to);
      files[asset.to] = { sha256: sha256Of(bytes), bytes: bytes.byteLength, records: null };
    }
    const redactedManifest = redactDeep({
      ...manifest,
      human_supervision: { ...pack.manifest, files },
    });
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(redactedManifest, null, 2)}\n`);
    if (existsSync(outDir)) rmdirSync(outDir);
    renameSync(staging, outDir);
    return {
      status: "exported",
      outDir,
      files: [...Object.keys(files), "manifest.json"].map((name) => join(outDir, name)),
      manifest: redactedManifest,
      supervision,
      supervisionTurns,
      provenanceEvents,
      dispatch,
      humanSupervision: pack,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

/**
 * The script's half of Observe's gate. There is no Electron `app` here, so
 * packaged-ness is read off where this file actually sits: a packaged build
 * ships the git-tracked tree as `Contents/Resources/self-source/` (and its
 * code inside `app.asar`), while a checkout does not. `INFINITARY_PACKAGED=1`
 * can only ever tighten the answer - nothing may declare itself unpackaged.
 */
export function detectPackaged(input: {
  moduleUrl: string;
  env?: Record<string, string | undefined>;
}): boolean {
  if (settingFrom(input.env ?? {}, "PACKAGED") === "1") return true;
  const path = input.moduleUrl.startsWith("file:")
    ? fileURLToPath(input.moduleUrl)
    : input.moduleUrl;
  return path.includes("app.asar") || path.includes("/Contents/Resources/");
}

export type CliArgs = {
  userData: string;
  sessionsDir: string;
  claudeSessionsDir: string;
  supervisionSessionsDir: string;
  dbPath: string;
  sessionFiles: string[];
  outDir: string;
  includeOps: boolean;
  humanSupervision: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let sessionsDir: string | null = null;
  let claudeSessionsDir: string | null = null;
  let supervisionSessionsDir: string | null = null;
  let dbPath: string | null = null;
  const sessionFiles: string[] = [];
  let outDir: string | null = null;
  let includeOps = true;
  let humanSupervision = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // pnpm forwards its own `--` separator; it is not an argument.
    if (arg === "--") continue;
    if (arg === "--user-data") userData = next();
    else if (arg === "--sessions") sessionsDir = next();
    else if (arg === "--claude-sessions") claudeSessionsDir = next();
    else if (arg === "--supervision-sessions") supervisionSessionsDir = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--session-file") sessionFiles.push(next());
    else if (arg === "--out" || arg === "-o") outDir = next();
    else if (arg === "--user-turns-only") includeOps = false;
    else if (arg === "--human-supervision") humanSupervision = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!help && !outDir) throw new Error("--out <dir> is required");
  return {
    userData,
    sessionsDir: sessionsDir ?? join(userData, "firstmate", "sessions"),
    claudeSessionsDir: claudeSessionsDir ?? join(userData, "firstmate", "claude"),
    supervisionSessionsDir: supervisionSessionsDir ?? join(userData, "supervision", "sessions"),
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    sessionFiles,
    outDir: outDir ?? "",
    includeOps,
    humanSupervision,
    help,
  };
}

const USAGE = `Package the Infinitary capture into an eval/training corpus (PoC-2 C4).

  pnpm export:corpus --out <dir>      (or: node scripts/export-corpus.ts --out <dir>)

  --user-data <dir>     app userData dir (default: the platform userData path,
                        or INFINITARY_USER_DATA_DIR); an exported copy works too
  --sessions <dir>      transcripts dir (default: <user-data>/firstmate/sessions)
  --claude-sessions <dir>
                        Claude-served transcripts (default: <user-data>/firstmate/claude)
  --supervision-sessions <dir>
                        pre-S7c archives only (default: <user-data>/supervision/sessions)
  --db <path>           firstmate.db (default: <user-data>/firstmate.db)
  --session-file <path> one transcript; repeatable, overrides --sessions
  --out, -o <dir>       write supervision.jsonl, supervision-turns.jsonl,
                        decisions.jsonl, dispatch.jsonl, manifest.json here
  --user-turns-only     drop [fm-op] operational wakes from the dispatch set
  --human-supervision   also write human-supervision.jsonl (one episode per card
                        lifecycle), human-supervision-labels.jsonl and the
                        pictures they show, and freeze the pack: --out must be a
                        new or empty directory (docs/card-evidence.md)
  --help, -h

Local development only: this command needs an unpackaged build, or an explicit
INFINITARY_DEV_OBSERVE=1 (docs/dev-observe.md, "Hard gate"). It reads what the app
already wrote and writes local files; nothing leaves the box.
The supervision-turn reader is for pre-S7c exports only: the app no longer writes
supervision transcripts. Current whose-turn outcomes still appear in supervision.jsonl;
supervision-turns.jsonl keeps rows without transcripts and explains missing joins.
--human-supervision is current card evidence, not the retired supervision session.`;

export function summarize(result: Extract<CorpusExportResult, { status: "exported" }>): string {
  const { manifest } = result;
  const classes = Object.entries(manifest.dispatch.by_class)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  return [
    `db: ${manifest.sources.db ?? "none (supervision set empty)"}`,
    `transcripts: ${manifest.sources.transcripts.length}`,
    `supervision: ${manifest.supervision.records} rows ` +
      `(${manifest.supervision.with_provenance} stamped, ` +
      `${manifest.supervision.confirmed_misses} confirmed miss(es), ` +
      `${manifest.supervision.card_joined} card join(s))`,
    `supervision turns (pre-S7c archive reader only): ${manifest.supervision_turns.records} ` +
      `(${Object.entries(manifest.supervision_turns.by_join_basis)
        .map(([basis, count]) => `${basis}=${count}`)
        .join(" ") || "none"}; ` +
      `${manifest.supervision_turns.unjoined_rows} unjoined row(s), ` +
      `${manifest.supervision_turns.unjoined_turns} unjoined turn(s), each with its reason)`,
    `provenance events: ${manifest.provenance_events.records}`,
    ...manifest.supervision_turns.warnings.map((warning) => `warning: ${warning}`),
    `dispatch: ${manifest.dispatch.records} turns${classes ? ` [${classes}]` : ""}` +
      ` (${manifest.dispatch.unknown_intent} with no gold intent)`,
    `excluded: ${manifest.dispatch.excluded.backup_copies.length} backup copy/copies ` +
      `(${manifest.dispatch.excluded.backup_records} turn(s)), ` +
      `${manifest.dispatch.excluded.copied_entries} copied entry/entries`,
    ...humanSupervisionSummary(manifest.human_supervision),
    `wrote: ${result.files.join(", ")}`,
  ].join("\n");
}

/** Counts, exclusions and the cutoff: never a body, an answer or a thread line. */
function humanSupervisionSummary(section: CorpusManifest["human_supervision"]): string[] {
  if (!section) return [];
  const pairs = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([name, count]) => `${name}=${count}`)
      .join(" ") || "none";
  return [
    `human supervision: ${section.counts.episodes} episode(s) [${pairs(section.counts.by_basis)}], ` +
      `${section.counts.interactions} interaction(s), cutoff seq ${section.cutoff.seq}`,
    `  display: ${pairs(section.counts.by_display)}; questions: ${pairs(section.counts.questions)}`,
    `  missing: ${pairs(section.counts.missing)}`,
    `  excluded: ${section.exclusions.map((entry) => `${entry.reason}=${entry.seqs.length}`).join(" ") || "none"}; ` +
      `uncovered cards: ${section.capture.uncovered_cards}`,
    `  rights: ${section.rights.scope}, external use ${section.rights.external_use}`,
  ];
}

export function main(
  argv: string[],
  gate: DevObserveGateInput = {
    isPackaged: detectPackaged({ moduleUrl: import.meta.url, env: process.env }),
    env: process.env,
  },
): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = exportCorpus({
    gate,
    dbPath: args.dbPath,
    sessionsDir: args.sessionsDir,
    claudeSessionsDir: args.claudeSessionsDir,
    sessionFiles: args.sessionFiles,
    supervisionSessionsDir: args.supervisionSessionsDir,
    outDir: args.outDir,
    includeOps: args.includeOps,
    humanSupervision: args.humanSupervision,
    userDataDir: args.userData,
  });
  if (result.status === "blocked") {
    process.stderr.write(`${result.reason}.\n`);
    return 3;
  }
  if (result.status === "refused") {
    process.stderr.write(`${result.reason}.\n`);
    return 4;
  }
  process.stderr.write(`${summarize(result)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
