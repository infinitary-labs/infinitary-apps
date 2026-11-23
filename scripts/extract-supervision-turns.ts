/**
 * G1 - the pre-S7c supervision archive reader only
 * (`docs/supervision-extractor.md`).
 *
 * The app no longer writes supervision transcripts. This reader preserves
 * joins for pre-S7c exports; current whose-turn outcomes have no model input.
 *
 * C4's `supervision.jsonl` carries the supervision DECISION (the outcome row:
 * raw wake payload, verdict, summary) but never the decision's INPUT and
 * TRAJECTORY - the served wake and context, the `crew_status` call and its
 * result, the assistant text - which live only in the supervision session's
 * own Pi JSONL (`userData/supervision/sessions/`). This script joins the two,
 * one record per triage turn, the C5 analogue for the second persona.
 *
 * Joins, strongest first, and every record says which it rests on
 * (`join_basis`):
 *
 * - `decision-id`: a `decided` task event (R2, `docs/provenance-capture.md`)
 *   whose producer role is supervision - `disposition.outcomeId` to the
 *   outcome row, `served.prompt.entryId` to the session entry,
 *   `disposition.toolCalls[].id` to the calls and their results;
 * - `text-exact` / `text-prefix`: history before R2 has no decision record,
 *   so an outcome row joins the session turn that served its wake payload,
 *   on its task, at its time (`(task_id, wake payload, at)`). `text-prefix`
 *   accepts only the two recorded truncation shapes: a `capWithOverflow`
 *   marker or the legacy 160-character excerpt;
 * - `unjoined`: a row or a turn nothing joined, with the reason (`miss`).
 *   Every outcome row and every served triage turn yields a record, so a
 *   miss is always explained and never silently dropped.
 *
 * It moves transcripts, so it is gated by Observe's development gate
 * (`src/core/observe/gate.ts`) before a single file is read, and every
 * record is redacted as a whole (`redactDeep`) on the way out. Offline,
 * read-only, no schema change, nothing leaves the box.
 *
 * Run it (Node 24 strips the types):
 *   pnpm extract:supervision --user-data /path/to/pre-S7c/userData --out supervision-turns.jsonl
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DevObserveGateInput,
  isDevObserveEnabled,
  OBSERVE_DISABLED_MESSAGE,
} from "../src/core/observe/gate.ts";
import { redactDeep } from "../src/core/observe/redact.ts";
import {
  parseServedInput,
  type ServedOrigin,
} from "../src/shared/servedFrame.ts";
import { detectPackaged } from "./export-corpus.ts";
import { splitBackupCopies } from "./dispatch-corpus/sessionFiles.ts";
import { defaultUserDataDir, settingString } from "./dispatch-corpus/userData.ts";

type JsonRecord = Record<string, unknown>;

/**
 * How far an outcome row's `at` may sit outside its turn's first and last
 * session entry timestamps. The row is stamped inside `report_outcome`'s
 * execution, between the assistant's call and the tool result entry; the
 * slack only absorbs clock rounding, never a neighbouring turn.
 */
export const TURN_TIME_SLACK_MS = 2000;

export type SupervisionTurnJoinBasis = "decision-id" | "text-exact" | "text-prefix" | "unjoined";

export type SupervisionTurnMissReason =
  /** Rows: no supervision session read covers the row's time. */
  | "outside-session-coverage"
  /** Rows: the wake was served on the task, but never at the row's time. */
  | "wake-served-at-another-time"
  /** Rows: no served turn carries this wake on this task. */
  | "no-matching-turn"
  /** Decisions: the outcome row the record names is not in this database. */
  | "outcome-row-missing"
  /** Decisions: the decision recorded no session entry (its turn failed before the tree). */
  | "served-entry-unlocated"
  /** Decisions: the served entry the record names is not in any session read. */
  | "session-entry-missing"
  /** Turns: the served text carries no recognizable wake. */
  | "not-a-wake"
  /** Turns: the model turn failed before it reported. */
  | "turn-failed"
  /** Turns: a clean turn that never called report_outcome (handed to the Firstmate). */
  | "unreported"
  /** Turns: report_outcome was called but refused (no row was written). */
  | "report-refused"
  /** Turns: reported, but no outcome row in this database matches it. */
  | "no-outcome-row";

export type SupervisionToolCall = {
  id: string;
  name: string;
  args: JsonRecord;
  result: { text: string; isError: boolean; at: number | null } | null;
};

export type ServedSegmentOut = {
  kind: "wake" | "context" | "user";
  body: string;
  origin?: ServedOrigin;
};

