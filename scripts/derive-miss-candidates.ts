/**
 * C2 - the retrospective miss deriver (PoC-2 capture; design record
 * `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3).
 *
 * For every `supervision_outcomes` row with `verdict='routine'` on task T
 * at time t, look forward in a window (default 24h). If T subsequently
 * produced a captain-escalated outcome, a `turn_failed`, a task failure,
 * a captain-resolved card (including card-derived steer/interrupt contact),
 * or a recorded interruption wake on T, the earlier routine is a **candidate
 * miss**, carrying the later evidence as its rationale. Since R2 the control
 * plane also records direct steers and interrupts as task events; a captain
 * steer via a card, a Firstmate steer via its tool, or a captain interrupt is
 * `direct_control` evidence, and a later captain verdict whose R2 decision
 * handed an escalation to the Firstmate carries what that Firstmate decision
 * did with it (`escalation_outcome`). Both are forward-only: a database from
 * before R2 has neither event and derives exactly as it always did.
 *
 * Offline, tables-only, zero UI. Reads the existing schema; writes an
 * OUTPUT ARTIFACT (JSONL), never C3's confirmed-miss columns
 * (`missed_escalation` / `missed_note` / `missed_at`). Every record is
 * labelled weak/unconfirmed: a task can legitimately deteriorate after a
 * correct routine call, and a flagship judge confirms these in bulk.
 *
 * Run it (Node 24 strips the types):
 *   pnpm derive:misses --db /path/to/firstmate.db --out candidates.jsonl
 *   pnpm derive:misses --user-data /path/to/exported/userData --out candidates.jsonl
 *
 * The live firstmate.db lives on whichever machine the captain dogfoods on,
 * so every input is a parameter: point `--db` (or `--user-data`) at an
 * exported copy and the same run works anywhere. No hardcoded userData path.
 */

import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep, redactObserveText } from "../src/core/observe/redact.ts";
import {
  type CardRevisionRow,
  cardVersionAt,
  chosenEffectOf,
  declaredActionsOf,
  resolutionOf,
} from "./dispatch-corpus/cards.ts";
import { actionOf } from "./dispatch-corpus/fleetTables.ts";
import { defaultUserDataDir } from "./dispatch-corpus/userData.ts";

/** The report's proposed window; overridable so a fixture can be tiny. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Card actions that abort a crewmate. These were reserved ids under the
 * pre-P1 contract; nothing emits them now, and a card that carries one is
 * read as the history it is.
 */
const INTERRUPT_ACTIONS = new Set(["interrupt-task", "cancel-task"]);

export type EvidenceKind =
  | "captain_escalation"
  | "turn_failed"
  | "task_failure"
  | "captain_resolved_card"
  | "captain_steer"
  | "captain_interrupt"
  | "interruption"
  | "direct_control";

/**
 * What the Firstmate decision that consumed an escalation did with it (R2's
 * `handoffInboxId` chain): raised a card, steered or interrupted the task, or
 * neither. Weak, like everything here: "none" can be a correct call.
 */
export type EscalationOutcome = {
  /** The supervision decision that escalated. */
  supervision_decision: string;
  handoff_inbox_id: number;
  /** The Firstmate decision whose wake segment lists that inbox row; null if none was recorded. */
  firstmate_decision: string | null;
  class: "card" | "steer" | "none";
  outcome: string | null;
  cards: string[];
  tool_calls: string[];
  /** Steers and interrupts that decision issued on any task (their `ref`). */
  controls: { kind: "steered" | "interrupted"; task_id: string; actor: string }[];
  at: number | null;
};

export type Evidence = {
  kind: EvidenceKind;
  at: number;
  /** Human-readable why this row/card counts, for the flagship judge. */
  rationale: string;
  outcome_id?: number;
  card_id?: string;
  wake?: string;
  summary?: string;
  wake_kind?: string | null;
  chosen_action?: string | null;
  resolution?: "acted" | "dismissed";
  created_at?: number;
  actor?: "unknown" | "captain" | "firstmate";
  /** direct_control: which R2 event, how it arrived, and what it did. */
  event_id?: number;
  event_kind?: "steered" | "interrupted";
  via?: string | null;
  effect?: string | null;
  decision?: string | null;
  /** captain_escalation: the Firstmate decision that consumed the handoff (R2 only). */
  escalation_outcome?: EscalationOutcome;
};

