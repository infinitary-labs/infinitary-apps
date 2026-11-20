import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { FmEvent } from "@shared/events";
import {
  FIRSTMATE_SESSION_ID,
  NO_SESSION_YET,
  type ObserveCardThread,
  type ObserveLive,
  type ObserveRouting,
  type ObserveSessionDetail,
  type ObserveSessionStatus,
  type ObserveSessionSummary,
  type ObserveTurn,
  type ObserveUsageTotals,
} from "@shared/observe";
import type { AppDatabase } from "../storage/db";
import { DecisionStore, type RoutingDecision } from "../storage/decisionStore";
import { sessionDialectOf } from "../storage/sessionReader";
import type { SettingsStore } from "../storage/settingsStore";
import type { TaskRecord } from "../storage/taskRecords";
import { UsageStore } from "../storage/usageStore";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { claudeTranscript } from "./claudeTranscript";
import { OBSERVE_DISABLED_MESSAGE } from "./gate";
import { ObserveLiveBuffer } from "./liveBuffer";
import { emptyParsedSession, type ParsedSession, sessionJsonl, userTurns } from "./transcript";
import {
  type CrewmateTranscriptResolver,
  type CrewmateTranscriptSource,
  piOnlyTranscriptResolver,
} from "./transcriptSource";

export type ObserveLiveStatus = {
  firstmateBusy: boolean;
  firstmateModel: { provider: string; id: string } | null;
  /**
   * The attached Firstmate session's file, whichever seat serves it; absent
   * or null reads the Pi seat's recorded rolling session.
   */
  firstmateSessionFile?: string | null;
};

export type ObserveServiceOptions = {
  enabled: boolean;
  db: AppDatabase;
  tasks: TaskService;
  settings: SettingsStore;
  repos: RepoRegistry;
  liveStatus?: () => ObserveLiveStatus;
  /** Where a crewmate's transcript lives, by the backend that ran it. */
  crewmateTranscript?: CrewmateTranscriptResolver;
  /** Open card threads on a session, for the detail pane (cards-as-threads phase 2). */
  cardThreads?: (sessionId: string) => ObserveCardThread[];
};

type TaskUsage = ObserveUsageTotals & {
  model: string | null;
  lastAt: number | null;
  firstAt: number | null;
};

/** The newest routing decision for a task, as the column set stands (S5). */
type RoutingDecisionRow = Pick<RoutingDecision, "rule" | "served">;

type ReadSession = {
  parsed: ParsedSession;
  /** False when a path was given but could not be read. */
  readable: boolean;
  backend?: "pi" | "claude";
};

type Summarized = {
  summary: ObserveSessionSummary;
  parsed: ParsedSession;
  /** What the detail shows when no transcript could be read. */
  fallbackTurns: ObserveTurn[];
};

const BRIEF_FROM_RECORD = "The brief below is from the task record.";

/**
 * Read-only view over existing session JSONL + usage_events. No second
 * store (docs/dev-observe.md): the main Firstmate and each crewmate's
 * transcript. Retired files stay on disk for offline evidence, not here.
 */
type CachedRead = ReadSession & {
  path: string;
  parser: "pi" | "claude" | "firstmate";
  summaryOnly: boolean;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
};

export class ObserveService {
  private readonly crewmateTranscript: CrewmateTranscriptResolver;
  private readonly liveBuffer = new ObserveLiveBuffer();
  private readonly usage: UsageStore;
  private readonly decisions: DecisionStore;
  /** One current file per session, shared by list/detail. Even live files
   * need no reparse between writes. Stat before reading; a concurrent append
   * then invalidates the entry on the next read. Never cache failed reads. */
  private readonly reads = new Map<string, CachedRead>();
  /** Transcript parses performed, for the test that pins the cache. */
  transcriptParses = 0;
  /** Serialize a session's reads so list and detail cannot race a cache replacement. */
  private readonly pending = new Map<string, Promise<ReadSession>>();