export type SupervisionTurnRecord = {
  dataset: "supervision-turn";
  id: string;
  join_basis: SupervisionTurnJoinBasis;
  miss: { reason: SupervisionTurnMissReason; detail: string } | null;
  outcome_id: number | null;
  task_id: string | null;
  verdict: "routine" | "captain" | null;
  summary: string | null;
  wake_kind: string | null;
  /** The R2 decision the join rests on; null before R2. */
  decision: {
    id: string;
    actor: string;
    trigger: string;
    outcome: string;
    inbox: string;
    handoff_inbox_id: number | null;
    account_id: string | null;
    thinking_level: string | null;
    /** Whether the decision's served-text fingerprint matches the session entry. */
    text_sha_matches: boolean | null;
    /** Call ids the decision lists that the session turn does not carry. */
    unmatched_tool_call_ids: string[];
  } | null;
  /**
   * Where the served text lives. (Not `session`: `redactDeep` treats any key
   * ending in "session" as a credential and would blank the whole object.)
   */
  transcript: {
    file: string;
    /** The Pi session header's id. */
    header_id: string | null;
    entry_id: string | null;
    parent_entry_id: string | null;
  } | null;
  /**
   * What the model was served, as typed segments. `structural-frame` is an
   * R2 framed input read by its own marks; `reframed-exact` is pre-frame
   * history split where the joined outcome row's stored wake ends (the host
   * wrote both halves); `reframed-marker` splits at the first
   * `\n\n[context] ` (a wake quoting that label would move it); null when
   * the text carries no wake shape, in which case `text` is kept verbatim.
   */
  served: {
    frame_basis: "structural-frame" | "reframed-exact" | "reframed-marker" | null;
    segments: ServedSegmentOut[] | null;
    text: string | null;
    text_sha256: string;
  } | null;
  crew_status: SupervisionToolCall[];
  report_outcome: SupervisionToolCall | null;
  /** Every other call of the turn (steer_crewmate, tasks, extra reports), in order. */
  other_tool_calls: SupervisionToolCall[];
  assistant: string;
  turn_failed: boolean;
  error: string | null;
  model: string | null;
  /** The contract the R2 decision recorded; null before R2 - never re-badged. */
  contract: { version: string; prompt_sha: string | null; tools_sha: string | null } | null;
  /** How much rolling history the served prompt extended (R2); null before R2. */
  prefix_message_count: number | null;
  /** The outcome row's own migration-15 stamp, verbatim (a different thing from `contract`). */
  row_provenance: {
    model: string | null;
    prompt_sha: string | null;
    tools_sha: string | null;
  } | null;
  /** C3's captain-confirmed miss label, verbatim. Null = no label, never a negative. */
  label: {
    missed_escalation: boolean | null;
    missed_note: string | null;
    missed_at: number | null;
  };
  timestamps: {
    served_at: number | null;
    ended_at: number | null;
    outcome_at: number | null;
    decision_started_at: number | null;
    decision_ended_at: number | null;
  };
};

export type SessionTurn = {
  file: string;
  sessionId: string | null;
  entryId: string | null;
  parentEntryId: string | null;
  at: number;
  endAt: number;
  text: string;
  model: string | null;
  assistant: string;
  calls: SupervisionToolCall[];
  failed: boolean;
  error: string | null;
};

/**
 * One supervision session file → its turns. A turn opens on a user message
 * (the host's served wake) and absorbs every assistant and toolResult
 * message until the next one; a tool result joins its call by Pi's own id.
 * Entries already read in this run (a fork's copied history) are skipped.
 */
export function readSupervisionTurns(
  raw: string,
  file: string,
  seenEntryIds: Set<string> = new Set(),
): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let sessionId: string | null = null;
  let model: string | null = null;
  let current: SessionTurn | undefined;
  const calls = new Map<string, SupervisionToolCall>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(trimmed) as JsonRecord;
    } catch {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      continue;
    }
    const entryId = typeof entry.id === "string" ? entry.id : null;
    if (entryId) {
      if (seenEntryIds.has(entryId)) continue;
      seenEntryIds.add(entryId);
    }
    if (type === "model_change") {
      model = modelLabel(entry.provider, entry.modelId) ?? model;
      continue;
    }
    if (type !== "message") continue;
    const message = entry.message as JsonRecord | undefined;
    if (!message || typeof message !== "object") continue;
    const at = timestampOf(entry) ?? timestampOf(message);
    const role = message.role;
    if (role === "user") {
      current = {
        file,
        sessionId,
        entryId,
        parentEntryId: typeof entry.parentId === "string" ? entry.parentId : null,
        at: at ?? 0,
        endAt: at ?? 0,
        text: textFromContent(message.content),
        model,
        assistant: "",
        calls: [],
        failed: false,
        error: null,
      };
      turns.push(current);
      calls.clear();
      continue;
    }
    if (!current) continue;
    if (at !== null && at > current.endAt) current.endAt = at;
    if (role === "assistant") {
      const label = modelLabel(message.provider, message.model);
      if (label) {
        model = label;
        current.model = label;
      }
      const text = textFromContent(message.content).trim();
      if (text) current.assistant = current.assistant ? `${current.assistant}\n${text}` : text;
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const typed = part as JsonRecord;
        if (typed?.type !== "toolCall" || typeof typed.name !== "string") continue;
        const call: SupervisionToolCall = {
          id: typeof typed.id === "string" ? typed.id : "",
          name: typed.name,
          args:
            typed.arguments && typeof typed.arguments === "object"
              ? (typed.arguments as JsonRecord)
              : {},
          result: null,
        };
        current.calls.push(call);
        if (call.id) calls.set(call.id, call);
      }
      if (message.stopReason === "error") {
        current.failed = true;
        current.error = typeof message.errorMessage === "string" ? message.errorMessage : "error";
      }
      continue;
    }
    if (role === "toolResult") {
      const call = calls.get(typeof message.toolCallId === "string" ? message.toolCallId : "");
      if (call) {
        call.result = {
          text: textFromContent(message.content),
          isError: Boolean(message.isError),
          at,
        };
      }
    }
  }
  return turns;
}