export type RoutineOutcome = {
  outcome_id: number;
  task_id: string;
  at: number;
  wake: string;
  summary: string;
  card_id: string | null;
  model: string | null;
  prompt_sha: string | null;
  tools_sha: string | null;
  steered: boolean | null;
  wake_kind: string | null;
  /**
   * Observation only: C3 may already have stamped this row. C2 never
   * writes those columns, and a C3 flag does not make this candidate
   * confirmed - that stamp is a different, captain-gated path.
   */
  c3_flagged: boolean;
};

/**
 * One candidate under-escalation. `label.weak` is always true and
 * `label.confirmed` is always false: this deriver produces weak labels
 * for a later judge, never gold.
 */
export type CandidateMiss = {
  id: string;
  task_id: string;
  task_title: string | null;
  task_status: string | null;
  window: { start: number; end: number; ms: number };
  routine: RoutineOutcome;
  evidence: Evidence[];
  rationale: string;
  label: {
    kind: "under_escalation";
    weak: true;
    confirmed: false;
    confidence: "unconfirmed";
  };
};

type OutcomeRow = {
  id: number;
  task_id: string;
  wake: string;
  verdict: string;
  summary: string;
  at: number;
  card_id: string | null;
  model: string | null;
  prompt_sha: string | null;
  tools_sha: string | null;
  steered: number | null;
  wake_kind: string | null;
  missed_escalation: number | null;
  /** The recorded wake's typed facts (the decision ledger, P6); null for prose and older rows. */
  facts_json: string | null;
};

type CardRow = {
  id: string;
  task_id: string;
  kind: string;
  author: string | null;
  /** The declared actions: what the captain's click actually meant. */
  actions_json: string;
  title: string;
  body: string;
  created_at: number;
  resolved_at: number;
  chosen_action: string | null;
};

type TaskRow = { id: string; title: string; status: string };

type CardResolutionEvent = { actor: string; action?: string };

/** One R2 `steered` or `interrupted` task event (`docs/provenance-capture.md` §3). */
export type ControlEvent = {
  id: number;
  task_id: string;
  at: number;
  actor: string;
  kind: "steered" | "interrupted";
  ref: string | null;
  data: {
    via?: string;
    outcome?: string;
    effect?: string;
    mode?: string;
    cardId?: string | null;
    decision?: string | null;
  };
};

/** The parts of an R2 `decided` record the handoff chain reads. */
export type DecisionEvent = {
  decision: string;
  role: string;
  at: number;
  outcome: string | null;
  inbox: string | null;
  outcomeId: number | null;
  handoffInboxId: number | null;
  /** Inbox rows the served prompt's segments were delivered from. */
  inboxIds: number[];
  cards: string[];
  toolCalls: string[];
};

export type Tables = {
  outcomes: OutcomeRow[];
  cards: CardRow[];
  cardRevisions: Map<string, CardRevisionRow[]>;
  tasks: Map<string, TaskRow>;
  cardResolutions: Map<string, CardResolutionEvent>;
  /** R2 forward capture; empty on a database from before it. */
  controls?: ControlEvent[];
  decisions?: DecisionEvent[];
};

export const EMPTY_TABLES: Tables = {
  outcomes: [],
  cards: [],
  cardRevisions: new Map(),
  tasks: new Map(),
  cardResolutions: new Map(),
  controls: [],
  decisions: [],
};

export type DeriveOptions = {
  dbPath: string;
  windowMs?: number;
};

export type DeriveResult = {
  candidates: CandidateMiss[];
  /**
   * Every captain verdict whose R2 decision handed off an escalation, with
   * what the consuming Firstmate decision did (over-escalation evidence).
   * Empty (or absent) on a database from before R2.
   */
  escalations?: EscalationRecord[];
  dbPath: string;
  windowMs: number;
  routineCount: number;
};

/**
 * Host-written failed-turn op (CrewTurns.turnComplete):
 * `[fm-op] ${crewmate}'s turn on task ${id} "${title}" failed: ${error}`
 */
export function isTurnFailedWake(wake: string, taskId: string): boolean {
  return wakeIncludes(wake, `turn on task ${taskId} `, " failed:");
}

/**
 * Host-written terminal-failure op (CrewSessions.finish):
 * `[fm-op] task ${id} "${title}" failed: ${error}`
 * Distinct from the turn-failed form, which also contains `task ${id}`.
 */
