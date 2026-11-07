/**
 * A crewmate's report and a reviewer's verdict as the first mate hears
 * them, with the review's later steps and the requested responses a
 * report answers.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import type { recoveryWay, StallFact, WorkWait } from "@shared/recovery";
import type { ReviewVerdict } from "@shared/rigor";
import type { CardRefusal } from "../storage/taskStore";
import type { TaskQueryBuiltOn } from "../tasks/taskQuery";
import { RESULT_WORDS, resultText } from "../tasks/taskResult";
import { type CiReadingFact, ciFactWords } from "./ciFact";
import { REVIEW_FIX_RULES } from "./intentBrief";
import { type ReviewHistoryEntry, renderReviewHistory } from "./reviewHistory";
import type { KindWords, WakeKeyedTask, WakeTask } from "./wakes";

/** The facts of a report, a review and a requested response. */
export type ReportFacts =
  | {
      kind: "requested-response";
      requestId: string;
      responseId: string;
      taskId: string;
      contributorTask: string;
      status: "answered" | "not-yet-answered";
      question: string;
      excerpt: string;
    }
  | {
      kind: "response-missing";
      requestId: string;
      taskId: string;
      turnId: string;
      references: { inboxId: number; startedAt: number; session?: string; reportEventId?: number };
      question: string;
      report?: string;
    }
  | {
      /** A crewmate reported (the report's whose-turn sort said nobody's, or it bypasses the sort). */
      kind: "report";
      stall?: StallFact;
      workWait?: WorkWait;
      recoveryWays?: ReturnType<typeof recoveryWay>[];
      task: WakeTask;
      crewmate: string;
      /** The report, already capped for a wake. */
      excerpt: string;
      /** What it filed this turn. */
      filed: WakeFiled[];
      /** The work its task waits on that nobody has started (FI3-671). */
      waits?: WakeWait[];
      /**
       * The started work held on its task through a wait the Firstmate
       * recorded (INF-735): the report may carry what that work waits for.
       */
      waiting?: WakeKeyedTask[];
      /** Its cards on the captain's screen when it reported. */
      cards: WakeCard[];
      /**
       * The host's refusal of its completion card, standing until one goes
       * up: the fact beside a report that says the card went up (FI3-401).
       */
      refused?: CardRefusal;
      /**
       * The decisions its crewmate withdrew itself this turn (INF-2828): the
       * captain chose none of their actions, whatever the report says.
       */
      withdrawn?: WakeWithdrawn[];
      /**
       * The report declared a wait on the captain, in its crewmate's words,
       * and no card of the task is on his screen to answer (INF-11).
       */
      captainWait?: string;
      /**
       * The report declared its work finished: the captain has read its
       * outcome and nothing is left for it (FI3-435).
       */
      finished?: true;
      /** The report declared that the Firstmate must act, and what on (FI3-710). */
      needsFirstmate?: string;
      /** The work built on its task, open or closed, when there is any (INF-976). */
      builtOn?: WakeBuiltOn[];
      /** The report's typed result, as the host checked it against the task's shape (INF-799). */
      result?: Record<string, unknown>;
      /** The CI reading the app last recorded on its task, when there is one. */
      ci?: CiReadingFact;
      /** Its open review, when that review's last verdict was findings or blocked. */
      review?: WakeOpenReview;
    }
  | {
      /** A reviewer reported, and the task it reviewed is no longer on record. */
      kind: "review-orphan";
      task: WakeTask;
      crewmate: string;
      excerpt: string;
    }
  | {
      /** A reviewer reported with no typed review record, so no verdict was recorded. */
      kind: "review-unstated";
      task: WakeTask;
      builder: WakeTask;
      crewmate: string;
      excerpt: string;
    }
  | ReviewVerdictFacts
  | {
      /** A review passed: its task closed and the builder's hold released. */
      kind: "review-passed";
      /** The builder, which the next move is on. */
      task: WakeTask;
      /** The closed review task's key. */
      reviewKey: string;
      crewmate: string;
      /** The head it passed at; absent when none was recorded. */
      head?: string;
      risk?: string;
      riskNote?: string;
      excerpt: string;
      /** The builder's live proof at that head, when it planned scenarios (INF-2672). */
      proof?: WakeProof;
    };