/**
 * The wake a served turn carries, read by its frame when it has one and by
 * the host's historical `[wake] …\n\n[context] …` shape otherwise.
 */
export function servedWake(text: string): {
  frame_basis: "structural-frame" | "reframed-marker" | null;
  payload: string | null;
  segments: ServedSegmentOut[] | null;
  contextTaskId: string | null;
} {
  const framed = parseServedInput(text);
  if (framed) {
    const wake = framed.find((segment) => segment.kind === "wake")?.body;
    const context = framed.find((segment) => segment.kind === "context")?.body;
    return {
      frame_basis: "structural-frame",
      payload: wake?.startsWith("[wake] ") ? wake.slice("[wake] ".length) : null,
      segments: framed.map((segment) => ({
        kind: segment.kind,
        body: segment.body,
        ...(segment.origin ? { origin: segment.origin } : {}),
      })),
      contextTaskId: context ? contextTaskIdOf(context) : null,
    };
  }
  if (!text.startsWith("[wake] ")) {
    return { frame_basis: null, payload: null, segments: null, contextTaskId: null };
  }
  const end = text.indexOf("\n\n[context] ");
  if (end < 0) {
    return {
      frame_basis: "reframed-marker",
      payload: text.slice("[wake] ".length),
      segments: [{ kind: "wake", body: text }],
      contextTaskId: null,
    };
  }
  const context = text.slice(end + 2);
  return {
    frame_basis: "reframed-marker",
    payload: text.slice("[wake] ".length, end),
    segments: [
      { kind: "wake", body: text.slice(0, end) },
      { kind: "context", body: context },
    ],
    contextTaskId: contextTaskIdOf(context),
  };
}

function contextTaskIdOf(context: string): string | null {
  return /^\[context\] task (\S+)/.exec(context)?.[1] ?? null;
}

/** Match exactly, or by one of the two recorded historical truncation shapes. */
export function wakeMatch(
  turnText: string,
  storedWake: string,
  served: ReturnType<typeof servedWake> = servedWake(turnText),
): "exact" | "prefix" | null {
  if (!storedWake) return null;
  if (served.payload === null) return null;
  if (served.frame_basis === "structural-frame") {
    if (served.payload === storedWake) return "exact";
  } else if (turnText.startsWith(`[wake] ${storedWake}\n\n[context] `)) {
    return "exact";
  }
  const overflow = /^([\s\S]*)\n\[truncated \d+ more characters; full text: [^\]]*\]$/.exec(
    storedWake,
  );
  const head = overflow?.[1];
  if (
    head &&
    head.length < served.payload.length &&
    served.payload.startsWith(head)
  ) {
    return "prefix";
  }
  if (
    storedWake.length === 160 &&
    storedWake.length < served.payload.length &&
    served.payload.startsWith(storedWake)
  ) {
    return "prefix";
  }
  return null;
}

export type OutcomeRow = {
  id: number;
  task_id: string;
  wake: string;
  verdict: string;
  summary: string;
  at: number;
  model?: string | null;
  prompt_sha?: string | null;
  tools_sha?: string | null;
  wake_kind?: string | null;
  missed_escalation?: number | null;
  missed_note?: string | null;
  missed_at?: number | null;
};

/** The parts of an R2 `DecisionRecord` this reader relies on, read loosely. */
export type SupervisionDecision = {
  decision: string;
  startedAt: number | null;
  endedAt: number | null;
  producer: {
    actor: string;
    model: { provider: string; id: string } | null;
    accountId: string | null;
    thinkingLevel: string | null;
  };
  contract: { version: string; promptSha: string | null; toolsSha: string | null } | null;
  trigger: string;
  served: {
    sessionFile: string | null;
    prompt: {
      textSha256: string;
      entryId: string | null;
      parentEntryId: string | null;
      prefix: { messageCount: number } | null;
    };
  } | null;
  disposition: {
    outcome: string;
    inbox: string;
    toolCalls: { id: string; name: string }[];
    verdict: string | null;
    outcomeId: number | null;
    handoffInboxId: number | null;
  };
};

