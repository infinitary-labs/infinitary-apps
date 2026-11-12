import {
  type Card,
  MERGE_ANYWAY_ACTION,
  mergeEffectOf,
  SETTLE_FACT_VALUE_CLASS,
  SETTLE_FACTS_OPEN,
  SETTLE_LEVELS,
  type SettleFact,
  type SettleLevel,
  splitSettleFacts,
  takesTaskFacts,
  withMergeClosesLine,
} from "@shared/cards";
import {
  CHECKS_ABSENT_WORDS,
  CHECKS_UNREADABLE_WORDS,
  checkSnapshotState,
  currentCheckSummary,
  ownChecks,
} from "@shared/checkSnapshot";
import {
  checksDuration,
  checksFinishedAgo,
  checksRestWords,
  checksSpanOf,
  checksSpanWords,
} from "@shared/checksSpan";
import { type FactDotState, factDotSvg } from "@shared/factDot";
import { overrideCellWords, overrideWords, standingOverride } from "@shared/holds";
import { opensPullRequest, QUEUE_STATUS, type RepoDelivery } from "@shared/repos";
import {
  BATCH_CHECK_WORDS,
  CHECK_WORDS,
  CHECKS_NOT_READ_WORDS,
  changeLinesShortWords,
  changeLinesWords,
  DEFAULT_WORKSPACE_WORD,
  MERGE_ANYWAY_WORDS,
  REVIEW_EARLIER_WORDS,
  REVIEW_WORDS,
  RIGOR_REFERENCE_WORD,
  RIGOR_WORDS,
  RUN_WATCH_WORDS,
} from "@shared/vocabulary";
import { queueKind } from "../queue/shipped/rules.mjs";
import type { EmittedCardInput } from "../session/tools";
import type { RunWatch, TaskDelivery, TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { escapeCardText } from "./cardText";
import { checkVerdicts } from "./checkVerdicts";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { reviewCoversHead } from "./reviewCarry";

/**
 * What a settle card carries from the record rather than its author's words
 * (contract v2.0, captain ruling D4; the fact strip at v2.7): the facts the
 * host holds about its task - project, crewmate model, posture, PR link, CI
 * state - with the app's line saying whether its merge closes the task
 * (INF-2490), the words its merge reads now (INF-23), and Merge anyway
 * beside the merge while the host offers it (INF-1137 friction 6). The card
 * stack applies them when a card is emitted and again whenever the task's
 * record changes; they never come from an agent.
 */

/** What the facts are read from: the task's record and the stack, never the card's words. */
export type SettleFactsReading = {
  /** The task's fact strip and follow-ups now. */
  facts: () => string | undefined;
  /** Whether something besides this card keeps the task open past its merge (INF-2525). */
  othersOpen: () => boolean;
  /** The words a settle card's merge reads now, when the host names it; undefined leaves it. */
  mergeLabel?: (card: Card) => string | undefined;
  /** Whether a settle card offers Merge anyway beside its merge now. */
  mergeAnyway?: (card: Card) => boolean;
};

/**
 * A card with the facts the record holds now: its strip replaced in place,
 * its merge relabeled, and Merge anyway standing beside the merge or gone.
 * The same card back when nothing moved, and any card that takes no task
 * facts as it is.
 */
export function settleCardFacts(card: Card, read: SettleFactsReading): Card {
  if (!takesTaskFacts(card)) return card;
  // The merge of the task's current change, whose words the checks draw.
  const merges = (action: Card["actions"][number]) => {
    const merge = mergeEffectOf(action);
    return merge !== undefined && !merge.review && !action.passes;
  };
  const relabeled = (card: Card): Card => {
    const label = read.mergeLabel?.(card);
    if (!label || !card.actions.some((action) => merges(action) && action.label !== label))
      return card;
    return {
      ...card,
      actions: card.actions.map((action) => (merges(action) ? { ...action, label } : action)),
    };
  };
  // Merge anyway follows the record like the merge's words: it stands
  // beside the merge while the host offers it, and goes when it does not.
  const anyway = (card: Card): Card => {
    const offered = card.actions.some((action) => action.passes === "checks");
    const wanted = card.actions.some(merges) && read.mergeAnyway?.(card) === true;
    if (offered === wanted) return card;
    if (!wanted)
      return { ...card, actions: card.actions.filter((action) => action.passes !== "checks") };
    const at = card.actions.findIndex(merges);
    const beside = card.actions[at];
    const action: Card["actions"][number] = {
      id: MERGE_ANYWAY_ACTION,
      label: MERGE_ANYWAY_WORDS,
      variant: "secondary",
      // The same merge as the one it stands beside, with what follows it.
      effect: (beside && mergeEffectOf(beside)) ?? { kind: "merge", after: "close" },
      passes: "checks",
    };
    return {
      ...card,
      actions: [...card.actions.slice(0, at), action, ...card.actions.slice(at)],
    };
  };
  const facts = withMergeClosesLine(read.facts(), card.actions, read.othersOpen());
  const split = facts ? splitSettleFacts(card.body) : undefined;
  if (!facts || !split) return anyway(relabeled(card));
  const body = split.body.slice(0, split.at) + facts + split.body.slice(split.at);
  return anyway(relabeled(body === card.body ? card : { ...card, body }));
}

/**
 * An emitted card on a task with the facts the host holds about it, on add
 * and on every in-place revision, so no prompt asks an agent to write them.
 * So does the story note of a task that merges on its own (INF-1219). Every
 * merge card's strip ends with the app's line saying whether its click
 * closes the task (INF-2490). A merge card also says what the crew filed
 * under the task's name (captain, 2026-09-14): deciding whether to land is
 * the one moment those follow-ups bear on the captain's choice, so they are
 * named here rather than met later as a refusal.
 */
export function emittedSettleFacts(
  input: EmittedCardInput,
  read: Pick<SettleFactsReading, "facts" | "othersOpen"> & {
    /** What the crew filed under the task's name. */
    followups: () => string | undefined;
  },
): EmittedCardInput {
  const facts = takesTaskFacts(input) ? read.facts() : undefined;
  const strip = withMergeClosesLine(facts, input.actions, read.othersOpen());
  let next = strip ? { ...input, body: `${input.body}${strip}` } : input;
  if (next.actions.some((action) => mergeEffectOf(action))) {
    const notice = read.followups();
    if (notice) next = { ...next, body: `${next.body}${notice}` };
  }
  return next;
}

type FollowupState = "hold" | "after" | "working" | "queued" | "backlog";
/**
 * Row order on a settle card, and each state's word and hover sentence. The
 * last three are the Tasks panel's own group words (src/shared/nowPanel.ts).
 */
const FOLLOWUP_STATES: FollowupState[] = ["hold", "after", "working", "queued", "backlog"];
export const FOLLOWUP_WORDS: Record<FollowupState, { word: string; sentence: string }> = {
  hold: {
    word: "must close first",
    sentence:
      "This merge waits on it. Merge is refused until it closes, or until the wait is removed or your words pass it.",
  },
  after: {
    word: "starts once this merges",
    sentence: "It waits for this to merge, then starts. It does not hold this merge up.",
  },
  working: {
    word: "working",
    sentence: "A crewmate is working on it. It does not hold this merge up.",
  },
  queued: {
    word: "queued",
    sentence: "It starts by itself when nothing holds it. It does not hold this merge up.",
  },
  backlog: {
    word: "backlog",
    sentence: "It waits for your word to start. It does not hold this merge up.",
  },
};

/** One 10px state dot, the one drawing every fact strip shares (`@shared/factDot`). */
const statusDot = factDotSvg;

/** What the fact strip reads of the supervisor beyond its options. */
export type SettleFactsHost = {
  now(): number;
  /** How the task's change is delivered now. */
  taskDelivery(taskId: string): RepoDelivery | undefined;
  /** Whether a review of the task's change is open. */
  reviewOpen(taskId: string): boolean;
};

/**
 * The facts a settle card's task writes on the card: its fact strip, read
 * from the record and kept current as the record changes, and the work the
 * crew filed under its name.
 */
export class SettleFacts {
  /** Tasks whose change lines are being read now (`readChangeLines`). */
  private readonly readingLines = new Set<string>();

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: SettleFactsHost,
  ) {}

  /**
   * What the host knows about a settle card's task and writes on the card
   * itself (contract v2.0, captain ruling D4; the fact strip of v2.7,
   * rebuilt as a status line by INF-3709's plan): the facts the host holds
   * at emit time, so the crewmate's completion card and any Firstmate
   * settle card need not repeat them and cannot get them wrong. The strip
   * is at most two parts, each the card's full width:
   *
   * - The status line: one item per state the task has - its checks, each
   *   requested run the app watches, the batch check, a review, the
   *   captain's override - each a state mark and its words on one line,
   *   sorted failing, warning, running or waiting, passed (`SETTLE_LEVELS`);
   *   and at the line's far end the reference in quiet mono: the project,
   *   the change as a link, its lines, and the care level when it is not
   *   Default. Counts, durations, read times and a review's risk ride each
   *   state's `title`, shown on rest; a state with such words is a Tab stop
   *   whose focus shows them on a line under the states.
   * - What needs the captain: the queue's own words under a batch check
   *   that failed or paused, why the checks could not be read, and a row
   *   per failed check (`checkVerdicts`).
   *
   * The model and the computer are not here: the card's top line draws
   * both. Returns an HTML fragment, or undefined when the task is unknown.
   */
  strip(taskId: string): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) return undefined;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const delivery = this.host.taskDelivery(taskId) ?? "local-only";
    const now = this.host.now();
    const states: { level: SettleLevel; html: string }[] = [];
    const needs: string[] = [];
    // Each state names its fact in `data-fact`, so a reader finds a fact by
    // what it is, never by its label's words. Its words on rest are its
    // `title`, and the same words on a line the keyboard's focus shows: a
    // state whose value holds a link rides that link's focus.
    const state = (
      fact: SettleFact,
      dot: FactDotState,
      label: string | undefined,
      value: string,
      rest?: string,
    ) => {
      const level = LEVEL_OF_DOT[dot];
      const stop = rest && !value.includes("<a ") ? ' tabindex="0"' : "";
      const title = rest ? ` title="${escapeCardText(rest)}"` : "";
      states.push({
        level,
        html: `<span class="inf-foot-state${label ? "" : " inf-foot-alone"}" data-fact="${fact}" data-level="${level}"${title}${stop}>${statusDot(dot)}${label ? `<span class="inf-foot-k">${label}</span> ` : ""}<span class="${SETTLE_FACT_VALUE_CLASS}">${value}</span></span>${rest ? `<span class="inf-foot-rest" data-rest="${fact}" aria-hidden="true">${escapeCardText(rest)}</span>` : ""}`,
      });
    };
    const ci = record.delivery?.ci;
    // The Checks state counts and times the pull request's own checks; the
    // project's queue status, which says where the change stands in the
    // batch, has its own Batch check state (INF-3208).
    const own = record.delivery ? ownDelivery(record.delivery) : undefined;
    const observed = own ? currentCheckSummary(own) : undefined;
    const ciAt = record.delivery?.ciAt;
    if ((ci || observed) && ciAt !== undefined) {
      // In the open: the one state word, how long running checks have run
      // and how long ago finished ones finished. On rest: the counts, how
      // long they took, when they started and when the app last read them
      // (INF-587; the captain's answer 4 on INF-3709's plan). The host
      // rewrites the strip on every tick, so both ages stay current while
      // the card is up.
      const span = own ? checksSpanOf(own) : null;
      const counts = observed?.words ?? (ci ? CHECK_WORDS[ci] : CHECKS_NOT_READ_WORDS);
      const dot =
        observed?.dot ??
        (ci === "green" || ci === "merged"
          ? "ok"
          : ci === "red"
            ? "failed"
            : ci === "pending"
              ? "running"
              : "idle");
      const reading =
        own?.checks && (!own.headSha || own.checks.headSha === own.headSha)
          ? own.checks
          : undefined;
      const word = reading ? checkSnapshotState(reading) : counts;
      const words = span && word === CHECK_WORDS.pending ? checksSpanWords(word, span, now) : word;
      const detail = span ? checksSpanWords(counts, span, now) : counts;
      const age =
        span?.finishedAt != null
          ? `<span class="inf-foot-age"> · ${checksFinishedAgo(span.finishedAt, now)}</span>`
          : "";
      const alone = STANDALONE_CHECK_WORDS.has(word);
      state(
        "checks",
        dot,
        alone ? undefined : "Checks",
        `${escapeCardText(words)}${age}`,
        checksRestWords(span, ciAt, detail === words ? undefined : detail),
      );
      // Why the app could not read them all, in the open under the line.
      if (observed?.problem) needs.push(why("checks", escapeCardText(observed.problem)));
    } else if (opensPullRequest(delivery)) {
      state("checks", "idle", "Checks", CHECKS_NOT_READ_WORDS);
    }
    // Each requested run the app watches for the version on offer, such as
    // a phone check, in a state of its own named by the run: the Checks
    // state counts only the pull request's own checks, so a long wait for a
    // machine would otherwise show nowhere.
    for (const run of record.delivery ? watchedRuns(record.delivery) : []) {
      state(
        "run",
        run.reading.state === "running" ? "running" : "idle",
        escapeCardText(run.name),
        runLink(
          run.reading.url,
          `${RUN_WATCH_WORDS[run.reading.state]} for ${checksDuration(now - run.reading.since)}`,
        ),
        `Requested run ${run.runId} at ${run.reading.head.slice(0, 7)}, which the app watches; read ${checksFinishedAgo(run.reading.at, now)}`,
      );
    }
    const batch = record.delivery ? batchCheck(record.delivery) : undefined;
    if (batch) {
      state("batch", batch.dot, BATCH_CHECK_WORDS.label, batch.value, batch.rest);
      if (batch.why) needs.push(why("batch", batch.why));
    }
    const verdicts = record.delivery ? checkVerdicts(record.delivery, now) : "";
    if (verdicts) needs.push(verdicts);
    // The independent review's word on a change (delivery rigor phase 2,
    // at any care since INF-1875): the verdict in the open, the head it
    // read and the risk beside CI on rest, never a hold (Q4), or where the
    // review stands while it is live; only a Careful task awaits one.
    const offered = record.delivery?.headSha;
    {
      const review = record.delivery;
      if (review?.reviewVerdict) {
        // A pass that does not cover the version on offer reads as one at
        // an earlier version, never a plain green pass (INF-3141).
        const earlier =
          review.reviewVerdict === "pass" &&
          offered !== undefined &&
          !reviewCoversHead(review, offered);
        state(
          "review",
          review.reviewVerdict === "pass" && !earlier
            ? "ok"
            : review.reviewVerdict === "blocked"
              ? "failed"
              : "warn",
          "Review",
          earlier ? REVIEW_EARLIER_WORDS : REVIEW_WORDS[review.reviewVerdict],
          // On rest: the version it read and its risk, then that it reads
          // an earlier version, then the reviewer's note on the risk.
          [
            `${capital(REVIEW_WORDS[review.reviewVerdict])}${review.reviewSha ? ` ${review.reviewSha.slice(0, 7)}` : ""}${review.reviewRisk ? ` · risk ${review.reviewRisk}` : ""}${earlier || review.reviewRiskNote ? "." : ""}`,
            ...(earlier ? [`It does not cover ${offered.slice(0, 7)}, the version on offer.`] : []),
            ...(review.reviewRiskNote ? [review.reviewRiskNote] : []),
          ].join(" "),
        );
      } else if (this.host.reviewOpen(record.id)) {
        state("review", "running", "Review", "open");
      }
    }
    // The captain's standing override (docs/delivery-rigor.md, "The
    // holds"): what his words passed, with his words and how long on rest.
    // One for an earlier version passes nothing now, so it shows nothing.
    const override = standingOverride(record.delivery, record.delivery?.headSha);
    if (override) {
      state(
        "override",
        "warn",
        "Override",
        escapeCardText(overrideCellWords(override.holds)),
        overrideWords(override),
      );
    }
    // The reference, at the line's far end: what the card is about, never
    // a state.
    const refs: string[] = [];
    const ref = (fact: SettleFact, value: string, title?: string, after = "") =>
      refs.push(
        `<span data-fact="${fact}"${title ? ` title="${escapeCardText(title)}"` : ""}><span class="${SETTLE_FACT_VALUE_CLASS}">${value}</span>${after}</span>`,
      );
    ref("project", repo ? escapeCardText(repo.name) : DEFAULT_WORKSPACE_WORD);
    // The change by the forge's own label (`#N`, or the sent-up branch) and
    // its page where the host has one - never parsed back out of a link.
    const changeLabel =
      record.delivery?.changeLabel ??
      (record.delivery?.prNumber !== undefined ? `#${record.delivery.prNumber}` : undefined);
    const prUrl = record.delivery?.prUrl;
    const link = prUrl && /^https:\/\//.test(prUrl) ? escapeCardText(prUrl) : undefined;
    // A change open_change opened in another managed project names that
    // project beside its number (INF-2510).
    const target = record.delivery?.checkTarget;
    const elsewhere =
      target?.repoId && target.repoId !== record.repoId
        ? this.options.repos.get(target.repoId)?.name
        : undefined;
    if (changeLabel || link) {
      const label = escapeCardText(
        `${elsewhere ? `${elsewhere} ` : ""}${changeLabel ?? (prUrl as string)}`,
      );
      ref("change", link ? `<a href="${link}">${label}</a>` : label);
    }
    // What the whole offered change adds and deletes (INF-820), read from
    // git by the host, beside the change it measures: the signed counts in
    // the open, the words on rest. Shown only while it was read at the
    // version on offer; an unread change shows nothing, never a zero.
    const lines = record.delivery?.changeLines;
    if (lines && (offered === undefined || lines.head === offered)) {
      ref(
        "lines",
        changeLinesShortWords(lines.added, lines.deleted),
        changeLinesWords(lines.added, lines.deleted),
      );
    }
    this.readChangeLines(record);
    // The stamped tier is the care this task actually ran at, including
    // the captain's per-task ask, not the project's standing setting; it
    // shows only when it is not Default (the captain's answer 3).
    const policies = this.options.tasks.policiesOf(record);
    if (policies && policies.rigor.value !== "standard")
      ref("care", RIGOR_WORDS[policies.rigor.value], undefined, ` ${RIGOR_REFERENCE_WORD}`);
    const line = `<p class="inf-foot-line">${
      states.length > 0
        ? `<span class="inf-foot-states">${states
            .map((each, index) => ({ ...each, index }))
            .sort(
              (a, b) =>
                SETTLE_LEVELS.indexOf(a.level) - SETTLE_LEVELS.indexOf(b.level) ||
                a.index - b.index,
            )
            .map((each) => each.html)
            .join("")}</span>`
        : ""
    }<span class="inf-foot-ref">${refs.join("")}</span></p>`;
    return `${SETTLE_FACTS_OPEN}${line}${needs.length > 0 ? `<section class="inf-foot-needs">${needs.join("")}</section>` : ""}</div>`;
  }

  /**
   * Read the lines the task's offered change adds and deletes and keep them
   * on its delivery facts (INF-820), when the version on offer or its base
   * moved since the last reading. The offered version is the head the last
   * check reading saw, else the task's branch, read on the computer holding
   * that working copy. Recording the reading refreshes
   * the open cards' strips; a closed card keeps the strip it was shown.
   */
  private readChangeLines(record: TaskRecord): void {
    if (!record.deviceId && (!record.repoDir || !record.branch)) return;
    if (this.readingLines.has(record.id)) return;
    this.readingLines.add(record.id);
    void (async () => {
      const workspace = this.options.workspace;
      const remote = record.deviceId
        ? await this.options.machines?.revision(
            record.deviceId,
            record.id,
            record.delivery?.headSha,
          )
        : undefined;
      const head = record.deviceId
        ? remote?.headSha
        : (record.delivery?.headSha ??
          (await workspace.branchHead(record.repoDir, record.branch as string)));
      if (!head || (record.delivery?.headSha && record.delivery.headSha !== head)) return;
      const reading = record.deviceId
        ? remote?.changeLines
        : await workspace.changeLines(record.repoDir, head);
      if (!reading) return;
      const current = this.options.tasks.get(record.id);
      // A read crossing the connection may finish after the offered version or placement moved.
      if (
        !current ||
        current.deviceId !== record.deviceId ||
        current.delivery?.headSha !== record.delivery?.headSha
      )
        return;
      const kept = current.delivery?.changeLines;
      if (
        kept?.head === head &&
        kept.base === reading.base &&
        kept.added === reading.added &&
        kept.deleted === reading.deleted
      )
        return;
      this.options.tasks.delivery.recordChangeEvidence(record.id, {
        changeLines: { ...reading, head, at: this.host.now() },
      });
    })()
      .catch(() => {
        // An unreadable change keeps no reading: the strip shows no Lines cell.
      })
      .finally(() => {
        this.readingLines.delete(record.id);
        const current = this.options.tasks.get(record.id);
        if (
          current &&
          (current.deviceId !== record.deviceId ||
            current.delivery?.headSha !== record.delivery?.headSha)
        )
          this.readChangeLines(current);
      });
  }

  /**
   * What a settle card must say about work the crew filed under this task's
   * name (captain, 2026-09-14; rows by FI3-430's plan): follow-ups are
   * planned work the captain never chose, and the decision to land is the
   * one moment they bear on it. Returns an HTML fragment - a micro label
   * and one row per open follow-up (key, title, one word) - or undefined
   * when there are none. The word comes from the record's links and status,
   * never the title: this merge waits on it until it closes (any wait on it,
   * as the close gate reads it: a wait the captain's words passed holds
   * nothing, so it reads free), it waits for this merge, a crewmate is on
   * it, or it is queued or in the backlog by its start policy. Each row's
   * `title` attribute is the full sentence.
   */
  followupNotice(taskId: string): string | undefined {
    const holding = new Set(
      this.options.tasks.graph.holdingClose(taskId).map((blocker) => blocker.id),
    );
    const waiting = new Set(this.options.tasks.graph.blocking(taskId).map((task) => task.id));
    const rows = this.options.tasks.graph
      .discoveredFrom(taskId)
      .filter((followUp) => !TaskService.isClosed(followUp))
      .map((followUp) => {
        const state = holding.has(followUp.id)
          ? "hold"
          : waiting.has(followUp.id)
            ? "after"
            : followUp.status === "active"
              ? "working"
              : followUp.startPolicy === "on-request"
                ? "backlog"
                : "queued";
        return { followUp, state: state as FollowupState };
      })
      .map((row, index) => ({ ...row, index }))
      .sort(
        (a, b) =>
          FOLLOWUP_STATES.indexOf(a.state) - FOLLOWUP_STATES.indexOf(b.state) || a.index - b.index,
      );
    if (rows.length === 0) return undefined;
    const html = rows
      .map(({ followUp, state }) => {
        const { word, sentence } = FOLLOWUP_WORDS[state];
        const mark = state === "hold" ? statusDot("warn") : "";
        return `<div class="inf-followup" data-followup="${state}" title="${escapeCardText(sentence)}"><span class="inf-followup-key">${escapeCardText(followUp.key || followUp.id)}</span><span class="inf-followup-title">${escapeCardText(followUp.title)}</span><span class="inf-followup-word">${mark}${word}</span></div>`;
      })
      .join("");
    return `<div class="inf-followups" data-followups><div class="inf-followups-k">Filed while working on this</div>${html}</div>`;
  }
}

