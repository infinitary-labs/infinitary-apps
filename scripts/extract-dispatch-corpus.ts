/**
 * C5 - the dispatch extractor (PoC-2 capture; design record
 * `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3).
 *
 * Reconstructs the Firstmate's own six-way classify-first orchestrator turns
 * - the G3 (dispatch class) / G4 (restraint) / G5 (output contract) dataset -
 * from the session JSONL the app already writes, joined to the `tasks`,
 * `repos` and `cards` tables. PoC-1 had to hand-build a 40-record synthetic
 * dispatch corpus; the captain's ordinary usage produces this one for free.
 * A session served by either seat is read through the one Firstmate session
 * reader (`src/core/storage/sessionReader.ts`), which hands a
 * Claude-served session over in the Pi dialect, so everything below reads
 * Pi entries.
 *
 * Its parts live in `scripts/dispatch-corpus/`: the turns and their classes
 * (`dispatchTurns.ts`), the fleet tables (`fleetTables.ts`), the cards
 * (`cards.ts`), the session files (`sessionFiles.ts`) and the userData
 * folder (`userData.ts`). This file joins them into labelled records and is
 * the command.
 *
 * Offline dev tool: no schema change, no product surface, no telemetry, and
 * nothing leaves the box. Reads are strictly read-only.
 *
 * Run it (Node 24 strips the types):
 *   pnpm extract:dispatch --out corpus.jsonl
 *   pnpm extract:dispatch --user-data /path/to/exported/userData --out corpus.jsonl
 *
 * The live transcripts and firstmate.db live on whichever machine the captain
 * dogfoods on, so every input is a parameter with a sensible default: point
 * `--user-data` at an exported copy and the same run works anywhere.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep } from "../src/core/observe/redact.ts";
import {
  cardIdFromEmitResult,
  cardVersionAt,
  cardWordOf,
  chosenEffectOf,
  declaredActionsOf,
  pickByTitle,
  resolutionOf,
} from "./dispatch-corpus/cards.ts";
import {
  CARD_TOOL,
  classifyTurn,
  type DispatchClass,
  type DispatchTurn,
  extractTurnsFromJsonl,
  inferClassFromNames,
  SETTLE_TOOLS,
  SPAWN_TOOLS,
  STEER_TOOLS,
  stringArg,
} from "./dispatch-corpus/dispatchTurns.ts";
import {
  EMPTY_TABLES,
  type FleetTables,
  readFleetTables,
  type TaskRow,
} from "./dispatch-corpus/fleetTables.ts";
import {
  readSessionFile,
  resolveSessionFiles,
  type SessionSources,
  splitBackupCopies,
} from "./dispatch-corpus/sessionFiles.ts";
import { defaultUserDataDir } from "./dispatch-corpus/userData.ts";

type JsonRecord = Record<string, unknown>;

// --------------------------------------------------------------------------
// The joins: tasks, repos, cards
// --------------------------------------------------------------------------

export type TaskJoin = {
  task_id: string;
  via: string;
  found: boolean;
  title?: string;
  status?: string;
  kind?: string;
  repo_id?: string | null;
  repo_name?: string | null;
  delivery?: string | null;
  autonomy?: boolean | null;
  created_at?: number;
  /**
   * The routing shape and its outcome (intelligence-bucket routing S2).
   * `shape` is what the host took the work to BE - the kind a classifier
   * established, the basis it verified, the captain's premium ask or model
   * override - and `rule` the row of the policy table that read it
   * (`src/shared/routingPolicy.ts`). `tier` is the slot asked for. Together
   * they are the label this corpus lacked: the input beside the decision.
   * Null on rows routed before the shape existed.
   */
  shape?: JsonRecord | null;
  tier?: string | null;
  /**
   * The delivery rigor the host stamped on the shape (delivery rigor phase
   * 2). A row without one - dispatched before the tier existed - is `quick`:
   * nothing derived a rigor and the crewmate was told no procedure, so that
   * is what it shipped at, never an unknown.
   */
  rigor?: string;
  /**
   * What the task DELIVERS (crew-posture rationalization Task B): `answer`
   * for work that finds something out and lands one card, `change` for work
   * that ships one. A row shaped before the axis existed reads `change`,
   * which is what it shipped - never an unknown.
   */
  deliverable?: string;
  rule?: string | null;
  /**
   * The tier the ladder actually served (S5). Equal to `tier` when the slot
   * the policy asked for could serve, weaker when it fell back, and null on
   * a row routed before the column - never assumed equal.
   */
  served?: string | null;
  /**
   * The review facts (delivery rigor phase 3). `review_of` is the builder a
   * review task reads, off its shape; `review_verdict` and `review_risk`
   * are the latest verdict recorded on a BUILDER's delivery facts. Null
   * where the record carries none - a pre-phase-2 database has no review
   * anywhere and exports every one of them null.
   */
  review_of?: string | null;
  review_verdict?: string | null;
  review_risk?: string | null;
};