export type SupervisionTables = {
  outcomes: OutcomeRow[];
  decisions: SupervisionDecision[];
  recordedSessionFile: string | null;
};

export const EMPTY_SUPERVISION_TABLES: SupervisionTables = {
  outcomes: [],
  decisions: [],
  recordedSessionFile: null,
};

/** Tables and views: since migration 50 `supervision_outcomes` is a view over the decision ledger. */
function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

/**
 * Read-only snapshot of what the join needs: every outcome row, every
 * supervision `decided` record (one per decision - a decision writes the
 * same record on each task it touched), and the rolling session the app
 * last recorded.
 */
export function readSupervisionTables(dbPath: string): SupervisionTables {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const names = tableNames(db);
    const outcomes = names.has("supervision_outcomes")
      ? (db.prepare("SELECT * FROM supervision_outcomes ORDER BY id").all() as OutcomeRow[])
      : [];
    const decisions: SupervisionDecision[] = [];
    if (names.has("task_events")) {
      const seen = new Set<string>();
      for (const row of db
        .prepare(
          `SELECT ref, data_json FROM task_events
           WHERE kind = 'decided' ORDER BY at ASC, id ASC`,
        )
        .all() as { ref: string | null; data_json: string | null }[]) {
        const record = decisionFromJson(row.data_json);
        if (!record || seen.has(record.decision)) continue;
        seen.add(record.decision);
        decisions.push(record);
      }
    }
    let recordedSessionFile: string | null = null;
    if (names.has("settings")) {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'supervision-session-file'")
        .get() as { value: string } | undefined;
      recordedSessionFile = settingString(row?.value);
    }
    return { outcomes, decisions, recordedSessionFile };
  } finally {
    db.close();
  }
}

/** A supervision decision record out of a `decided` event's data, or null for any other producer. */
export function decisionFromJson(dataJson: string | null): SupervisionDecision | null {
  if (!dataJson) return null;
  let data: JsonRecord;
  try {
    data = JSON.parse(dataJson) as JsonRecord;
  } catch {
    return null;
  }
  const producer = asRecord(data.producer);
  const disposition = asRecord(data.disposition);
  if (!producer || !disposition || producer.role !== "supervision") return null;
  if (typeof data.decision !== "string") return null;
  const model = asRecord(producer.model);
  const contract = asRecord(data.contract);
  const served = asRecord(data.served);
  const prompt = asRecord(served?.prompt);
  const prefix = asRecord(prompt?.prefix);
  return {
    decision: data.decision,
    startedAt: numberOrNull(data.startedAt),
    endedAt: numberOrNull(data.endedAt),
    producer: {
      actor: stringOr(producer.actor, "unknown"),
      model:
        model && typeof model.provider === "string" && typeof model.id === "string"
          ? { provider: model.provider, id: model.id }
          : null,
      accountId: stringOrNull(producer.accountId),
      thinkingLevel: stringOrNull(producer.thinkingLevel),
    },
    contract:
      contract && typeof contract.version === "string"
        ? {
            version: contract.version,
            promptSha: stringOrNull(contract.promptSha),
            toolsSha: stringOrNull(contract.toolsSha),
          }
        : null,
    trigger: stringOr(data.trigger, "wake"),
    served:
      served && prompt
        ? {
            sessionFile: stringOrNull(served.sessionFile),
            prompt: {
              textSha256: stringOr(prompt.textSha256, ""),
              entryId: stringOrNull(prompt.entryId),
              parentEntryId: stringOrNull(prompt.parentEntryId),
              prefix:
                prefix && typeof prefix.messageCount === "number"
                  ? { messageCount: prefix.messageCount }
                  : null,
            },
          }
        : null,
    disposition: {
      outcome: stringOr(disposition.outcome, "unknown"),
      inbox: stringOr(disposition.inbox, "none"),
      toolCalls: (Array.isArray(disposition.toolCalls) ? disposition.toolCalls : [])
        .map((call) => asRecord(call))
        .filter((call): call is JsonRecord => Boolean(call) && typeof call?.id === "string")
        .map((call) => ({ id: call.id as string, name: stringOr(call.name, "") })),
      verdict: stringOrNull(disposition.verdict),
      outcomeId: numberOrNull(disposition.outcomeId),
      handoffInboxId: numberOrNull(disposition.handoffInboxId),
    },
  };
}

export type SupervisionJoinResult = {
  records: SupervisionTurnRecord[];
  /** Tripwires: a taskless (`fleet`) outcome row is the deferred-capture case. */
  warnings: string[];
};

/** A served turn, its wake parsed once, and how many outcome rows it has claimed. */
type TurnState = {
  turn: SessionTurn;
  served: ReturnType<typeof servedWake>;
  reports: number;
  claimed: number;
};