/**
 * The delivery facts the Checks cell reads (INF-3208): the reading without
 * the project's queue status, timed by the pull request's own checks the
 * queue's last reading kept. A reading that carries the queue status with no
 * own times kept shows no duration rather than the status's.
 */
function ownDelivery(delivery: TaskDelivery): TaskDelivery {
  const reading = delivery.checks;
  if (!reading?.items.some((item) => item.name === QUEUE_STATUS)) return delivery;
  const kept = delivery.queueStatus?.head === reading.headSha ? delivery.queueStatus : undefined;
  return {
    ...delivery,
    checks: ownChecks(reading),
    ciStartedAt: kept?.checksStartedAt,
    ciFinishedAt: kept?.checksFinishedAt,
  };
}

/**
 * The requested runs the app watches that a read found unfinished at the
 * version on offer, in the order they were watched; at any version while
 * none is on offer.
 */
function watchedRuns(
  delivery: TaskDelivery,
): (RunWatch & { reading: NonNullable<RunWatch["reading"]> })[] {
  return (delivery.runWatches ?? []).flatMap((watch) =>
    watch.reading && (delivery.headSha === undefined || watch.reading.head === delivery.headSha)
      ? [{ ...watch, reading: watch.reading }]
      : [],
  );
}

/** Words linked to a run's page where the host gave an https one. */
function runLink(url: string, words: string): string {
  return /^https:\/\//.test(url) ? `<a href="${escapeCardText(url)}">${words}</a>` : words;
}

