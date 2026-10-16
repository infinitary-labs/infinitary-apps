import type { WakeFacts } from "../orchestrator/wakes";
import type { AppDatabase } from "./db";

/**
 * The one decision ledger (the primitives review, P6; migration 50;
 * docs/decision-models.md "The decision ledger"): one `decisions` row per
 * decision the host makes about a task, with its `kind`, the rule that
 * decided and why, and this store its one writer.
 *
 * - `routing` - which model a spawn was routed to and at what tier, with
 *   the shape's rule (`Router`).
 * - `account` - which account of that provider serves it (`AccountSelector`).
 * - `sort` - the whose-turn sort and the idle ladder's rungs (the
 *   supervisor's `recordSort`), and the retired triage session's verdicts
 *   before them: the wake, its typed facts, routine or captain, and why.
 *   Append-only apart from the one write-once missed-escalation label
 *   (migration 16). A decision and its effect commit in one transaction
 *   (`transaction`), so nothing about a handled wake ever depends on
 *   conversation memory.
 *
 * The three old table names are read-only views over this table
 * (`LEDGER_VIEWS`, views.ts), so the offline readers read one ledger old
 * or new.
 */

export type DecisionKind = "routing" | "account" | "sort";

export type SupervisionVerdict = "routine" | "captain";

/** A `sort` row as the Firstmate's log and label tool read it. */
export type SupervisionOutcome = {
  id: number;
  taskId: string;
  wake: string;
  verdict: SupervisionVerdict;
  summary: string;
  at: number;
  cardId: string | null;
  /**
   * The model that judged a retired triage, or `rule:<id>` for a row a rule
   * sorted (R4.4) - the stamp the rule had before it moved to its own column.
   */
  model: string | null;
  promptSha: string | null;
  toolsSha: string | null;
  steered: boolean | null;
  wakeKind: string | null;
  /** Confirmed missed escalation (migration 16). Null = no label at all. */
  missedEscalation: boolean | null;
  missedNote: string | null;
  missedAt: number | null;
  /** The recorded wake's typed facts; null for prose and for every row before the ledger. */
  facts: WakeFacts | null;
};

export type SupervisionOutcomeInput = {
  taskId: string;
  wake: string;
  verdict: SupervisionVerdict;
  summary: string;
  /** The rule that sorted it (a whose-turn or idle rule id). */
  rule?: string | null;
  /** The typed facts of the wake it recorded, when the wake was typed. */
  facts?: WakeFacts | null;
  cardId?: string | null;
  model?: string | null;
  promptSha?: string | null;
  toolsSha?: string | null;
  steered?: boolean | null;
  wakeKind?: string | null;
};

export type RoutingDecisionInput = {
  taskId: string;
  provider: string | null;
  model: string | null;
  /** The slot asked for. */
  bucket: string;
  /** The policy row that asked for it (R0-R9). */
  rule: string;
  /** The slot actually served (S5); null only when nothing was chosen. */
  served: string | null;
  reasons: readonly string[];
};

/** A routing row as its readers use it; its reasons stay in the ledger. */
export type RoutingDecision = {
  id: number;
  taskId: string;
  provider: string | null;
  model: string | null;
  bucket: string;
  rule: string | null;
  served: string | null;
  at: number;
};

export type AccountDecisionInput = {
  taskId: string;
  provider: string;
  accountId: string | null;
  reasons: readonly string[];
};

type SortRow = {
  id: number;
  task_id: string;
  wake: string;
  verdict: SupervisionVerdict;
  summary: string;
  at: number;
  rule: string | null;
  card_id: string | null;
  model: string | null;
  prompt_sha: string | null;
  tools_sha: string | null;
  steered: number | null;
  wake_kind: string | null;
  missed_escalation: number | null;
  missed_note: string | null;
  missed_at: number | null;
  facts_json: string | null;
};