/** A Careful builder's live proof at a passed head, as typed facts (INF-2672). */
export type WakeProof = {
  accepted: boolean;
  /** Why it is or is not accepted, as the acceptance rule says. */
  reason: string;
  /** The latest proof run, absent when none has run. */
  run?: { head: string; revision: number; verdict: string };
  /** Whether this review judged that run. */
  read: boolean;
};

export const REQUESTED_RESPONSE_OPENING = "[fm-op] Requested crewmate response: ";
export const RESPONSE_MISSING_OPENING = "[fm-op] Missing crewmate response: ";
export const PENDING_RESPONSES_OPENING =
  "\n\nPending response requests (also readable with tasks key ";
export const PENDING_RESPONSES_END = "\nEnd pending response requests.";

/** A crewmate's card on the captain's screen, as a report wake names it. */
export type WakeCard = { id: string; word: string; title: string };

/** A decision a crewmate withdrew itself, as a report wake names it (INF-2828). */
export type WakeWithdrawn = { id: string; title: string };

/** A task a crewmate filed during its turn (cards/tasks/agents P0, WI-4). */
export type WakeFiled = { key: string; title: string; blocks: boolean };

/**
 * A task built on the woken one - its basis names it - open or closed, with
 * its status, closing reason and change (INF-976): the work already
 * standing on the request's task, named so none is filed again unread.
 */
export type WakeBuiltOn = {
  key: string;
  title: string;
  status: string;
  closedReason?: string;
  change?: string;
};

/** Work a task waits on that only a start begins (FI3-671), and whether it was dropped. */
export type WakeWait = { key: string; title: string; state: "not-started" | "dropped" };

/** A reviewer's findings or blocked verdict, the wake the review cap rides. */
export type ReviewVerdictFacts = {
  kind: "review-verdict";
  /** The review task. */
  task: WakeTask;
  /** The task it reviewed. */
  builder: WakeTask;
  crewmate: string;
  verdict: ReviewVerdict;
  /** The report, already capped for a wake. */
  excerpt: string;
  /** The typed findings the verdict rests on, one line each (INF-1875). */
  findings?: string[];
  cards: WakeCard[];
  /** What was decided so far on the reviewed change, oldest first (INF-993). */
  history?: ReviewHistoryEntry[];
};

/**
 * A review's later steps, served where each arises (FI3-566 cut C): the
 * core keeps when to commission a review and that every steer carries the
 * captain's latest decision; the findings wake keeps how to fix a finding,
 * since a review happens at any care and no brief carries the rules.
 */
export const REVIEWER_IDLE_NEXT =
  "Steer a reviewer only to re-review at a new head, evidence revision or validation state its builder reports (including a captain-granted gap exception or a new effect request) - an idle reviewer needs no stand-by and no status.";

/** What a findings or blocked verdict asks of the Firstmate next. */
export function reviewFindingsNext(): string {
  const relay = `Steer the builder with every auto-fix finding verbatim, prefixed with - ${REVIEW_FIX_RULES}.`;
  return `${relay} Info findings never block and need no steer. Decide an ask-user finding yourself when the user's own words already settle it; the rest are ONE decision card per round on the builder's task, with the step you would take as its default. Pass review_task_id naming this review. Start the title with Review of the builder's key; name the change in the first line. For each finding, show its number, severity, file and reviewed version above the reviewer's verbatim words. ${REVIEWER_IDLE_NEXT}`;
}

/** What a builder's report asks of its open review, which last returned findings or blocked. */
export const REVIEW_NEW_HEAD_NEXT =
  "When this report brings a new head, evidence revision or validation state (including a captain-granted gap exception or a new effect request), steer that reviewer to re-review those exact facts. The app writes what was decided so far, the captain's answers included, into every reviewer turn, so never retype declined findings into the steer. Never steer the reviewer otherwise - an idle reviewer needs no stand-by and no status.";

/** What a passed review asks of the Firstmate next. */
export const REVIEW_PASSED_NEXT =
  "Steer the builder to push, open the PR and drive CI green; its PR report is then handled like any other.";

/**
 * What a code pass asks next while the builder's live proof is not accepted
 * at that head (INF-2672): proof runs once after the code passes, and one
 * proof read judges it before the push.
 */