/**
 * The Batch check state (INF-3208): the project's queue status on the
 * version on offer. Its state word stands on the status line; a status that
 * failed or paused says the queue's own words under the line, wrapped whole,
 * followed by its links - the queue's run, and the paused batch's issue.
 * Any other status keeps the queue's words on rest and links its word to the
 * run. Undefined when the reading of the version on offer carries no queue
 * status.
 */
function batchCheck(
  delivery: TaskDelivery,
): { dot: FactDotState; value: string; rest?: string; why?: string } | undefined {
  const reading = delivery.checks;
  if (!reading || (delivery.headSha && reading.headSha !== delivery.headSha)) return undefined;
  const item = reading.items.find((check) => check.name === QUEUE_STATUS);
  if (!item) return undefined;
  const kept = delivery.queueStatus?.head === reading.headSha ? delivery.queueStatus : undefined;
  const state = queueKind(item.state, kept?.words ?? "");
  const dot =
    state.kind === "passed"
      ? "ok"
      : state.kind === "failed"
        ? "failed"
        : state.kind === "paused"
          ? "warn"
          : state.kind === "in-batch"
            ? "running"
            : "idle";
  const word = BATCH_CHECK_WORDS.states[state.kind];
  const https = (url: string | undefined) =>
    url && /^https:\/\//.test(url) ? escapeCardText(url) : undefined;
  const pause = state.kind === "paused" || state.kind === "failed" ? https(kept?.pause) : undefined;
  // A paused status links the issue itself: it is not linked twice.
  const run = kept?.link !== kept?.pause ? https(kept?.link) : undefined;
  if (kept?.words && (state.kind === "paused" || state.kind === "failed")) {
    const links = [
      ...(run ? [`<a href="${run}">${BATCH_CHECK_WORDS.run}</a>`] : []),
      ...(pause ? [`<a href="${pause}">${BATCH_CHECK_WORDS.pause}</a>`] : []),
    ].join(" · ");
    return { dot, value: word, why: `${escapeCardText(kept.words)}${links ? ` ${links}` : ""}` };
  }
  return {
    dot,
    value: `${run ? `<a href="${run}">${word}</a>` : word}${pause ? ` · <a href="${pause}">${BATCH_CHECK_WORDS.pause}</a>` : ""}`,
    ...(kept?.words ? { rest: kept.words } : {}),
  };
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** A line under the status line saying why a state needs the captain, in the open. */
function why(fact: SettleFact, words: string): string {
  return `<p class="inf-foot-why" data-why="${fact}">${words}</p>`;
}

/** How much a state needs the captain, by the mark it draws. */
const LEVEL_OF_DOT: Record<FactDotState, SettleLevel> = {
  failed: "problem",
  warn: "warn",
  running: "waiting",
  idle: "waiting",
  ok: "ok",
};

/**
 * Checks words that say the whole state by themselves, so the status line
 * reads them without the Checks label before them, their first letter drawn
 * as a capital: `No checks`, never `Checks no checks`.
 */
const STANDALONE_CHECK_WORDS: ReadonlySet<string> = new Set([
  CHECKS_ABSENT_WORDS,
  CHECKS_UNREADABLE_WORDS,
  CHECK_WORDS["no-pr"],
  CHECK_WORDS.merged,
]);
