import {
  type Card,
  MERGE_ANYWAY_ACTION,
  mergeEffectOf,
  SETTLE_FACT_VALUE_CLASS,
  SETTLE_FACTS_OPEN,
  type SettleFact,
  splitSettleFacts,
  takesTaskFacts,
  withMergeClosesLine,
} from "@shared/cards";
import { currentCheckSummary, ownChecks } from "@shared/checkSnapshot";
import {
  checksFinishedAgo,
  checksRestWords,
  checksSpanOf,
  checksSpanWords,
} from "@shared/checksSpan";
import { factDotSvg } from "@shared/factDot";
import { overrideCellWords, overrideWords, standingOverride } from "@shared/holds";
import { opensPullRequest, QUEUE_STATUS, type RepoDelivery } from "@shared/repos";
import {
  BATCH_CHECK_WORDS,
  CARE_WORDS,
  CHECK_WORDS,
  CHECKS_NOT_READ_WORDS,
  changeLinesWords,
  DEFAULT_WORKSPACE_WORD,
  MERGE_ANYWAY_WORDS,
  REVIEW_EARLIER_WORDS,
  REVIEW_WORDS,
} from "@shared/vocabulary";
import { queueKind } from "../queue/shipped/rules.mjs";
import type { EmittedCardInput } from "../session/tools";
import type { TaskDelivery, TaskRecord } from "../storage/taskRecords";
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
   * itself (contract v2.0, captain ruling D4; restyled at v2.7 as the fact
   * strip by the captain's design pass, 2026-09-19): the project, the
   * crewmate's model, the task's effective care, the PR link, and the CI
   * reading check_pr_ci recorded - facts the host holds at emit time, so
   * the crewmate's completion card and any Firstmate settle card need not
   * repeat them and cannot get them wrong. Each fact is one labeled
   * single-line cell (`.inf-facts`, frameStylesheet.ts); what a merge does,
   * the CI reading's age, and the review's risk note ride the cells'
   * `title` attributes, never lines of their own (the captain's call).
   * Returns an HTML fragment, or undefined when the task is unknown.
   */
  strip(taskId: string): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) return undefined;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const delivery = this.host.taskDelivery(taskId) ?? "local-only";
    const cells: string[] = [];
    // Each cell names its fact in `data-fact`, so a reader finds a fact by
    // what it is, never by its label's words.
    const cell = (fact: SettleFact, label: string, value: string, title?: string) =>
      cells.push(
        `<span class="inf-fact" data-fact="${fact}"${title ? ` title="${escapeCardText(title)}"` : ""}><span class="inf-fact-k">${label}</span><span class="${SETTLE_FACT_VALUE_CLASS}">${value}</span></span>`,
      );
    cell("project", "Project", repo ? escapeCardText(repo.name) : DEFAULT_WORKSPACE_WORD);
    // Where it runs, right after the project, for a task on a computer that
    // runs work (design skill `components/devices/RunsOn`).
    const place = record.deviceId ? this.options.machines?.placeOf(record.deviceId) : undefined;
    if (place) cell("device", "Runs", escapeCardText(place.where));
    // The model that built the work, named right after the project
    // (captain, 2026-09-19): the task record's model - what the session
    // reported at dispatch, kept current when the backend moved the work to
    // another (`recordServedModel`) - by the one model-name lookup with the
    // raw id as fallback, never the newest routing choice, which can
    // disagree with what actually served (review F1). Labelled Model, as
    // every surface labels a model (FI3-565 piece 2).
    if (record.model) {
      const slash = record.model.indexOf("/");
      const ref =
        slash > 0
          ? { provider: record.model.slice(0, slash), id: record.model.slice(slash + 1) }
          : undefined;
      const label = ref ? (this.options.router?.modelLabel(ref) ?? ref.id) : record.model;
      cell("crewmate", "Model", escapeCardText(label));
    }
    // The stamped tier is the care this task actually ran at, including
    // the captain's per-task ask, not the project's standing setting.
    const policies = this.options.tasks.policiesOf(record);
    if (policies) cell("care", "Care", CARE_WORDS[policies.rigor.value]);
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
      cell(
        "change",
        record.delivery?.prNumber !== undefined ? "Pull request" : "Branch",
        link ? `<a href="${link}">${label}</a>` : label,
      );
    }
    // What the whole offered change adds and deletes (INF-820), read from
    // git by the host, beside the change it measures. Shown only while it
    // was read at the version on offer; an unread change shows no cell,
    // never a zero.
    const lines = record.delivery?.changeLines;
    const offered = record.delivery?.headSha;
    if (lines && (offered === undefined || lines.head === offered)) {
      cell(
        "lines",
        "Lines",
        `<span class="inf-mono">${changeLinesWords(lines.added, lines.deleted)}</span>`,
      );
    }
    this.readChangeLines(record);
    const ci = record.delivery?.ci;
    // The Checks cell counts and times the pull request's own checks; the
    // project's queue status, which says where the change stands in the
    // batch, has its own Batch check cell (INF-3208).
    const own = record.delivery ? ownDelivery(record.delivery) : undefined;
    const observed = own ? currentCheckSummary(own) : undefined;
    const ciAt = record.delivery?.ciAt;
    if ((ci || observed) && ciAt !== undefined) {
      // How long the checks ran or took and how long ago they finished, in
      // the open; when they started and when the app last read them, on
      // rest (INF-587). The host rewrites the strip on every tick, so both
      // ages stay current while the card is up.
      const span = own ? checksSpanOf(own) : null;
      const words = observed?.words ?? (ci ? CHECK_WORDS[ci] : CHECKS_NOT_READ_WORDS);
      const dot =
        observed?.dot ??
        (ci === "green" || ci === "merged"
          ? "ok"
          : ci === "red"
            ? "failed"
            : ci === "pending"
              ? "running"
              : "idle");
      cell(
        "checks",
        "Checks",
        `${statusDot(dot)}${span ? checksSpanWords(words, span, this.host.now()) : words}${span?.finishedAt != null ? ` · ${checksFinishedAgo(span.finishedAt, this.host.now())}` : ""}`,
        checksRestWords(span, ciAt),
      );
    } else if (opensPullRequest(delivery)) {
      cell("checks", "Checks", `${statusDot("idle")}${CHECKS_NOT_READ_WORDS}`);
    }
    const batch = record.delivery ? batchCheck(record.delivery) : undefined;
    if (batch) cell("batch", BATCH_CHECK_WORDS.label, batch.value, batch.title);
    if (record.delivery) cells.push(checkVerdicts(record.delivery, this.host.now()));
    // The independent review's word on a change (delivery rigor phase 2,
    // at any care since INF-1875): the verdict and the head it read, the
    // risk beside CI and never a hold (Q4), or where the review stands
    // while it is live; only a Careful task awaits one.
    {
      const review = record.delivery;
      if (review?.reviewVerdict) {
        const at = review.reviewSha
          ? ` <span class="inf-mono">${escapeCardText(review.reviewSha.slice(0, 7))}</span>`
          : "";
        const risk = review.reviewRisk ? ` · risk ${review.reviewRisk}` : "";
        // A pass that does not cover the version on offer reads as one at
        // an earlier version, never a plain green pass (INF-3141).
        const earlier =
          review.reviewVerdict === "pass" &&
          offered !== undefined &&
          !reviewCoversHead(review, offered);
        cell(
          "review",
          "Review",
          `${statusDot(review.reviewVerdict === "pass" && !earlier ? "ok" : review.reviewVerdict === "blocked" ? "failed" : "warn")}${earlier ? REVIEW_EARLIER_WORDS : REVIEW_WORDS[review.reviewVerdict]}${at}${risk}`,
          earlier
            ? `It does not cover ${offered.slice(0, 7)}, the version on offer.${review.reviewRiskNote ? ` ${review.reviewRiskNote}` : ""}`
            : review.reviewRiskNote,
        );
      } else if (this.host.reviewOpen(record.id)) {
        cell("review", "Review", `${statusDot("running")}open`);
      }
    }
    // The captain's standing override (docs/delivery-rigor.md, "The
    // holds"): what his words passed, with his words and how long on rest.
    // One for an earlier version passes nothing now, so it shows nothing.
    const override = standingOverride(record.delivery, record.delivery?.headSha);
    if (override) {
      cell(
        "override",
        "Override",
        `${statusDot("warn")}${escapeCardText(overrideCellWords(override.holds))}`,
        overrideWords(override),
      );
    }
    return `${SETTLE_FACTS_OPEN}${cells.join("")}</div>`;
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
 * The Batch check cell (INF-3208): the project's queue status on the version
 * on offer, in the queue's own words, linked to its run, with the paused
 * batch's issue beside a paused or failed status. Undefined when the reading
 * of the version on offer carries no queue status.
 */
function batchCheck(delivery: TaskDelivery): { value: string; title?: string } | undefined {
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
  const words = escapeCardText(kept?.words ?? BATCH_CHECK_WORDS.states[state.kind]);
  const https = (url: string | undefined) =>
    url && /^https:\/\//.test(url) ? escapeCardText(url) : undefined;
  const pause = state.kind === "paused" || state.kind === "failed" ? https(kept?.pause) : undefined;
  // A paused status links the issue itself: its words are not linked twice.
  const run = kept?.link !== kept?.pause ? https(kept?.link) : undefined;
  return {
    value: `${statusDot(dot)}${run ? `<a href="${run}">${words}</a>` : words}${pause ? ` · <a href="${pause}">${BATCH_CHECK_WORDS.pause}</a>` : ""}`,
    ...(kept?.words ? { title: kept.words } : {}),
  };
}