type RoutingRow = {
  id: number;
  task_id: string;
  provider: string | null;
  model: string | null;
  bucket: string;
  rule: string | null;
  served: string | null;
  at: number;
};

/** What flag_missed_escalation asks the store to label. */
export type MissedEscalationInput = {
  taskId: string;
  note: string;
  outcomeId?: number;
  at?: number;
};

/**
 * Every honest end of a label attempt. Refusals are values, not throws:
 * the tool renders them as plain text so a rejected label never breaks a
 * captain turn.
 */
export type MissedEscalationResult =
  | { status: "flagged"; outcome: SupervisionOutcome }
  | { status: "no-outcome"; taskId: string }
  | { status: "other-task"; outcome: SupervisionOutcome }
  | { status: "not-routine"; outcome: SupervisionOutcome }
  | { status: "already-flagged"; outcome: SupervisionOutcome };

function parseFacts(json: string | null): WakeFacts | null {
  if (!json) return null;
  try {
    const facts = JSON.parse(json) as unknown;
    return facts && typeof facts === "object" && typeof (facts as WakeFacts).kind === "string"
      ? (facts as WakeFacts)
      : null;
  } catch {
    return null;
  }
}

function fromSortRow(row: SortRow): SupervisionOutcome {
  return {
    id: row.id,
    taskId: row.task_id,
    wake: row.wake,
    verdict: row.verdict,
    summary: row.summary,
    at: row.at,
    cardId: row.card_id,
    model: row.rule === null ? row.model : `rule:${row.rule}`,
    promptSha: row.prompt_sha,
    toolsSha: row.tools_sha,
    steered: row.steered == null ? null : row.steered !== 0,
    wakeKind: row.wake_kind,
    missedEscalation: row.missed_escalation == null ? null : row.missed_escalation !== 0,
    missedNote: row.missed_note,
    missedAt: row.missed_at,
    facts: parseFacts(row.facts_json),
  };
}

function fromRoutingRow(row: RoutingRow): RoutingDecision {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    model: row.model,
    bucket: row.bucket,
    rule: row.rule,
    served: row.served,
    at: row.at,
  };
}

const SORT_COLUMNS = `id, task_id, wake, verdict, summary, at, rule, card_id, model, prompt_sha,
  tools_sha, steered, wake_kind, missed_escalation, missed_note, missed_at, facts_json`;

const ROUTING_COLUMNS = "id, task_id, provider, model, bucket, rule, served, at";

export class DecisionStore {
  constructor(private readonly db: AppDatabase) {}

  /** Run a decision + its effect atomically (the store-first guarantee). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Record a routing decision with its reasons - the "why this model" surface. */
  recordRouting(input: RoutingDecisionInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions (kind, task_id, at, rule, reasons_json, provider, model, bucket, served)
         VALUES ('routing', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        Date.now(),
        input.rule,
        JSON.stringify(input.reasons),
        input.provider,
        input.model,
        input.bucket,
        input.served,
      );
    return Number(info.lastInsertRowid);
  }

  /** Record an account selection with its reasons - the "why this account" surface. */
  recordAccount(input: AccountDecisionInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions (kind, task_id, at, reasons_json, provider, account_id)
         VALUES ('account', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        Date.now(),
        JSON.stringify(input.reasons),
        input.provider,
        input.accountId,
      );
    return Number(info.lastInsertRowid);
  }