export const REVIEW_PROOF_NEXT =
  "The code passed; live proof runs once now, after it. When no proof run is recorded at or since this head, steer the builder to run its live proof once and report the run, without pushing. When the builder reports that run, start the proof read with spawn_crewmate review_of naming the builder and the user's words: that reviewer reads only the proof and anything changed since this pass. When this review already read the run and found it failed or short, steer the builder to repair: a repair gets a review of its own difference and reruns only the proof it reaches. When the only proof missing runs on a pushed branch, steer the builder to push, open the PR and finish that proof beside the checks before its merge card.";

/** A builder's open review whose last verdict asks for a re-review at a new head. */
export type WakeOpenReview = {
  evidenceRevision?: number;
  currentEvidenceRevision?: number;
  stateRevision?: number;
  currentStateRevision?: number;
  /** The review task's key. */
  key: string;
  verdict: Exclude<ReviewVerdict, "pass">;
  /** The head that verdict read; absent when none was recorded. */
  head?: string;
};

// INF-1550: serve the procedure at its point of use, not on every turn.
export const STALL_RECOVERY_GUIDANCE = `On a typed stall or idle wake, list ways forward; take the cheapest consent-free one, record it with update_task verdict, then in the same turn read the result through tasks/crew_status or its owner. If it did not move, try the next. A wait names owner, end fact and cheapest alternative; "wait" or "no action" is not an answer.
Ways exhausted or failed: spawn one bounded read-only internal_step on this project, related to the stall, to find ways forward today without a new build. Brief it with goal, user_words, branch, refusals and named evidence/source to inspect; require recovery_ways, no card/edits, then stop. Try its consent-free findings; do not repeat that investigation without new facts. Each way declares approach: workaround, pass-hold or stronger-model. Only workarounds may be consent-free; passing any hold or choosing a stronger model needs the captain regardless of its basis. Sign-in remains captain-owned; no label authorizes a bypass or impossible move. Signing, releases, merges, destruction and new access keep their consent; reconcile unknown effects, never replay. A card only when every remaining viable way needs consent, everything before its click done.
Host record, or host fix absent from the running app: spawn_crewmate branch_from the blocked task, original goal/user_words; hand files on with steer_crewmate files_from naming the old task. Reuse a takeover filing with update_task branch_from and start_now instead of filing twice; link related and blocks from takeover to old, whose author waits on the successor. Retain consent, validation and failed-check evidence. Start a takeover filing now, not after the origin's merge; no blocks edge from it. Never wait for an alpha or use a fresh record to authorize a forbidden effect.`;

/** A report wake's words for work its crewmate declared finished; a scripted stand-in recognizes them. */
export const FINISHED_REPORT_WORDS = "It declared its work finished";

/**
 * A reviewer's findings or blocked verdict, with what it asks next. The
 * review cap rides a findings one without them: its own words name the way.
 */
export function renderReviewVerdict(facts: ReviewVerdictFacts, next = true): string {
  return `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}" - the review of task ${facts.builder.id} "${facts.builder.title}" - with verdict ${facts.verdict}: ${facts.excerpt}${facts.findings?.length ? `\nFindings:\n${facts.findings.map((line) => `- ${line}`).join("\n")}` : ""}${facts.history?.length ? `\n${renderReviewHistory(facts.history)}\n` : ""}${cardsText(facts.cards)}${next ? ` ${reviewFindingsNext()}` : ""}`;
}

/** A passed review's live-proof facts, worded (INF-2672). */
function proofText(proof: WakeProof): string {
  const run = proof.run
    ? ` Latest proof run: revision ${proof.run.revision} at ${proof.run.head.slice(0, 7)}, verdict ${proof.run.verdict}, ${proof.read ? "read by this review" : "not read by this review"}.`
    : " No proof run is recorded yet.";
  return ` Live proof at this head: ${proof.accepted ? "accepted" : "not accepted"} - ${proof.reason}${run}`;
}

/** A builder report's open review, and the re-review it may ask for. */
export function openReviewText(review: WakeOpenReview): string {
  return ` Its open review ${review.key} last returned ${review.verdict} at ${review.head ? review.head.slice(0, 7) : "an unrecorded head"}.${review.evidenceRevision !== undefined ? ` It read evidence revision ${review.evidenceRevision}; the builder now has revision ${review.currentEvidenceRevision}.` : ""} ${review.stateRevision !== undefined ? `Its assigned validation state is ${review.stateRevision}; the builder now has state ${review.currentStateRevision}. ` : ""}${REVIEW_NEW_HEAD_NEXT}`;
}