export function isTaskFailedWake(wake: string, taskId: string): boolean {
  if (isTurnFailedWake(wake, taskId)) return false;
  return wakeIncludes(wake, `task ${taskId} `, " failed:");
}

/**
 * Historical host-written interrupt receipt (CrewTurns.turnComplete):
 * `[fm-op] ${crewmate} was interrupted on task ${id} "${title}"; …`
 * The text carries no actor. Today this receipt follows the Firstmate's own
 * interrupt tool and is a feed line, but old outcomes can still contain it.
 */
export function isInterruptWake(wake: string, taskId: string): boolean {
  return wake.includes(`interrupted on task ${taskId}`);
}

/**
 * What a ledger row's wake was, when it recorded a typed one (P6): its
 * facts' kind and task. Null for a prose wake and for every row written
 * before the ledger carried facts, which are read by their words.
 */
function outcomeFacts(row: OutcomeRow): { kind: string; taskId: string | null } | null {
  if (!row.facts_json) return null;
  try {
    const facts = JSON.parse(row.facts_json) as { kind?: unknown; task?: { id?: unknown } };
    if (typeof facts?.kind !== "string") return null;
    return {
      kind: facts.kind,
      taskId: typeof facts.task?.id === "string" ? facts.task.id : null,
    };
  } catch {
    return null;
  }
}

function wakeIncludes(wake: string, needle: string, also: string): boolean {
  const at = wake.indexOf(needle);
  if (at < 0) return false;
  return wake.indexOf(also, at + needle.length) >= 0;
}

/**
 * The spec's "captain steer/interrupt" vs "captain-resolved card", grounded
 * in `CardActions.act` and read off the card's OWN declared actions.
 *
 * Only one branch of act() ever reaches the crewmate as a steering message:
 * a chosen action with NO effect on a card that has a task. An action
 * carrying a `settle` effect is host-owned teardown and an `open` effect is
 * shell navigation - both are the captain resolving the card, neither is a
 * steer. The reserved-id table this replaces had no way to tell them apart,
 * so every modern settle button ("merge-pr", "land-it", …) was counted as a
 * steer that never happened.
 *
 * A withdrawal (the emitter's `close_card`, a duplicate, a settled task
 * retiring its cards) is not captain contact at all.
 */
export function cardEvidenceKind(
  card: {
    id: string;
    kind: string;
    author?: string | null;
    chosen_action: string | null;
    actions_json?: string | null;
    resolved_at?: number | null;
  },
  event?: { actor: string; action?: string } | null,
): EvidenceKind | null {
  const chosen = card.chosen_action;
  const legacy = card.kind !== "card";
  const resolution = resolutionOf(
    {
      resolved_at: card.resolved_at ?? 1,
      chosen_action: chosen,
      actions_json: card.actions_json ?? null,
    },
    event,
    { legacy },
  );
  if (resolution === "retired") return null;
  if (legacy && chosen && INTERRUPT_ACTIONS.has(chosen)) return "captain_interrupt";
  const { captain_contact } = chosenEffectOf(
    declaredActionsOf(card.actions_json),
    chosen,
    resolution,
    { legacy, cardId: card.id, author: card.author },
  );
  return captain_contact === "steer" ? "captain_steer" : "captain_resolved_card";
}

export function inForwardWindow(
  at: number,
  id: number,
  originAt: number,
  originId: number,
  windowMs: number,
): boolean {
  if (at > originAt + windowMs) return false;
  if (at > originAt) return true;
  // Same millisecond: a later INSERT on the same task is still subsequent.
  return at === originAt && id > originId;
}

