import { createHash } from "node:crypto";
import type { CrewResponse } from "@shared/crewResponses";
import { reportSummary } from "@shared/feed";
import type { KeptValidationInput } from "@shared/liveValidation";
import { providerOutageFold, type TypedFailure } from "@shared/plainProblem";
import type { DecisionRecord, InterruptEventData, SteerEventData } from "@shared/provenance";
import type { IntelligenceBucket } from "@shared/quota";
import { type KeptRecoveryWay, recoveryWay, type WorkWait } from "@shared/recovery";
import type { FirstReleaseReport } from "@shared/taskRelease";
import type { HandoverFile } from "@shared/work";
import { redactObserveText } from "../observe/redact";
import { capWithOverflow, MESSAGE_EXCERPT_LIMIT } from "../overflow";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskActivity, TaskRecord } from "../storage/taskRecords";
import { conversationOf, type TaskSession } from "../storage/taskSessionStore";
import type { TaskService } from "./taskService";
import type { TaskWriter } from "./taskWriter";

/** A report saved at its call that no counted report followed (`TaskTurns.keptReport`). */
export type KeptReport = {
  /** The record's event that holds it. */
  eventId: number;
  at: number;
  text: string;
  /** Its one-line headline: the crewmate's own summary, else its first sentence. */
  summary: string;
};

/**
 * What a crewmate's report declared about whose turn follows it (FI3-435):
 * a wait on the captain, with its reason and the card he is to read, or its
 * work finished - at most one; the report tool refuses both. Beside either,
 * a request that the Firstmate act on this report, with its reason
 * (FI3-710): kept on that report's event, and on the record's delivery
 * facts until the next turn starts, like the others, so the idle ladder
 * can raise it again while the Firstmate leaves it unanswered (FI3-714).
 */
/** The captain's words a report passes on, where he typed them and when (INF-3202). */
export type RelayedCaptainWords = { from: string; text: string; at: number };

export type ReportDeclaration = {
  /** Explicit individually correlated answers, saved immediately by the inbox owner. */
  responses?: CrewResponse[];
  firstRelease?: FirstReleaseReport;
  workWait?: WorkWait;
  recoveryWays?: KeptRecoveryWay[];
  validation?: KeptValidationInput;
  wait?: { reason: string; cardId?: string };
  finished?: boolean;
  needsFirstmate?: string;
  /**
   * Where the captain typed the words this report passes on (INF-3202,
   * `captain_words_from`): a card of its own task by id, or `crewmate-tab`.
   */
  captainWordsFrom?: string;
  /**
   * Those words as the host read them there, with when he typed them: kept
   * on the report's event, and offered to work filed from the report as
   * its origin (docs/card-authoring.md "The You asked line").
   */
  captainWords?: RelayedCaptainWords;
  /**
   * The report's typed result (INF-799 piece 1), already checked against
   * the task's `result_schema` when it has one: kept on the report's event,
   * the one record of it (`latestResult` reads the newest, INF-1296).
   */
  result?: Record<string, unknown>;
  /**
   * Files the report hands on (INF-992), as kept and verified: kept name,
   * size and sha256, never content. The first mate's steer delivers them.
   */
  files?: HandoverFile[];
  /**
   * When its crewmate looks again at a job still running, in minutes from
   * the report, and what it waits for (INF-1244, `check_back`): the task's
   * `at-time` gate until then, whose end steers it with the job's facts.
   */
  checkBack?: { minutes: number; waitingFor: string };
  /**
   * The tasks its crewmate says its task waits on (INF-1428, `waits_on`),
   * already resolved to live tasks: each is recorded as a `blocks` link
   * from it, a recorded wait that holds its start and merge (`TaskService.graph.linkWaits`).
   */
  waitsOn?: string[];
};

/**
 * F4/F5 of INF-1554: one durable boundary for recovery facts. Scalar excerpts
 * use the existing 300-character declaration band; the list uses the shared
 * message band. Full details spill through the existing overflow owner.
 * A long fact keeps its content digest, so a changed tail is never mistaken
 * for the same observation after clipping, and identical facts stay equal.
 */
