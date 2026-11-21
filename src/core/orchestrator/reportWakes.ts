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
import type { CardRefusal } from "../storage/taskRecords";
import type { TaskQueryBuiltOn } from "../tasks/taskQuery";
import { RESULT_WORDS, resultText } from "../tasks/taskResult";
import { type CiReadingFact, ciFactWords } from "./ciFact";
import { REVIEW_FIX_RULES } from "./intentBrief";
import { type ReviewHistoryEntry, renderReviewHistory } from "./reviewHistory";
import type { KindWords, WakeKeyedTask, WakeTask } from "./wakes";

/** The facts of a report, a review and a requested response. */
export type ReportFacts =
  | {
      /** Host-owned delivery between a review and its builder, through the durable task lane. */
      kind: "review-handoff";
      from: string;
      head: string;
      stage: "fix" | "proof" | "ship" | "reread" | "card" | "decision" | "decided";
      excerpt: string;
      findings?: string[];
      history?: ReviewHistoryEntry[];
    }
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
      /**
       * The captain's words the report passes on, as the host read them where
       * its crewmate said he typed them, with when (INF-3202): work filed
       * from this report keeps them as its origin (`turnOriginOf`).
       */
      captainWords?: { text: string; at: number };
      /** The work built on its task, open or closed, when there is any (INF-976). */
      builtOn?: WakeBuiltOn[];
      /**
       * The finished programs its crewmate started that returned a branch:
       * each by key and title, and the part a shipping task branches from.
       */
      programBranches?: { key: string; title: string; branch: string }[];
      /** The report's typed result, as the host checked it against the task's shape (INF-799). */
      result?: Record<string, unknown>;
      /** The CI reading the app last recorded on its task, when there is one. */
      ci?: CiReadingFact;
      /** Its open review, when that review's last verdict was findings or blocked. */
      review?: WakeOpenReview;
      /**
       * Its review passed at an earlier version that does not cover the
       * version now on offer (INF-3141): both versions.
       */
      earlierPass?: { read: string; offered: string };
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
  | ReviewVerdictFacts;

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
export type WakeFiled = { key: string; title: string; blocks: boolean; program?: boolean };

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
  "The host returns changed heads, evidence revisions and validation state directly to the reviewer. Do not repeat that handoff; an idle reviewer needs no stand-by and no status.";

/**
 * What a findings or blocked verdict asks of the Firstmate next. An
 * ask-user finding is its reviewer's to put to the captain (INF-4338's
 * direction D): the first mate hears a verdict only when it is blocked or
 * holds a no-op finding that blocks, and raises no review finding card.
 */
export function reviewFindingsNext(): string {
  const relay = "The host owns auto-fix handoffs to the builder. Do not relay findings again.";
  return `${relay} Info findings never block and need no steer. An ask-user finding is its reviewer's to put to the captain on its own Review finding card, whose answer the host sends to the builder: raise no card for it. Settle a blocked review, or a no-op finding that blocks, with the reviewer or the builder; ask the captain on a card only when it needs their choice. ${REVIEWER_IDLE_NEXT}`;
}

/**
 * The reviewer's own Review finding card (INF-4338's direction D): served
 * only to a reviewer whose verdict holds a finding for the captain, never
 * in every review brief. The reviewer read the change, so it draws the
 * problem a person would see and answers replies under the card; the
 * finding as recorded folds, with its file and version.
 */
export const REVIEW_CARD_RULES =
  "Put the findings above to the captain on ONE decision card for this round with emit_card: the app labels it Review finding beside the builder's facts and sends the captain's choice straight to the builder. Leave off the card, and settle yourself, a finding the user's own words or the decisions above already answer. If your Review finding card from an earlier round is still open, revise it in place under its id, keeping each question still waiting on it, instead of raising a second card. Start the title with Review of the builder's key. The first line, one sentence with nothing else before the first question, names the change in plain words, how many choices wait and whether people using the project will notice. For each finding, a fieldset whose legend asks the question in plain words, with no file or code name, beside a plain seriousness tag in <span class=\"inf-muted\">: Serious for an error, Worth fixing for a warning, Minor otherwise. Under the legend, one figure of what happens now, drawn from the change you read on one concrete example a person using the project would see, with at most one sentence beside it. Then one option per way in a dozen words at most, its rough size after the words: one is what the code does now, marked data-inf-current, which the app tags As built - add Leave it as built when no listed way is - and data-inf-recommended marks your pick. Under the options, a table of the tradeoff: one row per option, the as-built one included, and one column per heading where the options differ, as your finding weighed them; each cell holds a level, High, Medium or Low, where High is always the most of what the heading names, and a few words for this change. One line under the table names the headings on which the options are level, when there are any. One line names your pick, what it gives up and its reason in fifteen words or fewer; a question only the captain can approve is one yes or no with no table. A builder's view, only when the builder gave one, takes its own line under the builder's name. Last, a details whose summary is The finding as recorded, holding its seriousness, file, reviewed version and your finding's text as recorded. After the questions, when this round settled any finding a person would notice without asking, one details whose summary is Settled without asking you with their count lists each: what was found, what was done and why the captain was not asked. A reply under the card comes to you: answer it from the change you read. Once the card is up, report without a new review record, then stay idle.";