function evidenceFromOutcome(row: OutcomeRow, taskId: string): Evidence[] {
  const items: Evidence[] = [];
  // A typed wake is read by its facts, which name its kind and task; prose
  // and older rows by the host's own wording. No typed wake is an
  // interrupt receipt: that wording is history.
  const facts = outcomeFacts(row);
  const turnFailed = facts
    ? facts.kind === "turn-failed" && facts.taskId === taskId
    : isTurnFailedWake(row.wake, taskId);
  const taskFailed = facts
    ? facts.kind === "task-failed" && facts.taskId === taskId
    : isTaskFailedWake(row.wake, taskId);
  const interrupted = facts ? false : isInterruptWake(row.wake, taskId);
  const wake = redactObserveText(row.wake);
  const summary = redactObserveText(row.summary);
  if (row.verdict === "captain") {
    items.push({
      kind: "captain_escalation",
      at: row.at,
      outcome_id: row.id,
      wake,
      summary,
      wake_kind: row.wake_kind,
      rationale: `later captain verdict #${row.id}: ${summary || wake}`,
    });
  }
  if (turnFailed) {
    items.push({
      kind: "turn_failed",
      at: row.at,
      outcome_id: row.id,
      wake,
      wake_kind: row.wake_kind,
      rationale: `later turn_failed wake #${row.id}: ${wake}`,
    });
  }
  if (taskFailed) {
    items.push({
      kind: "task_failure",
      at: row.at,
      outcome_id: row.id,
      wake,
      wake_kind: row.wake_kind,
      rationale: `later task failure wake #${row.id}: ${wake}`,
    });
  }
  if (interrupted && row.verdict !== "captain") {
    // The historical wake proves interruption but names no actor; it follows
    // the Firstmate's tool, so captain attribution would fabricate evidence.
    items.push({
      kind: "interruption",
      actor: "unknown",
      at: row.at,
      outcome_id: row.id,
      wake,
      rationale: `task interrupted in later wake #${row.id}; the record does not say by whom: ${wake}`,
    });
  }
  return items;
}

function evidenceFromCard(
  card: CardRow,
  revisions: CardRevisionRow[],
  event?: CardResolutionEvent,
): Evidence | null {
  const version = cardVersionAt(card, revisions, card.resolved_at);
  if (!version) return null;
  const versionedCard = {
    ...card,
    kind: version.kind,
    title: version.title,
    actions_json: version.actions_json,
  };
  const kind = cardEvidenceKind(versionedCard, event);
  if (!kind) return null;
  const title = redactObserveText(version.title);
  const resolved = resolutionOf(
    {
      resolved_at: card.resolved_at,
      chosen_action: card.chosen_action,
      actions_json: version.actions_json,
    },
    event,
    { legacy: version.kind !== "card" },
  );
  const resolution = resolved === "acted" ? "acted" : "dismissed";
  const action = card.chosen_action ?? "none";
  const rationale =
    kind === "captain_interrupt"
      ? `captain ${action} on card ${card.id} "${title}"`
      : kind === "captain_steer"
        ? `captain steered via card ${card.id} "${title}" (chose ${action})`
        : `captain resolved card ${card.id} "${title}" with ${action}`;
  return {
    kind,
    at: card.resolved_at,
    card_id: card.id,
    chosen_action: card.chosen_action,
    resolution,
    created_at: card.created_at,
    rationale,
  };
}

/**
 * R2's direct-control class. Only what the captain or the Firstmate did
 * counts: a captain steer arrives through a card action or a task card's
 * Continue, a Firstmate steer through its tool, and an interrupt is the
 * captain's own (the shell's abort, a card's or a task card's Drop task).
 * A supervisor steer is the triage itself, and a Firstmate interrupt is its
 * own call, not captain contact - neither is evidence here.
 */
export function directControlEvidence(event: ControlEvent): Evidence | null {
  const via = event.data.via ?? null;
  if (event.kind === "steered") {
    const captainCard = event.actor === "captain" && (via === "card" || via === "task-card");
    const firstmateTool = event.actor === "firstmate" && via === "tool";
    if (!captainCard && !firstmateTool) return null;
    const card = event.data.cardId ? ` card ${event.data.cardId}` : "";
    return {
      kind: "direct_control",
      at: event.at,
      event_id: event.id,
      event_kind: "steered",
      actor: event.actor as "captain" | "firstmate",
      via,
      effect: event.data.outcome ?? null,
      decision: event.data.decision ?? event.ref,
      ...(event.data.cardId ? { card_id: event.data.cardId } : {}),
      rationale: `${event.actor} steered the task via ${via}${card} (${event.data.outcome ?? "unknown delivery"})`,
    };
  }
  if (event.actor !== "captain") return null;
  return {
    kind: "direct_control",
    at: event.at,
    event_id: event.id,
    event_kind: "interrupted",
    actor: "captain",
    via,
    effect: event.data.effect ?? null,
    decision: event.data.decision ?? event.ref,
    rationale: `captain ${event.data.mode === "cancel" ? "cancelled" : "interrupted"} the task (${event.data.effect ?? "unknown effect"})`,
  };
}