export type CardJoin = {
  card_id: string | null;
  kind: string;
  title: string;
  found: boolean;
  /** How the card row was reached: the id the tool returned, the task
   * timeline's own `card_raised` row, or - last and weakest - its title. */
  joined_via?: "tool-result-id" | "task-event" | "title";
  /** The work the card is about: the timeline says so, or the card row's own
   * column, or the decision record the host filed for a task-less card. */
  task_id?: string | null;
  task_via?: "task-event" | "cards.task_id" | "decision-record" | null;
  /** The persisted body and declared actions from the version that was shown. */
  body?: string;
  actions?: JsonRecord[];
  author?: string | null;
  status?: string;
  created_at?: number;
  resolved_at?: number | null;
  chosen_action?: string | null;
  /**
   * What the chosen action DECLARED (P1's one semantics). Read off the
   * card's own actions, never guessed from the id - a settle is a host
   * teardown, an open is a shell navigation, and only an action with no
   * effect on a crewmate's card ever reached the crewmate as a steer.
   */
  chosen_effect?: JsonRecord | null;
  /** `declared` when the row carried the effect; `legacy-id` when it was
   * derived from a pre-P1 reserved id, which is recorded, never rewritten. */
  effect_source?: "declared" | "legacy-id" | null;
  /** What the captain's click actually did, from the effect above. */
  captain_contact?: "steer" | "settle" | "open" | "dismissed" | "withdrawn" | "none";
  /** Who resolved it, from the timeline's actor-labelled `card_resolved`. */
  resolved_by?: string | null;
  /** How many superseded versions the card lineage kept (WI-12). */
  revisions?: number;
  /** Which persisted version supplied this turn's title/body/actions. */
  actions_version?: "current" | "revision" | "unknown";
  /**
   * open    still on the stack
   * acted   the captain chose one of the card's own declared actions
   * dismissed the captain dismissed it without choosing
   * retired the host or the emitter withdrew it - not a captain answer at all
   * unknown no persisted version covers the emit turn
   */
  resolution?: "open" | "acted" | "dismissed" | "retired" | "unknown";
  /** The captain-confirmed duplicate label (WI-14), when stamped. */
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  duplicate_at?: number | null;
};

export type DispatchRecord = DispatchTurn & {
  inferred: DispatchClass | "answer-or-ask";
  observed_class: DispatchClass;
  classes: DispatchClass[];
  restraint: {
    tool_calls: number;
    spawns: number;
    steers: number;
    cards: number;
    decision_cards: number;
    note_cards: number;
  };
  outcome: { tasks: TaskJoin[]; cards: CardJoin[] };
  label: {
    /**
     * The class the Firstmate actually took. Weak by construction, and
     * NULL when nothing but a card's shape was available to read it from.
     */
    gold_class: DispatchClass | null;
    weak: true;
    /** Explicit: no gold intent could be established for this turn. */
    unknown: boolean;
    /** What `observed_class` rests on (see `classifyTurn`). */
    basis: "tool" | "card-shape" | "fallback";
    confidence: "corroborated" | "observed" | "contradicted";
    evidence: string[];
  };
};

/**
 * `Commissioned crewmate 1 on task ab12.` / `Queued task ab12; …` /
 * `Planned FI3-310 "<title>" (task_id ab12) - starts on request.` → `ab12`.
 * The id a planned task's result names wins over the words of its title.
 */