  constructor(private readonly options: ObserveServiceOptions) {
    this.crewmateTranscript = options.crewmateTranscript ?? piOnlyTranscriptResolver;
    this.usage = new UsageStore(options.db);
    this.decisions = new DecisionStore(options.db);
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Every broadcast event passes through here so a session's in-flight
   * turn is readable (`live`) without a second event stream. Cheap when
   * disabled: nothing is kept.
   */
  onEvent(event: FmEvent): void {
    if (this.options.enabled) this.liveBuffer.apply(event);
  }

  /** The selected session's turn in flight; empty between turns. */
  live(sessionId: string): ObserveLive {
    this.assertEnabled();
    return this.liveBuffer.read(sessionId);
  }

  async list(): Promise<ObserveSessionSummary[]> {
    this.assertEnabled();
    const usage = this.usageByTask();
    const routing = this.routingByTask();
    const live = this.liveStatus();
    const crew: ObserveSessionSummary[] = [];
    for (const task of this.options.tasks.list().slice().reverse()) {
      crew.push(
        (await this.crewmate(task, usage.get(task.id), routing.get(task.id), true)).summary,
      );
    }
    const ids = new Set([FIRSTMATE_SESSION_ID, ...crew.map((row) => row.id)]);
    for (const id of this.reads.keys()) if (!ids.has(id)) this.reads.delete(id);
    return [(await this.firstmate(usage.get(FIRSTMATE_SESSION_ID), live, true)).summary, ...crew];
  }

  /**
   * Only the selected session needs turns. Its detail supplies the list's
   * metadata too while unchanged; a summary-only cache is upgraded on selection.
   */
  async detail(sessionId: string): Promise<ObserveSessionDetail> {
    this.assertEnabled();
    const usage = this.usageByTask(sessionId).get(sessionId);
    const summarized = await this.summarize(
      sessionId,
      usage,
      this.routingByTask(sessionId).get(sessionId),
    );
    if (!summarized) throw new Error(`Unknown session "${sessionId}"`);
    const { summary, parsed, fallbackTurns } = summarized;
    const open =
      summary.status === "streaming" || summary.status === "idle" || summary.status === "none";
    return {
      ...summary,
      startedAt: summary.startedAt ?? parsed.startedAt,
      endedAt: open ? summary.endedAt : (summary.endedAt ?? parsed.endedAt),
      model: summary.model ?? parsed.model,
      error: summary.error ?? parsed.error,
      authFailure: summary.authFailure || parsed.authFailure,
      turns: summary.transcriptNote === null ? parsed.turns : fallbackTurns,
      threads: this.options.cardThreads?.(sessionId) ?? [],
    };
  }

  private async summarize(
    sessionId: string,
    usage: TaskUsage | undefined,
    routed: RoutingDecisionRow | undefined,
  ): Promise<Summarized | undefined> {
    if (sessionId === FIRSTMATE_SESSION_ID) return this.firstmate(usage, this.liveStatus());
    const task = this.options.tasks.get(sessionId);
    return task ? this.crewmate(task, usage, routed) : undefined;
  }

  private liveStatus(): ObserveLiveStatus {
    return (
      this.options.liveStatus?.() ?? {
        firstmateBusy: false,
        firstmateModel: this.options.settings.getFirstmateModel(),
      }
    );
  }

  private async firstmate(
    usage: TaskUsage | undefined,
    live: ObserveLiveStatus,
    summaryOnly = false,
  ): Promise<Summarized> {
    const file = live.firstmateSessionFile ?? this.options.settings.getFirstmateSessionFile();
    const { parsed, readable, backend } = await this.read(
      FIRSTMATE_SESSION_ID,
      file,
      "firstmate",
      summaryOnly,
    );
    const model = modelLabel(live.firstmateModel) ?? parsed.model ?? usage?.model ?? null;
    const status: ObserveSessionStatus = live.firstmateBusy ? "streaming" : file ? "idle" : "none";
    return {
      summary: {
        id: FIRSTMATE_SESSION_ID,
        kind: "orchestrator",
        title: "First mate",
        taskId: FIRSTMATE_SESSION_ID,
        repo: null,
        model,
        status,
        startedAt: parsed.startedAt ?? usage?.firstAt ?? null,
        endedAt: null,
        usage: usage ? stripUsage(usage) : null,
        error: parsed.error,
        authFailure: parsed.authFailure,
        // Whichever seat wrote the file, by the one reader's rule.
        backend: backend ?? "pi",
        transcriptNote: singletonNote(file, readable),
        routing: null,
      },
      parsed,
      fallbackTurns: [],
    };
  }

  private async crewmate(
    task: TaskRecord,
    usage: TaskUsage | undefined,
    routed?: RoutingDecisionRow,
    summaryOnly = false,
  ): Promise<Summarized> {
    const source = this.crewmateTranscript(task);
    const { parsed, readable } = await this.readCrewmate(task.id, source, summaryOnly);
    const status = crewmateStatus(task);
    const repo = task.repoId
      ? (this.options.repos.get(task.repoId)?.name ?? null)
      : "default workspace";
    const terminal =
      status === "done" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted";
    return {
      summary: {
        id: task.id,
        kind: "crewmate",
        title: task.title,
        taskId: task.id,
        repo,
        model: parsed.model ?? usage?.model ?? null,
        status,
        startedAt: task.createdAt,
        endedAt: terminal ? (usage?.lastAt ?? parsed.endedAt) : null,
        usage: usage ? stripUsage(usage) : null,
        error: parsed.error,
        // The transcript's provider-error tracking is the one auth authority
        // (never substring-classified from arbitrary error text here).
        authFailure: parsed.authFailure,
        backend: source.backend,
        transcriptNote: crewmateNote(task, source, readable),
        routing: this.routingOf(task, routed),
      },
      parsed,
      // With no transcript to read, the brief the host sent is still real
      // content from the task row - shown instead of an empty pane.
      fallbackTurns:
        !summaryOnly && !readable && task.prompt
          ? userTurns(`${task.id}:brief`, task.createdAt, task.prompt)
          : [],
    };
  }

  /**
   * A crewmate row's routing facts. The builder a review reads is its
   * parent - the one stored join - and the review whose verdict the
   * builder carries is read off that same edge.
   */
  private routingOf(
    task: TaskRecord,
    routed: RoutingDecisionRow | undefined,
  ): ObserveRouting | null {
    const builder =
      task.shape?.kind === "review" && task.parentId
        ? this.options.tasks.get(task.parentId)
        : undefined;
    return routingFacts(
      task,
      routed,
      builder,
      builder ? this.options.tasks.graph.verdictReviewOf(builder)?.id : undefined,
    );
  }

  private readCrewmate(
    id: string,
    source: CrewmateTranscriptSource,
    summaryOnly: boolean,
  ): Promise<ReadSession> {
    return this.read(
      id,
      source.backend === "pi" || source.backend === "claude" ? source.path : null,
      source.backend === "claude" ? "claude" : "pi",
      summaryOnly,
    );
  }

  private read(
    id: string,
    path: string | null,
    parser: CachedRead["parser"],
    summaryOnly: boolean,
  ): Promise<ReadSession> {
    const previous = this.pending.get(id);
    const next = (previous ?? Promise.resolve()).then(() =>
      this.readFile(id, path, parser, summaryOnly),
    );
    this.pending.set(id, next);
    void next.finally(() => {
      if (this.pending.get(id) === next) this.pending.delete(id);
    });
    return next;
  }

  private async readFile(
    id: string,
    path: string | null,
    parser: CachedRead["parser"],
    summaryOnly: boolean,
  ): Promise<ReadSession> {
    if (!path) {
      this.reads.delete(id);
      return { parsed: emptyParsedSession(), readable: false };
    }
    try {
      const { mtimeMs, ctimeMs, size, ino } = await stat(path);
      const cached = this.reads.get(id);
      if (
        cached &&
        cached.path === path &&
        cached.parser === parser &&
        (summaryOnly || !cached.summaryOnly) &&
        cached.mtimeMs === mtimeMs &&
        cached.ctimeMs === ctimeMs &&
        cached.size === size &&
        cached.ino === ino
      )
        return cached;
      this.transcriptParses += 1;
      const raw = await readFile(path, "utf8");
      const backend = parser === "firstmate" ? (sessionDialectOf(raw) ?? "pi") : parser;
      const lines =
        backend === "claude" ? claudeTranscript(raw, summaryOnly) : sessionJsonl(raw, summaryOnly);
      let work = 0;
      let next = lines.next();
      while (!next.done) {
        work += next.value;
        // Bound uninterrupted parser/redaction work, not the available history.
        // Disk reads already use the filesystem pool; allow input between batches.
        if (work >= 64 * 1024) {
          await setImmediate();
          work = 0;
        }
        next = lines.next();
      }
      const read = { parsed: next.value, readable: true, backend };
      this.reads.set(id, { ...read, path, parser, summaryOnly, mtimeMs, ctimeMs, size, ino });
      return read;
    } catch {
      this.reads.delete(id);
      return { parsed: emptyParsedSession(), readable: false };
    }
  }

  /**
   * The newest routing decision per task (S5). One query for the whole list,
   * like the usage rollup beside it: Observe polls every two seconds and
   * must not pay a query per crewmate. A task that never routed simply has
   * no row - never a guessed rule.
   */
  private routingByTask(taskId?: string): Map<string, RoutingDecisionRow> {
    const rows = this.decisions.routing(taskId === undefined ? {} : { taskIds: [taskId] });
    const map = new Map<string, RoutingDecisionRow>();
    for (const row of rows) map.set(row.taskId, row);
    return map;
  }

  private usageByTask(taskId?: string): Map<string, TaskUsage> {
    const rows = this.usage.byTask(taskId);
    const map = new Map<string, TaskUsage>();
    for (const row of rows) {
      const onlyModel = row.models.length === 1 ? row.models[0] : undefined;
      const model =
        onlyModel?.provider && onlyModel.model
          ? `${onlyModel.provider}/${onlyModel.model}`
          : (onlyModel?.model ?? null);
      map.set(row.task_id, {
        input: row.input ?? 0,
        output: row.output ?? 0,
        cacheRead: row.cache_read ?? 0,
        cacheWrite: row.cache_write ?? 0,
        ...(typeof row.cost === "number" ? { cost: row.cost } : {}),
        turns: row.records,
        records: row.records,
        reported: row.reported,
        priced: row.priced,
        models: row.models,
        model,
        lastAt: row.last_at,
        firstAt: row.first_at,
      });
    }
    return map;
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new Error(OBSERVE_DISABLED_MESSAGE);
    }
  }
}