/**
 * What a report wake says about the turn's filings (cards/tasks/agents P0,
 * WI-4): the keys, so the Firstmate triages them with the report - and
 * nothing when the turn filed nothing.
 */
function filedText(filed: WakeFiled[]): string {
  if (filed.length === 0) return "";
  const named = filed
    .map(
      (entry) =>
        `${entry.key} "${entry.title}" (${entry.blocks ? "blocks this task" : "not blocking"})`,
    )
    .join(", ");
  return ` Filed this turn: ${named}. Each waits on request, discovered from this task.`;
}

/** The work built on a task, as a wake carries it (INF-976). */
export function wakeBuiltOn(rows: readonly TaskQueryBuiltOn[]): WakeBuiltOn[] | undefined {
  if (rows.length === 0) return undefined;
  return rows.map((row) => ({
    key: row.key,
    title: row.title,
    status: row.status,
    ...(row.closed_reason ? { closedReason: row.closed_reason } : {}),
    ...(row.change?.label ? { change: row.change.label } : {}),
  }));
}

/**
 * A wake about a request names the work already built on its task, open or
 * closed (INF-976): a fact, never a verdict - whether that work covers the
 * request is the Firstmate's judgment, under HANDOFF.
 */
export function builtOnText(builtOn: WakeBuiltOn[] | undefined): string {
  if (!builtOn?.length) return "";
  const named = builtOn
    .map((task) => {
      const state = [
        task.closedReason ? `${task.status}: ${task.closedReason}` : task.status,
        ...(task.change ? [task.change] : []),
      ].join(", ");
      return `${task.key} "${task.title}" (${state})`;
    })
    .join(", ");
  return ` Work built on this task, open or closed: ${named}.`;
}

/**
 * A report wake names the work its task waits on that only a start begins
 * (FI3-671): a fact, never the policy - what the Firstmate does about it
 * lives in its prompt.
 */
function waitsText(waits: WakeWait[] | undefined): string {
  if (!waits?.length) return "";
  const named = waits
    .map(
      (wait) =>
        `${wait.key} "${wait.title}" (${wait.state === "dropped" ? "dropped" : "not started"})`,
    )
    .join(", ");
  return ` It waits on ${named}; nothing starts that work by itself.`;
}

/** The words that open a report wake's list of the work held on its task (INF-735). */
export const HELD_WORK_WORDS = "Started work waits on this task through your link:";

/**
 * A report wake names the started work held on its task through a wait the
 * Firstmate recorded (INF-735), and is this rule's one home: a hold on a
 * task's finding ends when that task reports it, not when it closes. Whether
 * the report carries what the work waits for is the Firstmate's judgment.
 */
function waitingText(waiting: WakeKeyedTask[] | undefined): string {
  if (!waiting?.length) return "";
  const named = waiting.map((task) => `${task.key} "${task.title}"`).join(", ");
  return ` ${HELD_WORK_WORDS} ${named}. If this report carries what such work waits for, such as a finding or an answer, pass it on now with steer_crewmate and end that wait with link_tasks remove; a wait on this task's merge stays.`;
}

/**
 * A report wake names the cards its crewmate has on screen (WI-12): the
 * fact the Firstmate's steer-not-answer rule turns on. The rule itself
 * lives in its prompt (contract v2.0: a wake carries facts, never a
 * restatement of policy).
 */
function cardsText(cards: WakeCard[]): string {
  if (cards.length === 0) return "";
  const named = cards.map((card) => `${card.id} (${card.word}) "${card.title}"`).join(", ");
  return ` Its ${cards.length === 1 ? "card" : "cards"} on the captain's screen: ${named}.`;
}

/**
 * A report wake names a standing refusal of its crewmate's completion card
 * (FI3-401): the host's record that the card did not go up, whatever the
 * report beside it says.
 */
function refusedText(refused: CardRefusal | undefined, cards: WakeCard[]): string {
  if (!refused) return "";
  const screen = cards.length === 0 ? ", and no card of its is on the captain's screen" : "";
  const why = refused.why.trim().replace(/\.$/, "");
  return ` The host refused its merge card "${refused.title}" at ${new Date(refused.at).toISOString()}: ${why}. That card did not reach the captain${screen}.`;
}