function reportRecoveryOf(declared: ReportDeclaration | undefined) {
  let overflow = false;
  const short = (text: string) => {
    if (text.length <= 300) return text;
    overflow = true;
    const digest = ` [sha256:${createHash("sha256").update(text).digest("hex")}]`;
    return text.slice(0, 300 - digest.length) + digest;
  };
  const wait = declared?.workWait;
  const workWait = wait
    ? {
        ...(wait.owner ? { owner: short(wait.owner) } : {}),
        ...(wait.end ? { end: short(wait.end) } : {}),
        observation: short(wait.observation),
        cheapestWay: short(wait.cheapestWay),
      }
    : undefined;
  const ways: KeptRecoveryWay[] = [];
  let size = 2; // The array's brackets, then each serialized item and its comma.
  for (const way of declared?.recoveryWays ?? []) {
    const bounded = {
      action: short(way.action),
      ...(way.approach ? { approach: short(way.approach) } : {}),
      hold: short(way.hold),
      evidence: short(way.evidence),
      nextFact: short(way.nextFact),
    };
    const next = JSON.stringify(recoveryWay(bounded)).length + (ways.length ? 1 : 0);
    if (size + next > MESSAGE_EXCERPT_LIMIT) {
      overflow = true;
      break;
    }
    ways.push(bounded);
    size += next;
  }
  return {
    ...(workWait ? { workWait } : {}),
    ...(ways.length ? { recoveryWays: ways } : {}),
    ...(overflow
      ? {
          overflow: capWithOverflow(
            JSON.stringify({ workWait: wait, recoveryWays: declared?.recoveryWays }),
            "report-recovery",
            { limit: 0, force: true },
          ),
        }
      : {}),
  };
}

function hasDeclaration(record: TaskRecord): boolean {
  return (
    Boolean(record.delivery?.captainWait) ||
    record.delivery?.finishedAt !== undefined ||
    Boolean(record.delivery?.needsFirstmate) ||
    Boolean(record.delivery?.checkBack)
  );
}

/**
 * A crewmate's turns: its activity and idle clock, its session file, the
 * reports and declarations it makes, and the steers, interrupts, replies and
 * escalations around them. Reached as `tasks.turns`.
 */
export class TaskTurns {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  setActivity(id: string, activity: TaskActivity): void {
    const run = this.writer.write(() =>
      this.writer.patch(id, { activity, updatedAt: this.writer.now() }),
    );
    run();
  }