/** Pure join over already-read tables and turns. The CLI reads; tests fixture. */
export function joinSupervisionTurns(
  tables: SupervisionTables,
  turns: SessionTurn[],
): SupervisionJoinResult {
  const records: SupervisionTurnRecord[] = [];
  const warnings: string[] = [];
  for (const row of tables.outcomes) {
    if (row.task_id === "fleet") {
      warnings.push(
        `supervision_outcomes #${row.id} has task_id 'fleet': a taskless supervision wake, the case R2 deferred (no decided event can anchor it)`,
      );
    }
  }

  const rowsById = new Map(tables.outcomes.map((row) => [row.id, row]));
  const consumedRows = new Set<number>();
  const states: TurnState[] = turns.map((turn) => ({
    turn,
    reports: turn.calls.filter((call) => call.name === "report_outcome").length,
    served: servedWake(turn.text),
    claimed: 0,
  }));
  const byEntryId = new Map<string, TurnState[]>();
  for (const state of states) {
    if (!state.turn.entryId) continue;
    const bucket = byEntryId.get(state.turn.entryId) ?? [];
    bucket.push(state);
    byEntryId.set(state.turn.entryId, bucket);
  }

  for (const decision of tables.decisions) {
    const outcomeId = decision.disposition.outcomeId;
    const row = outcomeId !== null ? rowsById.get(outcomeId) : undefined;
    if (row) consumedRows.add(row.id);
    const entryId = decision.served?.prompt.entryId ?? null;
    const candidates = entryId ? (byEntryId.get(entryId) ?? []) : [];
    const recorded = decision.served?.sessionFile ? basename(decision.served.sessionFile) : null;
    const state =
      candidates.find((candidate) => basename(candidate.turn.file) === recorded) ?? candidates[0];
    if (state) state.claimed = Math.max(state.claimed + 1, state.reports);
    let miss: SupervisionTurnRecord["miss"] = null;
    if (outcomeId !== null && !row) {
      miss = {
        reason: "outcome-row-missing",
        detail: `decision names supervision_outcomes #${outcomeId}, which this database does not hold`,
      };
    } else if (decision.served && !entryId) {
      miss = {
        reason: "served-entry-unlocated",
        detail:
          "the decision recorded no session entry for its served text (the turn failed before it reached the tree)",
      };
    } else if (entryId && !state) {
      miss = {
        reason: "session-entry-missing",
        detail: `served entry ${entryId} is not in any supervision session read`,
      };
    }
    records.push(buildRecord({ basis: "decision-id", miss, row, state, decision }));
  }

  const pool = states.filter((state) => state.claimed === 0);
  for (const row of tables.outcomes) {
    if (consumedRows.has(row.id)) continue;
    let best: { state: TurnState; match: "exact" | "prefix"; score: number } | undefined;
    for (const state of pool) {
      if (state.claimed >= Math.max(1, state.reports)) continue;
      if (!turnCoversTask(state, row.task_id)) continue;
      if (row.at < state.turn.at - TURN_TIME_SLACK_MS) continue;
      if (row.at > state.turn.endAt + TURN_TIME_SLACK_MS) continue;
      const match = wakeMatch(state.turn.text, row.wake, state.served);
      if (!match) continue;
      const corroborated = state.turn.calls.some(
        (call) => call.name === "report_outcome" && reportMatches(call, row),
      );
      const score = (match === "exact" ? 2 : 0) + (corroborated ? 1 : 0);
      if (!best || score > best.score) best = { state, match, score };
    }
    if (!best) continue;
    best.state.claimed += 1;
    consumedRows.add(row.id);
    records.push(
      buildRecord({
        basis: best.match === "exact" ? "text-exact" : "text-prefix",
        miss: null,
        row,
        state: best.state,
        decision: undefined,
      }),
    );
  }

  const coverage = states.length
    ? {
        start: Math.min(...states.map((state) => state.turn.at)),
        end: Math.max(...states.map((state) => state.turn.endAt)),
      }
    : null;
  for (const row of tables.outcomes) {
    if (consumedRows.has(row.id)) continue;
    records.push(
      buildRecord({
        basis: "unjoined",
        miss: rowMiss(row, states, coverage),
        row,
        state: undefined,
        decision: undefined,
      }),
    );
  }
  for (const state of states) {
    if (state.claimed > 0) continue;
    records.push(
      buildRecord({
        basis: "unjoined",
        miss: turnMiss(state),
        row: undefined,
        state,
        decision: undefined,
      }),
    );
  }

  records.sort(
    (a, b) =>
      (a.timestamps.served_at ?? a.timestamps.outcome_at ?? 0) -
        (b.timestamps.served_at ?? b.timestamps.outcome_at ?? 0) ||
      (a.outcome_id ?? 0) - (b.outcome_id ?? 0),
  );
  return { records, warnings };
}

function turnCoversTask(state: TurnState, taskId: string): boolean {
  if (state.served.contextTaskId === taskId) return true;
  return state.turn.calls.some(
    (call) => call.name === "report_outcome" && reportTaskId(call) === taskId,
  );
}

function reportTaskId(call: SupervisionToolCall): string {
  const raw = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
  return raw || "fleet";
}