/**
 * An abort records `requested` before the transport call and its effect after;
 * the pair is one interrupt, so a `requested` row whose effect follows is
 * folded into it.
 */
function controlsForEvidence(events: ControlEvent[]): ControlEvent[] {
  return events.filter((event, index) => {
    if (event.kind !== "interrupted" || event.data.effect !== "requested") return true;
    return !events
      .slice(index + 1)
      .some(
        (later) =>
          later.kind === "interrupted" &&
          later.task_id === event.task_id &&
          later.actor === event.actor &&
          (later.data.effect === "aborted-turn" || later.data.effect === "abort-failed"),
      );
  });
}

/**
 * Follow a captain verdict's handoff to the Firstmate decision that consumed
 * it. Null when no supervision decision recorded a handoff for the row (every
 * row before R2), so history derives unchanged.
 */
export function escalationOutcomeFor(
  outcomeId: number,
  decisions: DecisionEvent[],
  controls: ControlEvent[],
): EscalationOutcome | null {
  const escalation = decisions.find(
    (decision) =>
      decision.role === "supervision" &&
      decision.outcomeId === outcomeId &&
      decision.handoffInboxId !== null,
  );
  if (!escalation || escalation.handoffInboxId === null) return null;
  const handoff = escalation.handoffInboxId;
  const attempts = decisions.filter(
    (decision) => decision.role === "firstmate" && decision.inboxIds.includes(handoff),
  );
  if (attempts.length === 0) {
    return {
      supervision_decision: escalation.decision,
      handoff_inbox_id: handoff,
      firstmate_decision: null,
      class: "none",
      outcome: null,
      cards: [],
      tool_calls: [],
      controls: [],
      at: null,
    };
  }
  const handled = attempts.filter((decision) => decision.inbox === "acked");
  const consumer = (handled.length > 0 ? handled : attempts).reduce((latest, decision) =>
    decision.at >= latest.at ? decision : latest,
  );
  const attemptIds = new Set(attempts.map((decision) => decision.decision));
  const cards = [...new Set(attempts.flatMap((decision) => decision.cards))];
  const toolCalls = [...new Set(attempts.flatMap((decision) => decision.toolCalls))];
  const issued = controls
    .filter((event) => event.ref !== null && attemptIds.has(event.ref))
    .map((event) => ({ kind: event.kind, task_id: event.task_id, actor: event.actor }));
  return {
    supervision_decision: escalation.decision,
    handoff_inbox_id: handoff,
    firstmate_decision: consumer.decision,
    class: cards.length > 0 ? "card" : issued.length > 0 ? "steer" : "none",
    outcome: consumer.outcome,
    cards,
    tool_calls: toolCalls,
    controls: issued,
    at: consumer.at,
  };
}

function toRoutine(row: OutcomeRow): RoutineOutcome {
  return {
    outcome_id: row.id,
    task_id: row.task_id,
    at: row.at,
    wake: redactObserveText(row.wake),
    summary: redactObserveText(row.summary),
    card_id: row.card_id,
    model: row.model,
    prompt_sha: row.prompt_sha,
    tools_sha: row.tools_sha,
    steered: row.steered == null ? null : row.steered !== 0,
    wake_kind: row.wake_kind,
    c3_flagged: row.missed_escalation != null && row.missed_escalation !== 0,
  };
}

export type EscalationRecord = {
  id: string;
  task_id: string;
  outcome_id: number;
  at: number;
  summary: string;
  escalation_outcome: EscalationOutcome;
  label: { kind: "escalation_outcome"; weak: true; confirmed: false };
};

/** The captain verdicts R2 can follow to their Firstmate decision, in outcome order. */
export function deriveEscalations(tables: Tables): EscalationRecord[] {
  const decisions = tables.decisions ?? [];
  if (decisions.length === 0) return [];
  const records: EscalationRecord[] = [];
  for (const row of tables.outcomes) {
    if (row.verdict !== "captain") continue;
    const outcome = escalationOutcomeFor(row.id, decisions, controlsForEvidence(tables.controls ?? []));
    if (!outcome) continue;
    records.push(
      redactDeep({
        id: `captain#${row.id}`,
        task_id: row.task_id,
        outcome_id: row.id,
        at: row.at,
        summary: redactObserveText(row.summary),
        escalation_outcome: outcome,
        label: { kind: "escalation_outcome", weak: true, confirmed: false },
      }),
    );
  }
  return records;
}