export function taskIdFromSpawnResult(text: string): string | null {
  const match = text.match(/\(task_id ([A-Za-z0-9_-]+)\)/) ?? text.match(/\btask ([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

function joinTask(taskId: string, via: string, tables: FleetTables): TaskJoin {
  const task = tables.tasks.get(taskId);
  if (!task) return { task_id: taskId, via, found: false };
  const repo = task.repo_id ? tables.repos.get(task.repo_id) : undefined;
  return {
    task_id: taskId,
    via,
    found: true,
    title: task.title,
    status: task.status,
    kind: task.kind,
    repo_id: task.repo_id,
    repo_name: repo?.name ?? null,
    delivery: repo?.delivery ?? null,
    autonomy: repo ? repo.autonomy === 1 : null,
    shape: parseShape(task.shape_json),
    tier: task.difficulty,
    rigor: rigorOf(parseShape(task.shape_json)),
    deliverable: deliverableOf(parseShape(task.shape_json)),
    rule: tables.routing.get(taskId)?.rule ?? null,
    served: tables.routing.get(taskId)?.served ?? null,
    ...reviewOf(task, parseShape(task.shape_json)),
  };
}

/** The deliverable a shape carries; a shape from before the axis is a change. */
function deliverableOf(shape: JsonRecord | null): string {
  const deliverable = shape?.deliverable;
  return deliverable === "answer" ? "answer" : "change";
}

/** The rigor a shape carries; a shape from before it, or no shape, is quick. */
function rigorOf(shape: JsonRecord | null): string {
  const rigor = shape?.rigor;
  return typeof rigor === "string" && rigor ? rigor : "quick";
}

/**
 * The review facts (phase 3): the builder a review task reads - its PARENT,
 * the one stored join since the `review_of` fold (captain-approved
 * 2026-09-19) - and the verdict and risk recorded on a builder's delivery
 * facts. Null wherever the record carries none - never a guessed verdict.
 */
function reviewOf(
  task: TaskRow,
  shape: JsonRecord | null,
): { review_of: string | null; review_verdict: string | null; review_risk: string | null } {
  const of = shape?.kind === "review" ? task.parent_id : null;
  const delivery = parseShape(task.delivery_json);
  const verdict = delivery?.reviewVerdict;
  const risk = delivery?.reviewRisk;
  return {
    review_of: typeof of === "string" && of ? of : null,
    review_verdict: typeof verdict === "string" && verdict ? verdict : null,
    review_risk: typeof risk === "string" && risk ? risk : null,
  };
}

/** The stored `WorkShape`, or null when the row has none or it is unreadable. */
function parseShape(json: string | null): JsonRecord | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

export type BuildOptions = {
  /**
   * False when no database was available: the joins are then absent
   * evidence, not counter-evidence, and no label may be contradicted by
   * a row that was never read.
   */
  joined?: boolean;
};

/** One turn + the tables → a labelled dispatch record. */
export function buildRecord(
  turn: DispatchTurn,
  tables: FleetTables,
  options: BuildOptions = {},
): DispatchRecord {
  const joined = options.joined ?? true;
  const { primary, classes, basis } = classifyTurn(turn.names, turn.cardKinds);
  const tasks: TaskJoin[] = [];
  const cards: CardJoin[] = [];
  for (const call of turn.calls) {
    if (SPAWN_TOOLS.includes(call.name)) {
      const taskId = call.result ? taskIdFromSpawnResult(call.result.text) : null;
      if (taskId) tasks.push(joinTask(taskId, call.name, tables));
      continue;
    }
    if (STEER_TOOLS.includes(call.name) || SETTLE_TOOLS.includes(call.name)) {
      const taskId = stringArg(call.args, "task_id");
      if (taskId) tasks.push(joinTask(taskId, call.name, tables));
      continue;
    }
    if (call.name === CARD_TOOL) {
      const recordedKind = stringArg(call.args, "kind");
      const kind = recordedKind ?? cardWordOf(call.args);
      const title = stringArg(call.args, "title") ?? "";
      const cardId = call.result ? cardIdFromEmitResult(call.result.text) : null;
      const observedAt = call.result?.at;
      const byId = cardId ? tables.cards.get(cardId) : undefined;
      // Older results carry no id: fall back to the emitted title, which the
      // store keeps verbatim, and only when it is unambiguous.
      const byTitle = byId
        ? undefined
        : pickByTitle(
            tables.cardsByTitle.get(title),
            title,
            observedAt ?? turn.at,
            tables.cardRevisions,
          );
      const row = byId ?? byTitle;
      if (!row) {
        cards.push({ card_id: cardId, kind, title, found: false });
        continue;
      }
      const raised = tables.cardRaised.get(row.id);
      const resolved = tables.cardResolved.get(row.id);
      const decision = tables.decisionByCard.get(row.id);
      const work = raised?.taskId ?? row.task_id ?? decision?.id ?? null;
      const revisions = tables.cardRevisions.get(row.id) ?? [];
      const version =
        observedAt === undefined || observedAt === null
          ? revisions.length === 0
            ? cardVersionAt(row, revisions, turn.at)
            : null
          : cardVersionAt(row, revisions, observedAt);
      const actions = version ? declaredActionsOf(version.actions_json) : [];
      const legacy =
        version !== null && (recordedKind !== undefined || version.kind !== "card");
      const resolution = version
        ? resolutionOf({ ...row, actions_json: version.actions_json }, resolved, { legacy })
        : row.resolved_at === null
          ? "open"
          : "unknown";
      cards.push({
        card_id: row.id,
        kind,
        title: version?.title ?? title,
        found: true,
        joined_via: byId ? "tool-result-id" : "title",
        task_id: work,
        task_via: raised
          ? "task-event"
          : row.task_id
            ? "cards.task_id"
            : decision
              ? "decision-record"
              : null,
        ...(version ? { body: version.body, actions } : {}),
        actions_version: version?.basis ?? "unknown",
        author: row.author,
        status: row.status,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        chosen_action: row.chosen_action,
        ...chosenEffectOf(actions, row.chosen_action, resolution, {
          legacy,
          cardId: row.id,
          author: row.author,
        }),
        resolved_by: resolved?.actor ?? null,
        revisions: revisions.length,
        resolution,
        duplicate_of: row.duplicate_of ?? null,
        duplicate_note: row.duplicate_note ?? null,
        duplicate_at: row.duplicate_at ?? null,
      });
      // The work a decision joins to is part of the turn's outcome: without
      // it a card-only turn had no task at all in the record.
      if (work && !tasks.some((task) => task.task_id === work)) {
        tasks.push(joinTask(work, "emit_card", tables));
      }
    }
  }

  const evidence: string[] = [];
  let confidence: DispatchRecord["label"]["confidence"] = "observed";
  const referenced = joined ? tasks : [];
  if (!joined && (tasks.length > 0 || cards.length > 0)) {
    evidence.push("no database was joined, so the turn's effects are unverified");
  }
  if (referenced.length > 0) {
    if (referenced.every((task) => task.found)) {
      confidence = "corroborated";
      for (const task of referenced) {
        evidence.push(`task ${task.task_id} (${task.via}) is ${task.status} in tasks`);
      }
    } else {
      confidence = "contradicted";
      for (const task of referenced.filter((t) => !t.found)) {
        evidence.push(`task ${task.task_id} (${task.via}) has no row in tasks`);
      }
    }
  }
  const decisionCards = joined ? cards.filter((card) => card.kind === "decision") : [];
  for (const card of decisionCards) {
    if (!card.found) continue;
    if (card.resolution === "acted") {
      if (confidence !== "contradicted") confidence = "corroborated";
      evidence.push(
        `decision card ${card.card_id} answered with "${card.chosen_action}" (${card.captain_contact})`,
      );
    } else if (card.resolution === "dismissed") {
      confidence = "contradicted";
      evidence.push(`decision card ${card.card_id} was dismissed without an action`);
    } else if (card.resolution === "retired") {
      // Withdrawn by the host or its emitter: the captain never answered it,
      // so it neither corroborates nor contradicts anything.
      evidence.push(
        `decision card ${card.card_id} was withdrawn ("${card.chosen_action}"), not answered`,
      );
    } else if (card.resolution === "unknown") {
      evidence.push(`decision card ${card.card_id} has no persisted version covering this turn`);
    } else {
      evidence.push(`decision card ${card.card_id} is still open`);
    }
  }
  if (turn.turnFailed) {
    evidence.push("the provider turn failed, so the tools are not the whole decision");
  }

  const label = goldLabel(primary, basis, confidence, evidence);
  if (
    turn.kind_basis === "ambiguous-framing" ||
    cards.some((card) => card.actions_version === "unknown")
  ) {
    label.gold_class = null;
    label.unknown = true;
    label.evidence.push(
      turn.kind_basis === "ambiguous-framing"
        ? "turn framing is ambiguous: no captain boundary was established"
        : "a joined card has no persisted version covering this turn",
    );
  }

  return redactDeep({
    ...turn,
    inferred: inferClassFromNames(turn.names),
    observed_class: primary,
    classes,
    restraint: {
      tool_calls: turn.calls.length,
      spawns: turn.names.filter((n) => SPAWN_TOOLS.includes(n)).length,
      steers: turn.names.filter((n) => STEER_TOOLS.includes(n)).length,
      cards: turn.cardKinds.length,
      decision_cards: turn.cardKinds.filter((k) => k === "decision").length,
      note_cards: turn.cardKinds.filter((k) => k === "note").length,
    },
    outcome: { tasks, cards },
    label,
  });
}

/**
 * The honest label. A class the turn's own tools exercised is a (weak)
 * gold target; a class read off the SHAPE of a card it emitted is not - a
 * card with actions reads as a decision, which says how the host dresses
 * it, not what the Firstmate set out to do. Such a turn now exports with no
 * gold class and `unknown: true` rather than a guess a trainer would read
 * as ground truth.
 */
function goldLabel(
  primary: DispatchClass,
  basis: "tool" | "card-shape" | "fallback",
  confidence: DispatchRecord["label"]["confidence"],
  evidence: string[],
): DispatchRecord["label"] {
  if (basis === "card-shape") {
    return {
      gold_class: null,
      weak: true,
      unknown: true,
      basis,
      confidence,
      evidence: [
        ...evidence,
        `class ${primary} is the emitted card's shape, not an observed move: no gold intent`,
      ],
    };
  }
  return { gold_class: primary, weak: true, unknown: false, basis, confidence, evidence };
}

// --------------------------------------------------------------------------
// The extractor
// --------------------------------------------------------------------------

export type ExtractOptions = SessionSources & {
  dbPath?: string;
  /** Keep `[fm-op]` operational wakes (default true - they are dispatch too). */
  includeOps?: boolean;
};

export type ExtractResult = {
  records: DispatchRecord[];
  /** The transcripts actually read, after the backup copies were excluded. */
  sources: string[];
  dbPath: string | null;
  skippedOps: number;
  /** Files dropped as a second copy of a session already read. */
  backupCopies: string[];
  /** Turns those copies would have contributed - the double count avoided. */
  backupRecordsExcluded: number;
  /** Entries dropped as history a forked session copied from its parent. */
  copiedEntriesExcluded: number;
};

export function extractDispatchCorpus(options: ExtractOptions): ExtractResult {
  const dbPath = options.dbPath && existsSync(options.dbPath) ? options.dbPath : null;
  const tables = dbPath ? readFleetTables(dbPath) : EMPTY_TABLES;
  const files = resolveSessionFiles(options, dbPath);
  const { kept, backups } = splitBackupCopies(files.map(readSessionFile));
  const records: DispatchRecord[] = [];
  // A forked session file carries its parent's entries verbatim (ids and
  // all), so an entry read once is never read again - within this run the
  // copied history is history, not a second turn.
  const seenEntryIds = new Set<string>();
  let skippedOps = 0;
  for (const file of kept) {
    const turns = extractTurnsFromJsonl(file.raw, file.path, { seenEntryIds });
    for (const turn of turns) {
      if (turn.kind === "op" && options.includeOps === false) {
        skippedOps += 1;
        continue;
      }
      records.push(buildRecord(turn, tables, { joined: dbPath !== null }));
    }
  }
  const entriesRead = seenEntryIds.size;
  const copiedEntriesExcluded = kept.reduce((sum, file) => sum + file.entries, 0) - entriesRead;
  // What the excluded copies WOULD have added, counted the same way the
  // kept files are: the number is the point of the exclusion.
  let backupRecordsExcluded = 0;
  for (const file of backups) {
    const turns = extractTurnsFromJsonl(file.raw, file.path, { seenEntryIds: new Set() });
    backupRecordsExcluded += turns.filter(
      (turn) => !(turn.kind === "op" && options.includeOps === false),
    ).length;
  }
  records.sort((a, b) => a.at - b.at || a.turn_index - b.turn_index);
  return {
    records,
    sources: kept.map((file) => file.path),
    dbPath,
    skippedOps,
    backupCopies: backups.map((file) => file.path),
    backupRecordsExcluded,
    copiedEntriesExcluded,
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export type CliArgs = {
  userData: string;
  sessionsDir: string;
  claudeSessionsDir: string;
  dbPath: string;
  sessionFiles: string[];
  out: string | null;
  includeOps: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let sessionsDir: string | null = null;
  let claudeSessionsDir: string | null = null;
  let dbPath: string | null = null;
  const sessionFiles: string[] = [];
  let out: string | null = null;
  let includeOps = true;
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
    else if (arg === "--db") dbPath = next();
    else if (arg === "--session-file") sessionFiles.push(next());
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--user-turns-only") includeOps = false;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    userData,
    sessionsDir: sessionsDir ?? join(userData, "firstmate", "sessions"),
    claudeSessionsDir: claudeSessionsDir ?? join(userData, "firstmate", "claude"),
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    sessionFiles,
    out,
    includeOps,
    help,
  };
}

const USAGE = `Extract the Infinitary dispatch corpus (PoC-2 C5) from the Firstmate's sessions + firstmate.db.

  pnpm extract:dispatch [options]      (or: node scripts/extract-dispatch-corpus.ts)

  --user-data <dir>     app userData dir (default: the platform userData path,
                        or INFINITARY_USER_DATA_DIR); an exported copy works too
  --sessions <dir>      transcripts dir (default: <user-data>/firstmate/sessions)
  --claude-sessions <dir>
                        Claude-served transcripts (default: <user-data>/firstmate/claude)
  --db <path>           firstmate.db (default: <user-data>/firstmate.db)
  --session-file <path> one transcript; repeatable, overrides --sessions
  --out, -o <path>      write JSONL here (default: stdout)
  --user-turns-only     drop [fm-op] operational wakes
  --help, -h

Everything stays on this machine: it reads, it never writes to the app.`;

export function summarize(result: ExtractResult): string {
  const byClass = new Map<string, number>();
  for (const record of result.records) {
    byClass.set(record.observed_class, (byClass.get(record.observed_class) ?? 0) + 1);
  }
  const classes = [...byClass.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  const corroborated = result.records.filter((r) => r.label.confidence === "corroborated").length;
  const unknown = result.records.filter((r) => r.label.unknown).length;
  return [
    `sources: ${result.sources.length} transcript(s)`,
    `db: ${result.dbPath ?? "none (records carry no joins)"}`,
    `records: ${result.records.length} (${corroborated} corroborated by the join, ` +
      `${unknown} with no gold intent)`,
    `classes: ${classes || "none"}`,
    `excluded: ${result.backupCopies.length} backup copy/copies ` +
      `(${result.backupRecordsExcluded} turn(s)), ` +
      `${result.copiedEntriesExcluded} copied entry/entries`,
  ].join("\n");
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
  const result = extractDispatchCorpus({
    sessionFiles: args.sessionFiles,
    sessionsDir: args.sessionsDir,
    claudeSessionsDir: args.claudeSessionsDir,
    dbPath: args.dbPath,
    includeOps: args.includeOps,
  });
  if (result.sources.length === 0) {
    process.stderr.write(
      `No transcripts found in ${args.sessionsDir} or ${args.claudeSessionsDir}. Point --user-data or --sessions at an exported copy.\n`,
    );
    return 1;
  }
  const jsonl = `${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
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