function singletonNote(file: string | null, readable: boolean): string | null {
  if (!file) return NO_SESSION_YET;
  if (!readable) return `The session file is missing or unreadable (${basename(file)}).`;
  return null;
}

function crewmateNote(
  task: TaskRecord,
  source: CrewmateTranscriptSource,
  readable: boolean,
): string | null {
  if (readable) return null;
  if (source.backend === null) {
    return `The account this crewmate ran on is no longer registered, so its transcript cannot be located. ${BRIEF_FROM_RECORD}`;
  }
  if (task.status === "open") {
    return `Queued: no session until dispatch. ${BRIEF_FROM_RECORD}`;
  }
  if (source.path) {
    return `The transcript is missing or unreadable (${basename(source.path)}). ${BRIEF_FROM_RECORD}`;
  }
  if (source.backend === "claude") {
    return task.sessionFile
      ? `Claude has not written this session's transcript yet; it appears with the first turn. ${BRIEF_FROM_RECORD}`
      : `No session was recorded for this task. ${BRIEF_FROM_RECORD}`;
  }
  return `No session file was recorded for this task. ${BRIEF_FROM_RECORD}`;
}

function modelLabel(model: { provider: string; id: string } | null): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}

/**
 * The record's status, activity and close reason folded onto Observe's
 * session vocabulary (task-system P0). A closed record's session is kept
 * (D2), so Observe can still open it.
 */