/** Pure derivation over already-loaded tables. The CLI reads; tests fixture. */
export function deriveFromTables(tables: Tables, windowMs: number): CandidateMiss[] {
  const candidates: CandidateMiss[] = [];
  const byTask = new Map<string, OutcomeRow[]>();
  for (const row of tables.outcomes) {
    const bucket = byTask.get(row.task_id) ?? [];
    bucket.push(row);
    byTask.set(row.task_id, bucket);
  }
  const cardsByTask = new Map<string, CardRow[]>();
  for (const card of tables.cards) {
    const bucket = cardsByTask.get(card.task_id) ?? [];
    bucket.push(card);
    cardsByTask.set(card.task_id, bucket);
  }
  const controls = tables.controls ?? [];
  const decisions = tables.decisions ?? [];
  const controlsByTask = new Map<string, ControlEvent[]>();
  for (const event of controls) {
    const bucket = controlsByTask.get(event.task_id) ?? [];
    bucket.push(event);
    controlsByTask.set(event.task_id, bucket);
  }
  for (const row of tables.outcomes) {
    if (row.verdict !== "routine") continue;
    const end = row.at + windowMs;
    const evidence: Evidence[] = [];
    for (const later of byTask.get(row.task_id) ?? []) {
      if (later.id === row.id) continue;
      if (!inForwardWindow(later.at, later.id, row.at, row.id, windowMs)) continue;
      for (const item of evidenceFromOutcome(later, row.task_id)) {
        if (item.kind === "captain_escalation") {
          const chained = escalationOutcomeFor(later.id, decisions, controlsForEvidence(controls));
          if (chained) item.escalation_outcome = chained;
        }
        evidence.push(item);
      }
    }
    const windowControls = (controlsByTask.get(row.task_id) ?? []).filter(
      (event) => event.at > row.at && event.at <= end,
    );
    for (const event of controlsForEvidence(windowControls)) {
      const item = directControlEvidence(event);
      if (item) evidence.push(item);
    }
    for (const card of cardsByTask.get(row.task_id) ?? []) {
      // "T subsequently produced" a card: created after the routine, and
      // the captain resolved it inside the window.
      if (card.created_at <= row.at) continue;
      if (card.resolved_at <= row.at || card.resolved_at > end) continue;
      const item = evidenceFromCard(
        card,
        tables.cardRevisions.get(card.id) ?? [],
        tables.cardResolutions.get(card.id),
      );
      if (item) evidence.push(item);
    }
    if (evidence.length === 0) continue;
    evidence.sort((a, b) => a.at - b.at || (a.outcome_id ?? 0) - (b.outcome_id ?? 0));
    const task = tables.tasks.get(row.task_id);
    // One recursive pass over the finished candidate: a credential cannot
    // survive in a rationale this deriver composed out of redacted halves.
    candidates.push(
      redactDeep({
      id: `routine#${row.id}`,
      task_id: row.task_id,
      task_title: task?.title ?? null,
      task_status: task?.status ?? null,
      window: { start: row.at, end, ms: windowMs },
      routine: toRoutine(row),
      evidence,
      rationale: evidence.map((item) => item.rationale).join("; "),
      label: {
        kind: "under_escalation",
        weak: true,
        confirmed: false,
        confidence: "unconfirmed",
      },
      }),
    );
  }
  return candidates;
}