function reportMatches(call: SupervisionToolCall, row: OutcomeRow): boolean {
  const summary = typeof call.args.summary === "string" ? call.args.summary.trim() : "";
  return (
    reportTaskId(call) === row.task_id &&
    call.args.verdict === row.verdict &&
    summary === row.summary
  );
}

function rowMiss(
  row: OutcomeRow,
  states: TurnState[],
  coverage: { start: number; end: number } | null,
): NonNullable<SupervisionTurnRecord["miss"]> {
  if (
    !coverage ||
    row.at < coverage.start - TURN_TIME_SLACK_MS ||
    row.at > coverage.end + TURN_TIME_SLACK_MS
  ) {
    return {
      reason: "outside-session-coverage",
      detail: coverage
        ? `row at ${new Date(row.at).toISOString()} is outside the sessions read (${new Date(coverage.start).toISOString()} to ${new Date(coverage.end).toISOString()})`
        : "no supervision session was read",
    };
  }
  const servedElsewhere = states.some(
    (state) =>
      turnCoversTask(state, row.task_id) && wakeMatch(state.turn.text, row.wake, state.served),
  );
  if (servedElsewhere) {
    return {
      reason: "wake-served-at-another-time",
      detail:
        "a turn served this wake on this task, but not at the row's time (or it was already joined)",
    };
  }
  return {
    reason: "no-matching-turn",
    detail: "no served turn carries this wake on this task",
  };
}

function turnMiss(state: TurnState): NonNullable<SupervisionTurnRecord["miss"]> {
  const turn = state.turn;
  if (state.served.payload === null) {
    return { reason: "not-a-wake", detail: "the served text carries no recognizable wake" };
  }
  const reports = turn.calls.filter((call) => call.name === "report_outcome");
  if (reports.length === 0) {
    return turn.failed
      ? {
          reason: "turn-failed",
          detail: `the turn failed before reporting: ${turn.error ?? "error"}`,
        }
      : { reason: "unreported", detail: "a clean turn that never called report_outcome" };
  }
  if (
    reports.every((call) => call.result?.isError || call.result?.text.startsWith("invalid report"))
  ) {
    return {
      reason: "report-refused",
      detail: "report_outcome was refused, so no row was written",
    };
  }
  return {
    reason: "no-outcome-row",
    detail: "the turn reported, but no outcome row in this database matches (task_id, wake, at)",
  };
}

function buildRecord(input: {
  basis: SupervisionTurnJoinBasis;
  miss: SupervisionTurnRecord["miss"];
  row: OutcomeRow | undefined;
  state: TurnState | undefined;
  decision: SupervisionDecision | undefined;
}): SupervisionTurnRecord {
  const { basis, miss, row, state, decision } = input;
  const turn = state?.turn;
  const calls = turn?.calls ?? [];
  const reports = calls.filter((call) => call.name === "report_outcome");
  const report =
    (row ? reports.find((call) => reportMatches(call, row)) : undefined) ?? reports[0] ?? null;
  const decisionCallIds = new Set(decision?.disposition.toolCalls.map((call) => call.id) ?? []);
  const turnCallIds = new Set(calls.map((call) => call.id));
  const textSha = turn ? sha256(turn.text) : null;
  const verdict =
    row?.verdict ?? decision?.disposition.verdict ?? stringOrNull(report?.args.verdict);
  const model = decision?.producer.model
    ? `${decision.producer.model.provider}/${decision.producer.model.id}`
    : (turn?.model ?? row?.model ?? null);
  return {
    dataset: "supervision-turn",
    id: decision
      ? `decision:${decision.decision}`
      : row
        ? `outcome#${row.id}`
        : `turn:${turn?.entryId ?? `${basename(turn?.file ?? "")}@${turn?.at ?? 0}`}`,
    join_basis: basis,
    miss,
    outcome_id: row?.id ?? decision?.disposition.outcomeId ?? null,
    task_id:
      row?.task_id ??
      (report ? reportTaskId(report) : null) ??
      (turn ? servedWake(turn.text).contextTaskId : null),
    verdict: verdict === "routine" || verdict === "captain" ? verdict : null,
    summary: row?.summary ?? stringOrNull(report?.args.summary),
    wake_kind: row?.wake_kind ?? null,
    decision: decision
      ? {
          id: decision.decision,
          actor: decision.producer.actor,
          trigger: decision.trigger,
          outcome: decision.disposition.outcome,
          inbox: decision.disposition.inbox,
          handoff_inbox_id: decision.disposition.handoffInboxId,
          account_id: decision.producer.accountId,
          thinking_level: decision.producer.thinkingLevel,
          text_sha_matches:
            decision.served && textSha ? decision.served.prompt.textSha256 === textSha : null,
          unmatched_tool_call_ids: turn
            ? [...decisionCallIds].filter((id) => !turnCallIds.has(id))
            : [...decisionCallIds],
        }
      : null,
    transcript: turn
      ? {
          file: turn.file,
          header_id: turn.sessionId,
          entry_id: turn.entryId,
          parent_entry_id: turn.parentEntryId,
        }
      : null,
    served: turn
      ? servedOf(turn.text, basis === "text-exact" ? row : undefined, textSha ?? "")
      : null,
    crew_status: calls.filter((call) => call.name === "crew_status"),
    report_outcome: report,
    other_tool_calls: calls.filter((call) => call.name !== "crew_status" && call !== report),
    assistant: turn?.assistant ?? "",
    turn_failed: turn?.failed ?? false,
    error: turn?.error ?? null,
    model,
    contract: decision?.contract
      ? {
          version: decision.contract.version,
          prompt_sha: decision.contract.promptSha,
          tools_sha: decision.contract.toolsSha,
        }
      : null,
    prefix_message_count: decision?.served?.prompt.prefix?.messageCount ?? null,
    row_provenance: row
      ? {
          model: row.model ?? null,
          prompt_sha: row.prompt_sha ?? null,
          tools_sha: row.tools_sha ?? null,
        }
      : null,
    label: {
      missed_escalation: row?.missed_escalation == null ? null : row.missed_escalation !== 0,
      missed_note: row?.missed_note ?? null,
      missed_at: row?.missed_at ?? null,
    },
    timestamps: {
      served_at: turn?.at ?? null,
      ended_at: turn?.endAt ?? null,
      outcome_at: row?.at ?? null,
      decision_started_at: decision?.startedAt ?? null,
      decision_ended_at: decision?.endedAt ?? null,
    },
  };
}