/**
 * The routing facts for one crewmate row. Null when the row carries no work
 * shape and no decision was recorded: there is nothing to say, and a header
 * that invented a tier would be worse than one that says nothing. The
 * delivery rigor rides beside them (phase 3): the tier the host derived,
 * a builder's review verdict and risk, and - on a review task - the
 * builder it reads.
 */
function routingFacts(
  task: TaskRecord,
  routed: RoutingDecisionRow | undefined,
  builder: TaskRecord | undefined,
  verdictReviewId: string | undefined,
): ObserveRouting | null {
  if (!task.shape && !routed && !task.difficulty) return null;
  // The verdict lives on the BUILDER's delivery facts, so a review task
  // reads its own answer off the change it read - and only when it is the
  // review that recorded it, so a superseded review never claims a later
  // verdict and a fresh one never claims an earlier one (phase 4: the
  // Review group renders this).
  const source = builder && verdictReviewId === task.id ? builder : task;
  const verdict = source.delivery?.reviewVerdict;
  const risk = source.delivery?.reviewRisk;
  return {
    tier: task.difficulty,
    served: routed?.served ?? null,
    rule: routed?.rule ?? null,
    kind: task.shape?.kind ?? null,
    kindSource: task.shape?.kind_source ?? null,
    rigor: task.shape?.rigor ?? null,
    deliverable: task.shape?.deliverable ?? null,
    review: verdict ? `${verdict}${risk ? ` · risk ${risk}` : ""}` : null,
    reviewOf:
      task.shape?.kind === "review" && task.parentId ? (builder?.title ?? task.parentId) : null,
  };
}

function crewmateStatus(task: TaskRecord): ObserveSessionStatus {
  switch (task.status) {
    case "open":
      // A queued row has no session yet; Observe reads it as idle.
      return "idle";
    case "active":
      if (task.activity === "running" || task.activity === "starting") return "streaming";
      if (task.activity === "interrupted") return "interrupted";
      return "idle";
    case "done":
      return "done";
    case "dropped":
      return task.closedReason === "failed" ? "failed" : "cancelled";
  }
}

function stripUsage(usage: TaskUsage): ObserveUsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    turns: usage.turns,
    records: usage.records,
    reported: usage.reported,
    priced: usage.priced,
    models: usage.models,
  };
}