  /**
   * An idle boundary (docs/report-sort.md, "The idle ladder"): the idle
   * clock starts, unless it is already running - the turn the ladder's own
   * nudge started continues its episode instead of opening a new one, and
   * a resume finds the clock its record kept across the restart. A turn
   * the provider failed opens its episode past the nudge: the retry owns
   * that turn's guidance. Machinery, so no timeline event.
   */
  markIdle(id: string, options: { providerFailed?: boolean; at?: number } = {}): void {
    const at = options.at ?? this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record || record.idleSince != null) return;
      this.writer.patch(id, {
        idleSince: at,
        recoveryRung: options.providerFailed ? 1 : 0,
        recoveryCount: 0,
        recoveryAt: null,
      });
    });
    run();
  }

  /** A turn began that the ladder did not start: the idle episode ends with its rungs. */
  endIdle(id: string): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record) return;
      if (record.idleSince == null && !record.recoveryRung && record.recoveryAt == null) return;
      this.writer.patch(id, {
        idleSince: null,
        recoveryRung: 0,
        recoveryCount: 0,
        recoveryAt: null,
      });
    });
    run();
  }

  /**
   * One rung of the idle ladder acted (or a record older than the clock got
   * one): the durable rung, wake count, and when. `idleSince` starts a
   * clock the record never had.
   */
  recordRecovery(
    id: string,
    input: { rung: number; count: number; at: number | null; idleSince?: number },
  ): void {
    const run = this.writer.write(() => {
      if (!this.writer.store.get(id)) return;
      this.writer.patch(id, {
        recoveryRung: input.rung,
        recoveryCount: input.count,
        recoveryAt: input.at,
        ...(input.idleSince !== undefined ? { idleSince: input.idleSince } : {}),
      });
    });
    run();
  }

  /**
   * Whether every one of these inbox rows was the idle ladder's own nudge
   * (a `steered` event by the supervisor naming the row): the turn that
   * delivers only those continues the idle episode it belongs to.
   */
  onlyLadderSteers(id: string, inboxIds: readonly number[]): boolean {
    if (inboxIds.length === 0) return false;
    const nudged = new Set(this.writer.events.ladderSteerRows(id));
    return inboxIds.every((row) => nudged.has(row));
  }

  /** The resume pointer and its conversation association commit together. */
  setSessionFile(
    id: string,
    sessionFile: string | null,
    facts?: Omit<TaskSession, "conversation" | "resume_token" | "opened_at" | "last_at">,
  ): void {
    const run = this.writer.write(() => {
      const now = this.writer.now();
      this.writer.mustGet(id);
      if (sessionFile && facts) {
        this.writer.conversations.record(id, {
          ...facts,
          conversation: conversationOf(sessionFile),
          resume_token: sessionFile,
          opened_at: now,
          last_at: now,
        });
      }
      this.writer.patch(id, { sessionFile, updatedAt: now });
      if (sessionFile && facts)
        this.writer.conversations.observe(id, {
          ...facts,
          conversation: conversationOf(sessionFile),
          observed_at: now,
        });
    });
    run();
  }

  /**
   * A turn ended with a report: the outcome columns and a `report` event.
   * The headline is the report's own one-line summary when the crewmate gave
   * one, else its first sentence past any Intent section (`reportSummary`).
   */
  recordReport(
    id: string,
    input: {
      text: string;
      summary?: string;
      actor?: TaskEventActor;
      usage?: Record<string, unknown>;
      /** What the report declared about whose turn follows it (FI3-435). */
      declared?: ReportDeclaration;
    },
  ): number {
    const at = this.writer.now();
    const summary = input.summary?.trim() || reportSummary(input.text) || null;
    const recovery = reportRecoveryOf(input.declared);
    const text = recovery.overflow
      ? `${input.text}\n\nFull recovery details: ${recovery.overflow}`
      : input.text;
    const wait = input.declared?.wait;
    const finished = input.declared?.finished === true;
    const request = input.declared?.needsFirstmate;
    const result = input.declared?.result;
    const declaredBack = input.declared?.checkBack;
    const checkBack = declaredBack
      ? { at, until: at + declaredBack.minutes * 60_000, waitingFor: declaredBack.waitingFor }
      : undefined;
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const declaring = Boolean(wait) || finished || Boolean(request) || Boolean(checkBack);
      // The result rides the report's event alone (INF-1296 piece 1): the
      // latest one stands until a later report carries another.
      const delivery =
        declaring || hasDeclaration(record)
          ? this.writer.mergeDelivery(record, {
              captainWait: wait ? { at, ...wait } : undefined,
              finishedAt: finished ? at : undefined,
              needsFirstmate: request ? { at, request } : undefined,
              checkBack,
            })
          : undefined;
      // A check-back is the task's timed wait (INF-1244): the sweep turns its
      // end into a steer. A captain gate already standing outranks it.
      const timed =
        checkBack && (!record.gate || record.gate.kind === "at-time")
          ? {
              gate: {
                kind: "at-time" as const,
                until: checkBack.until,
                reason: checkBack.waitingFor,
              },
            }
          : {};
      this.writer.patch(id, {
        outcome: text,
        outcomeSummary: summary,
        ...(delivery ? { delivery } : {}),
        ...timed,
        updatedAt: at,
      });
      return this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "crewmate",
        kind: "report",
        text,
        data: {
          ...(summary ? { summary } : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...(wait ? { waitingOnCaptain: wait } : {}),
          ...(finished ? { finished: true } : {}),
          ...(input.declared?.needsFirstmate
            ? { needsFirstmate: input.declared.needsFirstmate }
            : {}),
          ...(checkBack
            ? { checkBack: { until: checkBack.until, waitingFor: checkBack.waitingFor } }
            : {}),
          ...(input.declared?.captainWords ? { captainWords: input.declared.captainWords } : {}),
          ...(result ? { result } : {}),
          ...(input.declared?.firstRelease ? { firstRelease: input.declared.firstRelease } : {}),
          ...(input.declared?.responses?.length ? { responses: input.declared.responses } : {}),
          ...(recovery.workWait ? { workWait: recovery.workWait } : {}),
          ...(recovery.recoveryWays ? { recoveryWays: recovery.recoveryWays } : {}),
        },
      });
    });
    return run();
  }

  /**
   * A new turn started on the task: whatever its last report declared about
   * whose turn followed it no longer stands (FI3-435). Returns whether there
   * was a declaration to clear, so the caller re-reads the captain gate.
   */
  clearDeclaration(id: string): boolean {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (!record || !hasDeclaration(record)) return false;
      this.writer.patch(id, {
        delivery: this.writer.mergeDelivery(record, {
          captainWait: undefined,
          finishedAt: undefined,
          needsFirstmate: undefined,
          checkBack: undefined,
        }),
        // A check-back's timed wait goes with it: the turn it waited for runs.
        ...(record.delivery?.checkBack && record.gate?.kind === "at-time" ? { gate: null } : {}),
        updatedAt: this.writer.now(),
      });
      return true;
    });
    return run();
  }

  /**
   * A provider-failed turn on a task that stays alive and steerable. A
   * failure a typed backend reported keeps its class beside the words
   * (`typedFailureOf` reads it back), so nothing downstream reads the words
   * for it (docs/quota.md "Typed cut-offs"). A failure the honest retry
   * takes carries its outage (`retry`): how many tries failed, since when,
   * and whether the lane is now stuck at its provider. The outage's lines
   * fold into one on the feed, by when it began (docs/inbox.md); the
   * timeline keeps each.
   */
  recordTurnFailure(
    id: string,
    error: string,
    typed?: TypedFailure,
    retry?: { failures: number; since: number; stuck?: true },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "failed",
        text: `hit a problem: ${error}`,
        data: {
          error,
          fatal: false,
          ...(typed ? { failureSignals: "typed" } : {}),
          ...(typed?.cutOff ? { cutOff: typed.cutOff } : {}),
          ...(typed?.access ? { access: typed.access } : {}),
          ...(retry ? { retry, feedOnce: providerOutageFold(retry.since) } : {}),
        },
      });
    });
    run();
  }

  /**
   * A crewmate's report, saved on the record the moment it calls the report
   * tool (INF-3165, docs/inbox.md "A report a failed turn kept"): it counts
   * as the turn's result only when the turn ends clean (`recordReport`), but
   * a turn the provider fails, or a quit or crash cuts, after the call no
   * longer loses its words. A `note` with no feed line, so nothing routes
   * on it; `keptReport` reads it back.
   */
  holdReport(id: string, input: { text: string; summary?: string }): number {
    const at = this.writer.now();
    const summary = reportSummary(input.summary?.trim() || input.text);
    const run = this.writer.write(() => {
      this.writer.patch(id, { updatedAt: at });
      return this.writer.addEvent({
        taskId: id,
        at,
        actor: "crewmate",
        kind: "note",
        text: `report saved as it was made, counted when the turn ends: ${summary}`,
        data: {
          heldReport: { text: input.text, ...(summary ? { summary } : {}) },
          news: false,
        },
        feed: false,
      });
    });
    return run();
  }

  /**
   * The newest report saved at its call (`holdReport`) that no report the
   * record counted came after: the words a provider-failed, quit or crashed
   * turn reported before it stopped. Undefined once a later turn reported.
   */
  keptReport(id: string): KeptReport | undefined {
    const held = this.writer.events.latestWithObject(id, "note", "heldReport");
    if (!held) return undefined;
    const counted = this.writer.events.lastReports(id).at(-1);
    if (counted && counted.id > held.id) return undefined;
    const kept = held.data?.heldReport as { text?: unknown; summary?: unknown } | undefined;
    if (typeof kept?.text !== "string") return undefined;
    return {
      eventId: held.id,
      at: held.at,
      text: kept.text,
      summary: typeof kept.summary === "string" ? kept.summary : reportSummary(kept.text),
    };
  }

  /**
   * A steer the crew control plane accepted - delivered into the turn,
   * queued for the next one, recorded for retry, or queued behind a
   * supervision claim (R2 forward capture: this is how a direct steer
   * becomes observable). The message is redacted at capture. Returns the
   * event id, which the issuing decision lists in its `controls`.
   */
  recordSteer(
    id: string,
    input: { text: string; actor: TaskEventActor; captainText?: string } & SteerEventData,
  ): number | undefined {
    const at = this.writer.now();
    const run = this.writer.write((): number | undefined => {
      if (!this.writer.store.get(id)) return undefined;
      this.writer.patch(id, { updatedAt: at });
      const text = redactObserveText(input.text);
      const data: SteerEventData = {
        outcome: input.outcome,
        via: input.via,
        decision: input.decision,
        cardId: input.cardId,
        inboxId: input.inboxId,
        ...(input.panel ? { panel: input.panel } : {}),
        // The span stands only on the text it was measured on.
        ...(input.words && text === input.text ? { words: input.words } : {}),
      };
      return this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "steered",
        text,
        data,
        ...(input.actor === "captain" && input.captainText !== undefined
          ? { captainText: input.captainText }
          : {}),
        ...(input.decision ? { ref: input.decision } : {}),
        feed: false,
      });
    });
    return run();
  }

  /**
   * An interrupt or cancel request, with what it did at that moment (R2
   * forward capture). Written before any close it causes, so the timeline
   * reads request then effect.
   */
  recordInterrupt(
    id: string,
    input: { actor: TaskEventActor } & Omit<InterruptEventData, "error"> & {
        error?: string | null;
      },
  ): number | undefined {
    const at = this.writer.now();
    const run = this.writer.write((): number | undefined => {
      if (!this.writer.store.get(id)) return undefined;
      this.writer.patch(id, { updatedAt: at });
      const data: InterruptEventData = {
        mode: input.mode,
        effect: input.effect,
        error: input.error ? redactObserveText(input.error) : null,
        via: input.via,
        decision: input.decision,
        ...(input.panel ? { panel: input.panel } : {}),
        ...(input.backlog ? { backlog: true as const } : {}),
      };
      return this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "interrupted",
        text: input.mode === "cancel" ? "cancel requested" : "interrupt requested",
        data,
        ...(input.decision ? { ref: input.decision } : {}),
        feed: false,
      });
    });
    return run();
  }

  /**
   * A policy-step decision ended (R2 prospective provenance): one `decided`
   * event on every task it was about, all carrying the same record with the
   * decision id as `ref`. Machinery, never a task change - no `updated_at`,
   * never on the feed or the record pane. A decision about no task writes
   * nothing here; its served input is still self-describing in the session.
   * Structured capture for taskless operational wakes is deferred to the
   * supervision-coverage board outcome rather than inventing an anchor.
   */
  recordDecision(record: DecisionRecord): number[] {
    const run = this.writer.write((): number[] => {
      const ids: number[] = [];
      for (const taskId of record.disposition.tasks) {
        if (!this.writer.store.get(taskId)) continue;
        ids.push(
          this.writer.addEvent({
            taskId,
            at: record.endedAt,
            actor: record.producer.actor,
            kind: "decided",
            text: `decision ${record.decision}: ${record.disposition.outcome}`,
            data: record as unknown as Record<string, unknown>,
            ref: record.decision,
            feed: false,
          }),
        );
      }
      return ids;
    });
    return run();
  }

  /**
   * A reply in the thread of one of the task's cards, by its crewmate or by
   * Firstmate (docs/card-threads.md): a row on the task's Activity, as the
   * captain's own reply is through its steer. The words are the author's;
   * the captain's are never copied here.
   */
  recordReply(
    id: string,
    input: {
      cardId: string;
      title: string;
      text: string;
      actor: "crewmate" | "firstmate";
      /** Who wrote it when not the card's author (docs/card-threads.md, "Shared cards"). */
      contributor?: { taskId?: string; label: string };
    },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      if (!this.writer.store.get(id)) return;
      this.writer.patch(id, { updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "replied",
        text: redactObserveText(input.text),
        data: {
          cardId: input.cardId,
          title: input.title,
          ...(input.contributor ? { contributor: input.contributor } : {}),
        },
        ref: input.cardId,
        feed: false,
      });
    });
    run();
  }

  /**
   * The escalation pair (intelligence-bucket routing S4, report section 4
   * step 6). One act, two timeline rows written together: the rejected
   * attempt records that it was escalated and names its successor - the
   * ONE feed line the whole move gets - and the fresh attempt opens with
   * where it came from. Neither row is a card and nothing else surfaces:
   * the now panel simply shows the new row underway and the old one gone.
   */
  recordEscalation(input: {
    from: { id: string; key: string };
    to: { id: string; key: string };
    attempt: number;
    tier: IntelligenceBucket;
  }): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(input.from.id);
      this.writer.mustGet(input.to.id);
      this.writer.addEvent({
        taskId: input.from.id,
        at,
        actor: "captain",
        kind: "escalated",
        text: `moved to a stronger model (${input.tier}) after the captain's review - continues as ${input.to.key}`,
        data: { escalated_to: input.to.key, attempt: input.attempt, tier: input.tier },
        ref: input.to.id,
        feed: true,
      });
      this.writer.addEvent({
        taskId: input.to.id,
        at,
        actor: "captain",
        kind: "escalated",
        text: `attempt ${input.attempt} with a stronger model (${input.tier}), after ${input.from.key}`,
        data: { escalated_from: input.from.key, attempt: input.attempt, tier: input.tier },
        ref: input.from.id,
        feed: false,
      });
    });
    run();
  }
}