/** Read-only snapshot of the three tables the deriver joins. */
export function readTables(dbPath: string): Tables {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Since migration 50 `supervision_outcomes` is a view over the one
    // decision ledger, with the same rows: a table or a view reads the same.
    const names = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (!names.has("supervision_outcomes")) {
      throw new Error(
        `${dbPath} has no supervision_outcomes table (needs migration 13+). Point --db at an exported firstmate.db.`,
      );
    }
    const outcomeColumns = new Set(
      (db.prepare("PRAGMA table_info(supervision_outcomes)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    const facts = outcomeColumns.has("facts_json") ? "facts_json" : "NULL AS facts_json";
    const outcomes = db
      .prepare(
        `SELECT id, task_id, wake, verdict, summary, at, card_id, model, prompt_sha, tools_sha,
                steered, wake_kind, missed_escalation, ${facts}
         FROM supervision_outcomes
         ORDER BY at ASC, id ASC`,
      )
      .all() as OutcomeRow[];
    let cards: CardRow[] = [];
    if (names.has("cards")) {
      const cardColumns = new Set(
        (db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      const author = cardColumns.has("author") ? "author" : "NULL AS author";
      cards = db
        .prepare(
          `SELECT id, task_id, kind, ${author}, actions_json, title, body, created_at, resolved_at, chosen_action
           FROM cards
           WHERE task_id IS NOT NULL AND resolved_at IS NOT NULL`,
        )
        .all() as CardRow[];
    }
    const cardRevisions = new Map<string, CardRevisionRow[]>();
    if (names.has("card_revisions")) {
      for (const row of db
        .prepare(
          `SELECT card_id, revision, kind, title, body, actions_json,
                  created_at, replaced_at, replaced_by
           FROM card_revisions ORDER BY card_id, revision`,
        )
        .all() as CardRevisionRow[]) {
        const revisions = cardRevisions.get(row.card_id) ?? [];
        revisions.push(row);
        cardRevisions.set(row.card_id, revisions);
      }
    }
    const tasks = new Map<string, TaskRow>();
    if (names.has("tasks")) {
      for (const row of db.prepare("SELECT id, title, status FROM tasks").all() as TaskRow[]) {
        tasks.set(row.id, row);
      }
    }
    // Direct captain steers and interrupts are an acknowledged evidence gap
    // before R2; the steered/interrupted events it captures going forward are
    // read below as the direct-control class (forward-only).
    // Card resolutions are durable and consumed here, but this candidate set
    // remains weak and incomplete by construction (unconfirmed confidence).
    const cardResolutions = new Map<string, CardResolutionEvent>();
    if (names.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT actor, ref, data_json FROM task_events
           WHERE kind = 'card_resolved' AND ref IS NOT NULL
           ORDER BY at ASC, id ASC`,
        )
        .all() as { actor: string; ref: string; data_json: string | null }[]) {
        cardResolutions.set(row.ref, { actor: row.actor, ...actionOf(row.data_json) });
      }
    }
    const controls: ControlEvent[] = [];
    const decisions: DecisionEvent[] = [];
    if (names.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT id, task_id, at, actor, kind, ref, data_json FROM task_events
           WHERE kind IN ('steered', 'interrupted', 'decided')
           ORDER BY at ASC, id ASC`,
        )
        .all() as {
        id: number;
        task_id: string;
        at: number;
        actor: string;
        kind: string;
        ref: string | null;
        data_json: string | null;
      }[]) {
        const data = parseObject(row.data_json);
        if (row.kind === "decided") {
          const decision = decisionEventOf(row.at, data);
          if (decision && !decisions.some((known) => known.decision === decision.decision)) {
            decisions.push(decision);
          }
          continue;
        }
        controls.push({
          id: row.id,
          task_id: row.task_id,
          at: row.at,
          actor: row.actor,
          kind: row.kind as ControlEvent["kind"],
          ref: row.ref,
          data: data ?? {},
        });
      }
    }
    return { outcomes, cards, cardRevisions, tasks, cardResolutions, controls, decisions };
  } finally {
    db.close();
  }
}

function parseObject(json: string | null): Record<string, unknown> | null {
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

/** A `decided` record's handoff-chain fields, read loosely; null when it is not one. */
export function decisionEventOf(
  at: number,
  data: Record<string, unknown> | null,
): DecisionEvent | null {
  if (!data || typeof data.decision !== "string") return null;
  const producer = data.producer as Record<string, unknown> | undefined;
  const disposition = data.disposition as Record<string, unknown> | undefined;
  if (!producer || !disposition || typeof producer.role !== "string") return null;
  const served = data.served as Record<string, unknown> | null | undefined;
  const prompt = served?.prompt as Record<string, unknown> | undefined;
  const steers = Array.isArray(served?.steers) ? (served.steers as Record<string, unknown>[]) : [];
  const inboxIds = [prompt, ...steers]
    .flatMap((message) => (Array.isArray(message?.segments) ? message.segments : []))
    .map((segment) => (segment as Record<string, unknown>).inboxId)
    .filter((id): id is number => typeof id === "number");
  const numberOrNull = (value: unknown) => (typeof value === "number" ? value : null);
  return {
    decision: data.decision,
    role: producer.role,
    at,
    outcome: typeof disposition.outcome === "string" ? disposition.outcome : null,
    inbox: typeof disposition.inbox === "string" ? disposition.inbox : null,
    outcomeId: numberOrNull(disposition.outcomeId),
    handoffInboxId: numberOrNull(disposition.handoffInboxId),
    inboxIds,
    cards: (Array.isArray(disposition.cards) ? disposition.cards : []).filter(
      (card): card is string => typeof card === "string",
    ),
    toolCalls: (Array.isArray(disposition.toolCalls) ? disposition.toolCalls : [])
      .map((call) => (call as Record<string, unknown>)?.name)
      .filter((name): name is string => typeof name === "string"),
  };
}

export function deriveMissCandidates(options: DeriveOptions): DeriveResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const dbPath = resolve(options.dbPath);
  const tables = readTables(dbPath);
  const candidates = deriveFromTables(tables, windowMs);
  return {
    candidates,
    escalations: deriveEscalations(tables),
    dbPath,
    windowMs,
    routineCount: tables.outcomes.filter((row) => row.verdict === "routine").length,
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export type CliArgs = {
  userData: string;
  dbPath: string;
  out: string | null;
  escalationsOut: string | null;
  windowHours: number;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let dbPath: string | null = null;
  let out: string | null = null;
  let escalationsOut: string | null = null;
  let windowHours = 24;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--") continue;
    if (arg === "--user-data") userData = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--escalations-out") escalationsOut = next();
    else if (arg === "--window-hours") {
      const raw = next();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--window-hours needs a positive number, got ${raw}`);
      }
      windowHours = parsed;
    } else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    userData,
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    out,
    escalationsOut,
    windowHours,
    help,
  };
}

const USAGE = `Derive weak candidate under-escalation labels (PoC-2 C2) from firstmate.db.

  pnpm derive:misses [options]      (or: node scripts/derive-miss-candidates.ts)

  --user-data <dir>     app userData dir (default: the platform userData path,
                        or INFINITARY_USER_DATA_DIR); an exported copy works too
  --db <path>           firstmate.db (default: <user-data>/firstmate.db)
  --window-hours <n>    forward window from each routine (default: 24)
  --out, -o <path>      write JSONL here (default: stdout)
  --escalations-out <path>
                        also write, for each captain verdict R2 can follow, what the
                        Firstmate decision that consumed it did (card, steer, none)
  --help, -h

Reads existing tables only. Never writes missed_escalation / missed_note /
missed_at (those are C3's confirmed labels). Every candidate is labelled
weak and unconfirmed. Nothing leaves this machine.`;

export function summarize(result: DeriveResult): string {
  const byKind = new Map<string, number>();
  for (const candidate of result.candidates) {
    for (const item of candidate.evidence) {
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    }
  }
  const kinds = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  const lines = [
    `db: ${result.dbPath}`,
    `window: ${result.windowMs / 3600000}h`,
    `routines: ${result.routineCount}`,
    `candidates: ${result.candidates.length} (weak, unconfirmed)`,
    `evidence: ${kinds || "none"}`,
  ];
  // Forward-only: a database from before R2 has nothing to follow, and its
  // summary reads exactly as it always did.
  const escalations = result.escalations ?? [];
  if (escalations.length > 0) {
    const byClass = new Map<string, number>();
    for (const record of escalations) {
      const key = record.escalation_outcome.class;
      byClass.set(key, (byClass.get(key) ?? 0) + 1);
    }
    lines.push(
      `escalations followed: ${escalations.length} (${[...byClass.entries()]
        .map(([name, count]) => `${name}=${count}`)
        .join(" ")})`,
    );
  }
  return lines.join("\n");
}

export function main(argv: string[]): number {
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
  if (!existsSync(args.dbPath)) {
    process.stderr.write(
      `No database at ${args.dbPath}. Point --db or --user-data at an exported copy.\n`,
    );
    return 1;
  }
  let result: DeriveResult;
  try {
    result = deriveMissCandidates({
      dbPath: args.dbPath,
      windowMs: args.windowHours * 60 * 60 * 1000,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const jsonl =
    result.candidates.length === 0
      ? ""
      : `${result.candidates.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (args.escalationsOut) {
    const escalations = result.escalations ?? [];
    writeFileSync(
      args.escalationsOut,
      escalations.length === 0
        ? ""
        : `${escalations.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
  if (args.out) {
    writeFileSync(args.out, jsonl);
    process.stderr.write(`${summarize(result)}\nwrote: ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
    process.stderr.write(`${summarize(result)}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