function servedOf(
  text: string,
  exactRow: OutcomeRow | undefined,
  textSha: string,
): NonNullable<SupervisionTurnRecord["served"]> {
  const served = servedWake(text);
  if (served.frame_basis === "reframed-marker" && exactRow) {
    // The host wrote `[wake] <payload>\n\n<context>`; the joined row holds
    // the payload, so the boundary is known exactly, whatever the wake quotes.
    const end = "[wake] ".length + exactRow.wake.length;
    return {
      frame_basis: "reframed-exact",
      segments: [
        { kind: "wake", body: text.slice(0, end) },
        { kind: "context", body: text.slice(end + 2) },
      ],
      text: null,
      text_sha256: textSha,
    };
  }
  return {
    frame_basis: served.frame_basis,
    segments: served.segments,
    text: served.segments ? null : text,
    text_sha256: textSha,
  };
}

export type SupervisionExtractOptions = {
  /** Observe's development gate, verbatim. Required: there is no ungated call path. */
  gate: DevObserveGateInput;
  dbPath?: string;
  sessionsDir?: string;
  sessionFiles?: string[];
};

export type SupervisionExtractResult =
  | { status: "blocked"; reason: string }
  | {
      status: "extracted";
      records: SupervisionTurnRecord[];
      warnings: string[];
      sources: string[];
      backupCopies: string[];
      dbPath: string | null;
      counts: SupervisionTurnCounts;
    };

export type SupervisionTurnCounts = {
  records: number;
  outcome_rows: number;
  session_turns: number;
  decisions: number;
  by_join_basis: Record<string, number>;
  by_miss_reason: Record<string, number>;
  /** Outcome rows with no join: every one carries a miss reason. */
  unjoined_rows: number;
  /** Served turns with no join: every one carries a miss reason. */
  unjoined_turns: number;
};

/**
 * The whole extraction. The gate is checked FIRST: a packaged build without
 * `INFINITARY_DEV_OBSERVE=1` must not so much as open a transcript.
 */