/** What a builder's report asks of its open review, which last returned findings or blocked. */
export const REVIEW_NEW_HEAD_NEXT =
  "The host owns routine re-review handoffs. Read this report for its decision or blocker, not to repeat a handoff. Never retype declined findings: the review history carries the captain's latest decisions.";

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
Ways exhausted or failed: spawn one bounded read-only internal_step on this project, related to the stall, to find ways forward today without a new build. Brief it with goal, branch, refusals and named evidence/source to inspect; require recovery_ways, no card/edits, then stop. Try its consent-free findings; do not repeat that investigation without new facts. Each way declares approach: workaround, pass-hold or stronger-model. Only workarounds may be consent-free; passing any hold or choosing a stronger model needs the captain regardless of its basis. Sign-in remains captain-owned; no label authorizes a bypass or impossible move. Signing, releases, merges, destruction and new access keep their consent; reconcile unknown effects, never replay. A card only when every remaining viable way needs consent, everything before its click done.
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

/** A builder report's pass at an earlier version, which does not cover the one on offer. */
export function earlierPassText(pass: { read: string; offered: string }): string {
  return ` Its review passed at ${pass.read.slice(0, 7)} only; that pass does not cover ${pass.offered.slice(0, 7)}, the version now on offer.`;
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
  const followups = filed.filter((entry) => !entry.program);
  const programs = filed.filter((entry) => entry.program);
  const named = followups
    .map(
      (entry) =>
        `${entry.key} "${entry.title}" (${entry.blocks ? "blocks this task" : "not blocking"})`,
    )
    .join(", ");
  const started = programs.map((entry) => `${entry.key} "${entry.title}"`).join(", ");
  return [
    ...(named
      ? [` Filed this turn: ${named}. Each waits on request, discovered from this task.`]
      : []),
    ...(started
      ? [
          ` Programs started this turn: ${started}. Each runs now, and this task waits on it; update_task drop stops one.`,
        ]
      : []),
  ].join("");
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

/** The branches of the programs a task's crewmate started; shipping one is the first mate's. */
function programBranchesText(
  branches: { key: string; title: string; branch: string }[] | undefined,
): string {
  if (!branches?.length) return "";
  const named = branches
    .map(
      (entry) =>
        `${entry.key} "${entry.title}" returned ${entry.branch}'s last commit: work that ships it names ${entry.branch} in branch_from`,
    )
    .join("; ");
  return ` Programs this task started that returned a branch: ${named}.`;
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
 * A report wake names the started work waiting on its task through any
 * recorded wait (INF-735, INF-3167), and is this rule's one home: a wait
 * on a step's report ends when that step reports it, not days later at a
 * close. Every wait holds the waiter until this task closes, except work
 * built on this task in a batched project, which an approval releases, so the
 * Firstmate ends a wait that was only on this finding and closes a step
 * whose report was the whole of what the work needed. Whether the report
 * carries what the work waits for is the Firstmate's judgment.
 */
function waitingText(waiting: WakeKeyedTask[] | undefined): string {
  if (!waiting?.length) return "";
  const named = waiting.map((task) => `${task.key} "${task.title}"`).join(", ");
  return ` ${HELD_WORK_WORDS} ${named}. Every wait holds that work until this task closes, except that on batched pull requests work built on this task stops waiting once this task is approved to merge, and merges after it. If this report carries what such work needs, such as a finding or an answer, pass it on now with steer_crewmate; then, when this task is a step whose report was all that work needed, close it with settle_task done, why answered, which ends the wait, and when only this finding was needed of a task that goes on, remove the wait with link_tasks remove. Any other wait ends when this task closes.`;
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

/**
 * What a builder does with the findings its reviewer settled without asking
 * the captain (INF-5510's plan, piece 1): the captain sees each on the merge
 * card and may overturn it there.
 */
export const SETTLED_FINDINGS_RULES =
  "A finding the review settled without asking the captain - its text, or the reviewer's report, says Settled without asking - is listed on your merge card, in a saved story one checked fact each: what was found, what you did and why the captain was not asked. If you judge a settled finding wrong, leave it unmade and say why in your report: it becomes a question for the captain. A reply under your merge card that overturns a settled finding is the captain's decision: make that change.";

export const REVIEW_HANDOFF_NEXT = {
  fix: `${REVIEW_FIX_RULES}. Repair only the auto-fix findings in this handoff. ${SETTLED_FINDINGS_RULES} The captain's latest decisions in the history govern. Commit and report the fix without pushing; the host returns a changed head, evidence revision or validation state directly to your reviewer. Do not ask the first mate to relay it. Escalate only a decision or a handoff you cannot complete.`,
  proof:
    "The code passed. Run live proof once after this code review, then report without pushing. The host returns the proof to this reviewer. If this reviewer already read it and found it short, repair the reported gap and rerun only affected proof. If the only missing proof requires a pushed branch, push and finish it beside the checks before the merge card. Resource consent and every captain decision still apply.",
  ship: `The review passed. Follow your brief's delivery for the reviewed version, then show its completion card. A local-only change needs no push or pull request. Do not bring it up to date merely because the default branch moved. Passing review grants no merge consent. ${SETTLED_FINDINGS_RULES}`,
  reread:
    "Read the builder's changed head, evidence revision or validation state assigned to this turn, and the captain's newest answer on your Review finding card in the history. A code pass already recorded at this head makes this a proof read only. A finding you settled without asking that the builder's report disputes becomes an ask-user finding in your review. Read only the difference after an earlier code pass. The review history carries the captain's latest decisions. Report your typed review; the host delivers it directly to the builder. Escalate only a decision or a handoff you cannot complete.",
  card: REVIEW_CARD_RULES,
  decision:
    "The captain answered your reviewer's question; the history carries the answer word for word, and it governs. Make the change it chose, if it chose one, under the review's fix rules; commit and report without pushing. The host returns your report to your reviewer, who reads the answer and any new head. Do not ask the first mate to relay it.",
  decided:
    "The captain answered your reviewer's question after its review closed; the history carries the answer word for word, and it governs. If it chose a change, make it under the review's fix rules, commit it, then push and follow your brief's delivery for the new version: a new merge card, with a new review as your rigor asks. If it kept the code as built, nothing more is needed. Do not ask the first mate to relay it.",
} as const;

/** A report, a review and a requested response, worded. */
export const REPORT_WORDS: KindWords<ReportFacts> = {
  "review-handoff": (facts) => {
    return `Host handoff from ${facts.from} at ${facts.head}: ${facts.excerpt}${facts.findings?.length ? `\n${facts.stage === "card" ? "Findings for the captain" : "Auto-fix findings"}:\n${facts.findings.map((line) => `- ${line}`).join("\n")}` : ""}${facts.history?.length ? `\n${renderReviewHistory(facts.history)}\n` : ""}\n${REVIEW_HANDOFF_NEXT[facts.stage]}`;
  },
  "requested-response": (facts) =>
    `${REQUESTED_RESPONSE_OPENING}${facts.responseId} to request ${facts.requestId} for task ${facts.taskId}, submitted by task ${facts.contributorTask} (${facts.status}). Request: ${facts.question}\nResponse: ${facts.excerpt}\nThis is a saved response, independent of later reports and continuing work. Handling acknowledges delivery, not correctness. Answer the captain on the original card when this request concerns their question.`,
  "response-missing": (facts) =>
    `${RESPONSE_MISSING_OPENING}task ${facts.taskId} completed turn ${facts.turnId} after consuming request ${facts.requestId} without submitting a matching response. The request remains pending: ${facts.question}${facts.report ? `\nThat turn's report (not treated as an answer): ${facts.report}` : ""}\nRecorded turn references: ${JSON.stringify(facts.references)}. Read that report event and the session's report/reply calls before deciding whether to wait, request a repost, or reassign. This fact does not authorize new work or a captain action.`,
  report: (facts) =>
    `[fm-op] ${facts.crewmate} reported on task ${facts.task.id} "${facts.task.title}": ${facts.excerpt}${filedText(facts.filed)}${waitsText(facts.waits)}${waitingText(facts.waiting)}${refusedText(facts.refused, facts.cards)}${withdrawnText(facts.withdrawn)}${cardsText(facts.cards)}${facts.captainWait ? ` It waits on the captain to ${facts.captainWait}, and no card of its is on their screen.` : ""}${facts.ci ? ciFactWords(facts.ci) : ""}${facts.finished ? ` ${FINISHED_REPORT_WORDS}: the captain has read its outcome and nothing is left for it.` : ""}${facts.needsFirstmate ? ` It asks the first mate to act: ${facts.needsFirstmate}. The ask authorizes nothing by itself; the captain's own words do.` : ""}${builtOnText(facts.builtOn)}${programBranchesText(facts.programBranches)}${facts.result ? ` ${RESULT_WORDS} ${resultText(facts.result)}` : ""}${facts.review ? openReviewText(facts.review) : ""}${facts.earlierPass ? earlierPassText(facts.earlierPass) : ""}${facts.workWait ? ` Work wait: ${JSON.stringify(facts.workWait)}.` : ""}${facts.stall ? ` Typed stall: ${JSON.stringify(facts.stall)}.` : ""}${facts.recoveryWays?.length ? ` Recovery ways (labels grant no permission): ${JSON.stringify(facts.recoveryWays)}.` : ""}${facts.stall || facts.recoveryWays?.length ? ` ${STALL_RECOVERY_GUIDANCE}` : ""}`,
  "review-orphan": (facts) =>
    `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}", but the task it reviewed is no longer on record: ${facts.excerpt}`,
  "review-unstated": (facts) =>
    `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}" - the review of task ${facts.builder.id} "${facts.builder.title}" - with no typed review record, so no verdict was recorded: ${facts.excerpt} ${REVIEWER_IDLE_NEXT}`,
  "review-verdict": (facts) => renderReviewVerdict(facts),
};