/**
 * A report wake names the decisions its crewmate withdrew itself this turn
 * (INF-2828): the host's record that the captain chose none of their
 * actions, whatever the report beside it says. On INF-2828 a crewmate
 * reported the captain's approval of a consent card it had withdrawn
 * itself, and the first mate acted on the report.
 */
function withdrawnText(withdrawn: WakeWithdrawn[] | undefined): string {
  if (!withdrawn?.length) return "";
  const named = withdrawn.map((card) => `${card.id} "${card.title}"`).join(", ");
  const one = withdrawn.length === 1;
  return ` It withdrew its own ${one ? "decision" : "decisions"} ${named} this turn; the captain chose none of ${one ? "its" : "their"} actions.`;
}

/** A report, a review and a requested response, worded. */
export const REPORT_WORDS: KindWords<ReportFacts> = {
  "requested-response": (facts) =>
    `${REQUESTED_RESPONSE_OPENING}${facts.responseId} to request ${facts.requestId} for task ${facts.taskId}, submitted by task ${facts.contributorTask} (${facts.status}). Request: ${facts.question}\nResponse: ${facts.excerpt}\nThis is a saved response, independent of later reports and continuing work. Handling acknowledges delivery, not correctness. Answer the captain on the original card when this request concerns their question.`,
  "response-missing": (facts) =>
    `${RESPONSE_MISSING_OPENING}task ${facts.taskId} completed turn ${facts.turnId} after consuming request ${facts.requestId} without submitting a matching response. The request remains pending: ${facts.question}${facts.report ? `\nThat turn's report (not treated as an answer): ${facts.report}` : ""}\nRecorded turn references: ${JSON.stringify(facts.references)}. Read that report event and the session's report/reply calls before deciding whether to wait, request a repost, or reassign. This fact does not authorize new work or a captain action.`,
  report: (facts) =>
    `[fm-op] ${facts.crewmate} reported on task ${facts.task.id} "${facts.task.title}": ${facts.excerpt}${filedText(facts.filed)}${waitsText(facts.waits)}${waitingText(facts.waiting)}${refusedText(facts.refused, facts.cards)}${withdrawnText(facts.withdrawn)}${cardsText(facts.cards)}${facts.captainWait ? ` It waits on the captain to ${facts.captainWait}, and no card of its is on their screen.` : ""}${facts.ci ? ciFactWords(facts.ci) : ""}${facts.finished ? ` ${FINISHED_REPORT_WORDS}: the captain has read its outcome and nothing is left for it.` : ""}${facts.needsFirstmate ? ` It asks the first mate to act: ${facts.needsFirstmate}. The ask authorizes nothing by itself; the captain's own words do.` : ""}${builtOnText(facts.builtOn)}${facts.result ? ` ${RESULT_WORDS} ${resultText(facts.result)}` : ""}${facts.review ? openReviewText(facts.review) : ""}${facts.workWait ? ` Work wait: ${JSON.stringify(facts.workWait)}.` : ""}${facts.stall ? ` Typed stall: ${JSON.stringify(facts.stall)}.` : ""}${facts.recoveryWays?.length ? ` Recovery ways (labels grant no permission): ${JSON.stringify(facts.recoveryWays)}.` : ""}${facts.stall || facts.recoveryWays?.length ? ` ${STALL_RECOVERY_GUIDANCE}` : ""}`,
  "review-orphan": (facts) =>
    `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}", but the task it reviewed is no longer on record: ${facts.excerpt}`,
  "review-unstated": (facts) =>
    `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}" - the review of task ${facts.builder.id} "${facts.builder.title}" - with no typed review record, so no verdict was recorded: ${facts.excerpt} ${REVIEWER_IDLE_NEXT}`,
  "review-verdict": (facts) => renderReviewVerdict(facts),
  "review-passed": (facts) => {
    const risk = facts.risk
      ? `risk ${facts.risk}${facts.riskNote ? `: ${facts.riskNote}` : ""}`
      : "risk unstated";
    return `[fm-op] the review of task ${facts.task.id} "${facts.task.title}" passed at ${facts.head ? facts.head.slice(0, 7) : "an unrecorded head"} (${risk}); review task ${facts.reviewKey} is closed. ${facts.crewmate}'s report: ${facts.excerpt}${facts.proof ? proofText(facts.proof) : ""} ${facts.proof && !facts.proof.accepted ? REVIEW_PROOF_NEXT : REVIEW_PASSED_NEXT}`;
  },
};