export function extractSupervisionTurns(
  options: SupervisionExtractOptions,
): SupervisionExtractResult {
  if (!isDevObserveEnabled(options.gate)) {
    return {
      status: "blocked",
      reason: `${OBSERVE_DISABLED_MESSAGE}: the supervision-turn extractor is local-development only`,
    };
  }
  const dbPath = options.dbPath && existsSync(options.dbPath) ? resolve(options.dbPath) : null;
  const tables = dbPath ? readSupervisionTables(dbPath) : EMPTY_SUPERVISION_TABLES;
  const files = resolveSupervisionSessionFiles(options, tables.recordedSessionFile);
  const { kept, backups } = splitBackupCopies(files.map(readSessionFile));
  const seen = new Set<string>();
  const turns = kept.flatMap((file) => readSupervisionTurns(file.raw, file.path, seen));
  const joined = joinSupervisionTurns(tables, turns);
  // Every record is redacted as a whole on the way out (the record boundary).
  const records = joined.records.map((record) => redactDeep(record));
  const tally = (values: string[]) =>
    values.reduce<Record<string, number>>((counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
  return {
    status: "extracted",
    records,
    warnings: joined.warnings,
    sources: kept.map((file) => file.path),
    backupCopies: backups.map((file) => file.path),
    dbPath,
    counts: {
      records: records.length,
      outcome_rows: tables.outcomes.length,
      session_turns: turns.length,
      decisions: tables.decisions.length,
      by_join_basis: tally(records.map((record) => record.join_basis)),
      by_miss_reason: tally(records.flatMap((record) => (record.miss ? [record.miss.reason] : []))),
      unjoined_rows: records.filter(
        (record) => record.join_basis === "unjoined" && record.outcome_id !== null,
      ).length,
      unjoined_turns: records.filter(
        (record) => record.join_basis === "unjoined" && record.transcript !== null,
      ).length,
    },
  };
}

function resolveSupervisionSessionFiles(
  options: SupervisionExtractOptions,
  recorded: string | null,
): string[] {
  const explicit = (options.sessionFiles ?? []).filter((file) => existsSync(file));
  if (explicit.length > 0) return explicit.map((file) => resolve(file));
  const found = new Set<string>();
  if (options.sessionsDir && existsSync(options.sessionsDir)) {
    for (const name of readdirSync(options.sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(options.sessionsDir, name);
      if (statSync(full).isFile()) found.add(resolve(full));
    }
  }
  // The settings row names the rolling session even when it sits elsewhere.
  if (recorded && existsSync(recorded)) found.add(resolve(recorded));
  return [...found].sort();
}

function readSessionFile(path: string) {
  const raw = readFileSync(path, "utf8");
  let sessionId: string | null = null;
  let at = 0;
  let entries = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(trimmed) as JsonRecord;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      at = timestampOf(entry) ?? at;
      continue;
    }
    entries += 1;
  }
  return { path, raw, sessionId, at, entries };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const typed = part as JsonRecord;
      return typed?.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function modelLabel(provider: unknown, id: unknown): string | null {
  return typeof provider === "string" && typeof id === "string" && provider && id
    ? `${provider}/${id}`
    : null;
}

function timestampOf(entry: JsonRecord): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type CliArgs = {
  userData: string;
  sessionsDir: string;
  dbPath: string;
  sessionFiles: string[];
  out: string | null;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let sessionsDir: string | null = null;
  let dbPath: string | null = null;
  const sessionFiles: string[] = [];
  let out: string | null = null;
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
    else if (arg === "--supervision-sessions") sessionsDir = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--session-file") sessionFiles.push(next());
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    userData,
    sessionsDir: sessionsDir ?? join(userData, "supervision", "sessions"),
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    sessionFiles,
    out,
    help,
  };
}

const USAGE = `Read pre-S7c exports only (G1): archived supervision session JSONL + firstmate.db.
The app no longer writes supervision transcripts. Current whose-turn outcomes
have no model input; they remain in the output, never invented transcripts.

  pnpm extract:supervision [options]      (or: node scripts/extract-supervision-turns.ts)

  --user-data <dir>             pre-S7c exported userData (default: the platform userData
                                path, or INFINITARY_USER_DATA_DIR, for retained archives)
  --supervision-sessions <dir>  archived transcripts (default: <user-data>/supervision/sessions)
  --db <path>                   firstmate.db (default: <user-data>/firstmate.db)
  --session-file <path>         one transcript; repeatable, overrides --supervision-sessions
  --out, -o <path>              write JSONL here (default: stdout)
  --help, -h

Local development only: this command needs an unpackaged build, or an explicit
INFINITARY_DEV_OBSERVE=1 (docs/dev-observe.md, "Hard gate"). Read-only; nothing
leaves the box. pnpm export:corpus writes the same records as supervision-turns.jsonl.`;

export function summarize(
  result: Extract<SupervisionExtractResult, { status: "extracted" }>,
): string {
  const pairs = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${count}`)
      .join(" ") || "none";
  return [
    `db: ${result.dbPath ?? "none"}`,
    `sessions (pre-S7c archives only): ${result.sources.length} (${result.backupCopies.length} backup copy/copies excluded)`,
    `outcome rows: ${result.counts.outcome_rows}, served turns: ${result.counts.session_turns}, supervision decisions: ${result.counts.decisions}`,
    `joins: ${pairs(result.counts.by_join_basis)}`,
    `misses: ${pairs(result.counts.by_miss_reason)} (${result.counts.unjoined_rows} row(s), ${result.counts.unjoined_turns} turn(s))`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
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
  const result = extractSupervisionTurns({
    gate,
    dbPath: args.dbPath,
    sessionsDir: args.sessionsDir,
    sessionFiles: args.sessionFiles,
  });
  if (result.status === "blocked") {
    process.stderr.write(`${result.reason}.\n`);
    return 3;
  }
  const jsonl =
    result.records.length === 0
      ? ""
      : `${result.records.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (args.out) {
    writeFileSync(args.out, jsonl);
    process.stderr.write(`${summarize(result)}\nwrote: ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
    process.stderr.write(`${summarize(result)}\n`);
  }
  return 0;
}

// The exit code, never process.exit: a pipe takes stdout asynchronously, and
// exiting at once drops whatever the reader has not taken yet.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