  /** Record one sort: the wake, its facts, the verdict and why. */
  recordSort(input: SupervisionOutcomeInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions
          (kind, task_id, at, rule, wake, facts_json, verdict, summary, card_id, model,
           prompt_sha, tools_sha, steered, wake_kind)
         VALUES ('sort', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        Date.now(),
        input.rule ?? null,
        input.wake,
        input.facts ? JSON.stringify(input.facts) : null,
        input.verdict,
        input.summary,
        input.cardId ?? null,
        input.model ?? null,
        input.promptSha ?? null,
        input.toolsSha ?? null,
        input.steered == null ? null : input.steered ? 1 : 0,
        input.wakeKind ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Label one routine outcome as a confirmed missed escalation (PoC-2 C3).
   * Write-once and only over `routine`: an escalated verdict cannot be a
   * miss, and a second flag must not silently overwrite the captain's own
   * words. Without an explicit outcome id the newest routine outcome on the
   * task is the target, because that is the wake a captain is talking about
   * when he says it should have reached him.
   */
  flagMissedEscalation(input: MissedEscalationInput): MissedEscalationResult {
    const row =
      input.outcomeId !== undefined
        ? (this.db
            .prepare(`SELECT ${SORT_COLUMNS} FROM decisions WHERE id = ? AND kind = 'sort'`)
            .get(input.outcomeId) as SortRow | undefined)
        : (this.db
            .prepare(
              `SELECT ${SORT_COLUMNS} FROM decisions
               WHERE kind = 'sort' AND task_id = ? AND verdict = 'routine'
               ORDER BY id DESC LIMIT 1`,
            )
            .get(input.taskId) as SortRow | undefined);
    if (!row) return { status: "no-outcome", taskId: input.taskId };
    const outcome = fromSortRow(row);
    if (outcome.taskId !== input.taskId) return { status: "other-task", outcome };
    if (outcome.verdict !== "routine") return { status: "not-routine", outcome };
    if (outcome.missedEscalation) return { status: "already-flagged", outcome };
    const at = input.at ?? Date.now();
    this.db
      .prepare(
        `UPDATE decisions
         SET missed_escalation = 1, missed_note = ?, missed_at = ?
         WHERE id = ?`,
      )
      .run(input.note, at, outcome.id);
    return {
      status: "flagged",
      outcome: { ...outcome, missedEscalation: true, missedNote: input.note, missedAt: at },
    };
  }

  /**
   * Whether this exact wake text was already sorted on the task (WI-6): a
   * wake that repeats one already judged carries no new information,
   * whatever verdict it earned the first time.
   */
  hasTriaged(taskId: string, wake: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM decisions WHERE kind = 'sort' AND task_id = ? AND wake = ? LIMIT 1")
        .get(taskId, wake) !== undefined
    );
  }

  /** The newest sort outcomes, newest first - the Firstmate's log. */
  recent(limit = 20): SupervisionOutcome[] {
    const rows = this.db
      .prepare(`SELECT ${SORT_COLUMNS} FROM decisions WHERE kind = 'sort' ORDER BY id DESC LIMIT ?`)
      .all(limit) as SortRow[];
    return rows.map(fromSortRow);
  }

  /**
   * Routing decisions, oldest first (by `at`, then id): every one, or only
   * those of `taskIds`, and with `chosen` only those that chose a model.
   */
  routing(options: { taskIds?: readonly string[]; chosen?: boolean } = {}): RoutingDecision[] {
    const where = ["kind = 'routing'"];
    const params: string[] = [];
    if (options.taskIds) {
      if (options.taskIds.length === 0) return [];
      where.push(`task_id IN (${options.taskIds.map(() => "?").join(", ")})`);
      params.push(...options.taskIds);
    }
    if (options.chosen) where.push("provider IS NOT NULL");
    const rows = this.db
      .prepare(
        `SELECT ${ROUTING_COLUMNS} FROM decisions WHERE ${where.join(" AND ")} ORDER BY at ASC, id ASC`,
      )
      .all(...params) as RoutingRow[];
    return rows.map(fromRoutingRow);
  }

  /** The task's newest routing decision in the order it was written; undefined when it never routed. */
  latestRouting(taskId: string): RoutingDecision | undefined {
    const row = this.db
      .prepare(
        `SELECT ${ROUTING_COLUMNS} FROM decisions WHERE kind = 'routing' AND task_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId) as RoutingRow | undefined;
    return row ? fromRoutingRow(row) : undefined;
  }
}
