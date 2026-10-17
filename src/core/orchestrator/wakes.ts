import { HERE } from "@shared/deviceNames";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import {
  ABANDON,
  APPROVE_AND_BUILD,
  SAVE_AND_DEFER,
  START_THE_NEXT_STEP,
} from "../prompts/cardContract";
import { CHECK_DIAGNOSIS_NEXT } from "./checkRepair";
/**
 * The typed wake envelope (the primitives review's P3; docs/inbox.md, "The
 * wake envelope"). A wake the host sends names the facts it is about and the
 * ways out, and is rendered to prose once, by `renderWake`, where it is
 * served: the Firstmate's drain, a crewmate's lane, and the ledger row the
 * replay scorer matches the served text against. Nothing an emitter holds
 * as a typed fact is spelled into a sentence at the call site, so the inbox
 * can dedupe a wake by what it says rather than by its wording.
 *
 * Every wake the host composes carries typed facts: the idle ladder, the
 * round caps, the honest retry's outage wakes, the cut-off wakes and the
 * job bound, and the rest - a crewmate's report and a reviewer's verdict, a failed turn or
 * task, a settle's outcome, a card choice, a queued start, the quiet
 * watchdog, a job's exit, a schedule firing, the welcome, and the
 * host-worded steers on a crewmate's lane - and the captain's own turn,
 * framed as his. Prose (`text`) is what an agent wrote - the Firstmate's
 * guidance, a brief - and a row an older build queued; it renders as
 * itself.
 */

import { type AttachmentRef, attachmentWords } from "@shared/attachments";
import type { CutOffClass } from "@shared/authFailure";
import {
  ATTACHMENTS_DROPPED_NOTE,
  type CardAnswer,
  type CardEffect,
  cardAnswerLines,
  REPLY_SETTINGS_HEAD,
} from "@shared/cards";
import type { ProjectSetupOutcome } from "@shared/projectSetup";
import { formatDurationShort } from "@shared/quotaSignals";
import type { ReviewVerdict } from "@shared/rigor";
import type { ServedOrigin } from "@shared/servedFrame";
import { UNKNOWN_OUTCOME_WORDS } from "@shared/taskBrowser";
import { browserCommand } from "../browser/commandWords";
import type { InboxRow, WAKE_ENVELOPE_VERSION } from "../storage/inboxStore";
import type { CardRefusal } from "../storage/taskStore";
import type { SettleRefusal } from "../tasks/taskService";
import { type CiReadingFact, ciFactWords } from "./ciFact";
import { crewHoldWays, type HoldRefusal, type HoldWay, renderHold } from "./holds";
import { REVIEW_FIX_RULES } from "./intentBrief";
import { type NamedModel, namedModelWords } from "./namedModel";
import type { SeatPauseClass } from "./seat";
import type { SeatDigestTurn } from "./seatDigest";

/** The ladder's nudge: finish, or say what blocks you (rung 1, and the stall card's Continue). */
export const IDLE_NUDGE_TEXT =
  "You stopped with nothing running and nothing up for the captain to decide. Either finish - report under the five headings and emit your completion card - or say what blocks you.";

/**
 * What a declared internal step is told it is (FI3-801): its brief makes
 * its report the answer the next step builds on and takes no completion
 * card, so the nudge never asks it for one.
 */
const STEP_ANSWER_WORDS =
  "This task is a step whose answer the next step builds on: your report is that answer, and it takes no completion card - a card is only for something the captain must decide or see before the next step can start.";

/** How the nudge asks a declared internal step to finish: its answer, or what blocks it. */
const STEP_FINISH_WORDS =
  "report the whole answer, if your report does not carry it yet, or say what blocks you. If it already does, nothing is left for you: say so in one line, and the first mate decides the next step.";

/** The nudge to a task the Firstmate declared an internal step (`shape.internal_step`). */
export const IDLE_STEP_NUDGE_TEXT = `You stopped with nothing running and nothing up for the captain to decide. ${STEP_ANSWER_WORDS} Either ${STEP_FINISH_WORDS}`;

/**
 * The nudge while a note is up on the task (FI3-438). A note does not hold
 * the turn, so the ladder still nudges, but it names the note: a crewmate
 * whose outcome it is says it waits, and is never asked to post it again.
 * A declared internal step is asked for its answer, never a completion card.
 */
export function idleNoteNudgeText(note: WakeNote, step = false): string {
  const noted = `You stopped with nothing running, and the note "${note.title}" (${note.id}) is up, asking the captain nothing.`;
  const waits =
    "If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again.";
  return step
    ? `${noted} ${STEP_ANSWER_WORDS} ${waits} Otherwise either ${STEP_FINISH_WORDS}`
    : `${noted} ${waits} Otherwise either finish - report under the five headings and emit your completion card - or say what blocks you.`;
}
/** How the steer telling a crewmate the captain closed its card begins (FI3-435). */
export const CARD_CLOSED_STEER_PREFIX = "The captain closed your card ";

/** Whether a crewmate's served guidance is that steer: the replay finds it no recorded answer. */
export function isCardClosedSteer(text: string): boolean {
  return text.startsWith(CARD_CLOSED_STEER_PREFIX);
}

/** The nudge when the captain wrote last under one of this crewmate's cards. */
export const IDLE_THREAD_NUDGE_TEXT =
  "The captain wrote under your card and you have not answered: answer in the thread with reply, or pass your answer as the reply of your emit_card revision.";

/**
 * The fixed host preamble every captain thread reply carries (cards-as-
 * threads phase 1, R4). It is the process direction the Firstmate used to
 * relay by hand on 27 of 40 turns, said once by the host instead: where to
 * answer, how to change the card, and what is not the crewmate's to do.
 *
 * Since contract v4.14 it also says WHEN (the captain's "ship it" of
 * 2026-09-27, docs/card-threads.md "When a card reaches the stage"): the
 * card comes back to him at the crewmate's close-out, so the crewmate does
 * the work first, answers once, then reports - and never acknowledges, the
 * shape that brought 4 of 25 answered cards back before their answer.
 *
 * The last clause is the settle hand-off, and it is INSTRUCTION, not a
 * classifier: nothing in the host reads the captain's words. A crewmate
 * asked to merge, land, discard, use a stronger model, or take on new work
 * closes its own card and carries those words verbatim into its report,
 * declaring needs_firstmate, which the whose-turn rule routes to the
 * Firstmate on any backend (FI3-710) - the turn that then runs the settle
 * the captain would have got from the main input.
 */
export const THREAD_STEER_PREAMBLE = [
  "The captain replied in the thread on your card.",
  "Do the work his words need first. Then always give one short answer in the thread, one to three sentences, whether or not the card changes: answer with reply(card_id, text) - prose only - and, when his words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call; a revision without one is refused while he waits). Then report.",
  "His reply takes your card off his screen until the answer, unless it is his only card or asked to stay; he sees your answer only when you report, so never acknowledge his words or say what you are about to do: he reads your answer, not your plan.",
  "Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate, so the first mate runs it.",
].join(" ");

/**
 * The words that name a guidance mark on the captain's steer while his kept
 * merge approval stands (FI3-662), followed by the mark; a scripted stand-in
 * reads the mark after them.
 */
export const GUIDANCE_MARK_WORDS = "check_change captainGuidance with mark";

/** What the crewmate is told beside the captain's guidance that holds his kept merge. */
function guidanceMarkNote(mark: number): string {
  return `[kept merge] The captain's merge approval on this task stands, so these words of his hold its merge until you declare their impact: ${GUIDANCE_MARK_WORDS} ${mark} - none if they leave the approved work as it was, changed-work if they change it (then put up a new completion card when the work is ready).`;
}

/**
 * The durable wake emitted when a captain's declared choice closes an answer
 * task. Its effect is context only: direct effects remain host-owned.
 */
export type AnswerTaskClosedPayload = {
  version: 1;
  event: "answer_task_closed";
  task: { id: string; key: string; title: string };
  card: { id: string; title: string };
  choice: { id: string; label: string; effect: CardEffect | null };
  close: { status: "done"; reason: "answered"; actor: "captain" };
};

/** The task a hold-shaped wake is about, as its ways block names it. */
export type WakeTask = {
  id: string;
  title: string;
  difficulty?: "low" | "medium" | "high" | "premium" | null;
  shape?: { escalation?: { attempt: number } } | null;
};

/** A task named by its key as well (its key, or its id when it has none). */
export type WakeKeyedTask = WakeTask & { key: string };

/** A crewmate's card on the captain's screen, as a report wake names it. */
export type WakeCard = { id: string; word: string; title: string };

/** A task a crewmate filed during its turn (cards/tasks/agents P0, WI-4). */
export type WakeFiled = { key: string; title: string; blocks: boolean };

/** Work a task waits on that only a start begins (FI3-671), and whether it was dropped. */
export type WakeWait = { key: string; title: string; state: "not-started" | "dropped" };

/**
 * The captain's choice on a card: the action's id and label, a frame's value
 * as JSON, and the answers to the body's own questions a footer click
 * carried (inline decisions, contract 4.22).
 */
export type WakeChoice = { id: string; label: string; value?: string; answers?: CardAnswer[] };

/** Which lane a wake that goes to either is worded for. */
export type WakeLane = "firstmate" | "crewmate";

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
  cards: WakeCard[];
  /**
   * The builder's brief carries the reviewed fix rules (it was dispatched
   * reviewed). Absent - care raised after the brief, or a row an older
   * build queued - the next step names the rules for the steer.
   */
  briefed?: boolean;
};

/**
 * The reviewed tier's later steps, served where each arises (FI3-566 cut
 * C), the way `CHECK_DIAGNOSIS_NEXT` rides a failed check: the core keeps
 * when to commission a review and that every steer carries the captain's
 * latest decision; the builder's brief keeps how to fix a finding.
 */
export const REVIEWER_IDLE_NEXT =
  "Steer a reviewer only to re-review at a new head its builder reports - an idle reviewer needs no stand-by and no status.";

/** What a findings or blocked verdict asks of the Firstmate next. */
export function reviewFindingsNext(briefed: boolean): string {
  const relay = briefed
    ? "Steer the builder with every auto-fix finding verbatim; its brief says how to fix them."
    : `Steer the builder with every auto-fix finding verbatim, prefixed with - ${REVIEW_FIX_RULES}.`;
  return `${relay} Info findings never block and need no steer. Decide an ask-user finding yourself when the user's own words already settle it; the rest are ONE decision card per round on the builder's task, with the step you would take as its default. ${REVIEWER_IDLE_NEXT}`;
}

/** What a builder's report asks of its open review, which last returned findings or blocked. */
export const REVIEW_NEW_HEAD_NEXT =
  "When this report brings a new head, steer that reviewer to re-review at it, listing findings the captain declined under user_chose_to_ignore with: do not re-report these unless the code genuinely introduces a new, materially different problem. Never steer the reviewer otherwise - an idle reviewer needs no stand-by and no status.";

/** What a passed review asks of the Firstmate next. */
export const REVIEW_PASSED_NEXT =
  "Steer the builder to push, open the PR and drive CI green; its PR report is then handled like any other.";

/** A builder's open review whose last verdict asks for a re-review at a new head. */
export type WakeOpenReview = {
  /** The review task's key. */
  key: string;
  verdict: Exclude<ReviewVerdict, "pass">;
  /** The head that verdict read; absent when none was recorded. */
  head?: string;
};

/** A note up on a task: a card with no actions, which holds no turn. */
export type WakeNote = { id: string; title: string };

/**
 * The typed facts of one wake. `kind` names what it is; everything else is
 * a fact the host read, never a sentence. A new wake adds its kind here.
 */
export type WakeFacts =
  | {
      kind: "task-policies-changed";
      task: { id: string; key: string; title: string };
      policies: EffectiveTaskPolicies;
    }
  | {
      /** The idle ladder's first rung, to the crewmate. */
      kind: "idle-nudge";
      /** The captain wrote last under one of its cards. */
      thread: boolean;
      /** The newest note up on the task, when one is (FI3-438). */
      note?: WakeNote;
      /** The Firstmate declared the task an internal step (`shape.internal_step`, FI3-801). */
      step?: true;
    }
  | {
      /** Rung 2 (and its repeat): an idle crewmate nobody is moving. */
      kind: "idle-stall";
      task: WakeTask;
      /** The live crewmate's name; absent when no runtime holds the task. */
      crewmate?: string;
      /** The task's key (or id), naming the crewmate when no runtime does. */
      key: string;
      idleMs: number;
      /** The captain wrote under its card and nothing queued will answer him. */
      thread: boolean;
      /** This episode's nudge actually went out. */
      nudged: boolean;
      /** 1 for the first wake, 2 for its repeat. */
      wakes: number;
      /** The task's newest report or failure, already capped for a wake. */
      last?: { kind: "report" | "failed"; excerpt: string };
      /** The newest note up on the task, when one is: never "no card up" beside it (FI3-438). */
      note?: WakeNote;
    }
  | {
      /**
       * The idle ladder's reminder (FI3-714): a crewmate asked the Firstmate
       * to act (`needs_firstmate`) and it has not acted on the task since.
       */
      kind: "idle-asked";
      task: WakeTask;
      /** The live crewmate's name; absent when no runtime holds the task. */
      crewmate?: string;
      /** The task's key (or id), naming the crewmate when no runtime does. */
      key: string;
      /** What it asked the Firstmate to do, in its own words. */
      request: string;
      /** How long ago it asked. */
      askedMs: number;
      /** 2 for the first reminder, 3 for the last: the report's own wake was the first. */
      wakes: number;
      /** The task's newest report, already capped for a wake. */
      last?: { kind: "report" | "failed"; excerpt: string };
    }
  | {
      /** Rung 2 (and its repeat) on a task a captain gate holds with no card up. */
      kind: "idle-owed";
      held: "ci-cap" | "review-cap" | "captain-gate";
      task: WakeTask;
      /** What holds it: the gate's reason, or the standing cap's. */
      reason?: string;
      idleMs: number;
      wakes: number;
    }
  | {
      /** The CI round cap was reached: its one wake. */
      kind: "ci-cap";
      task: WakeTask;
      /** Red heads counted, and the cap they reached. */
      rounds: number;
      cap: number;
      /** The head the cap was reached at. */
      head: string;
    }
  | {
      /** The review round cap was reached: it rides the findings wake that reached it. */
      kind: "review-cap";
      /** The task under review, which the cap holds. */
      task: WakeTask;
      /** Findings rounds counted, and the re-reviews the cap allows. */
      rounds: number;
      cap: number;
      /** The findings wake that reached it. */
      findings?: ReviewVerdictFacts;
      /**
       * A row the previous build queued (#348) carried the findings wake as
       * its own prose; such a row still words it.
       */
      report?: string;
    }
  | {
      /** The honest retry: an outage's first provider failure on a lane with guidance. */
      kind: "outage-failed";
      task: WakeTask;
      crewmate: string;
      /** The provider's error, already capped for a wake. */
      error: string;
    }
  | {
      /** The honest retry: the lane is still failing fifteen minutes into its outage. */
      kind: "outage-still-down";
      task: WakeTask;
      /** The live crewmate's name; absent when no runtime holds the task. */
      crewmate?: string;
      /** The task's key (or id), naming the crewmate when no runtime does. */
      key: string;
      /** When the outage began: its lane's earliest `failing_since`. */
      since: number;
      downMs: number;
      failures: number;
    }
  | {
      /** The honest retry: the provider answered after two or more failures. */
      kind: "outage-recovered";
      task: WakeTask;
      crewmate: string;
      failures: number;
    }
  | {
      /**
       * A typed cut-off stands on an account (the cut-off contract): the
       * crewmates on it wait, their guidance kept. Once per cut-off.
       */
      kind: "provider-cut-off";
      /** The provider as the captain names it (the catalog's name). */
      provider: string;
      class: CutOffClass;
      /** When the cut-off began, epoch ms: what makes two cut-offs two facts. */
      since: number;
      /** When a spent allowance returns, epoch ms (`no_headroom` only). */
      resetsAt?: number;
      /** The open tasks on the account. */
      tasks: WakeTask[];
    }
  | {
      /** The cut-off the Firstmate heard about ended: the account serves again. */
      kind: "provider-back";
      provider: string;
      /** When the cut-off it ends began, epoch ms. */
      since: number;
      /** The open tasks on the account, whose kept guidance goes out now. */
      tasks: WakeTask[];
    }
  | {
      /** A background job ran past its bound and no longer counts as the task moving. */
      kind: "job-bound";
      task: WakeTask;
      jobId: string;
      /** The job's command, already capped for a wake. */
      command: string;
      runMs: number;
    }
  | {
      /** A crewmate's turn failed with no guidance of its own for the host to retry. */
      kind: "turn-failed";
      task: WakeTask;
      crewmate: string;
      /** The failure, already capped for a wake. */
      error: string;
    }
  | {
      /**
       * The host could not commit the personal workspace at the end of a
       * crewmate's turn: its files are saved there uncommitted and the task
       * stays open (FI3-1218, docs/personal-panels.md "Report, commit, close").
       */
      kind: "commit-failed";
      task: WakeTask;
      crewmate: string;
      /** The failure's first meaningful line, git's own words (`gitFailure`). */
      error: string;
    }
  | {
      /** A crewmate reported (the report's whose-turn sort said nobody's, or it bypasses the sort). */
      kind: "report";
      task: WakeTask;
      crewmate: string;
      /** The report, already capped for a wake. */
      excerpt: string;
      /** What it filed this turn. */
      filed: WakeFiled[];
      /** The work its task waits on that nobody has started (FI3-671). */
      waits?: WakeWait[];
      /** Its cards on the captain's screen when it reported. */
      cards: WakeCard[];
      /**
       * The host's refusal of its completion card, standing until one goes
       * up: the fact beside a report that says the card went up (FI3-401).
       */
      refused?: CardRefusal;
      /**
       * The report declared its work finished: the captain has read its
       * outcome and nothing is left for it (FI3-435).
       */
      finished?: true;
      /** The report declared that the Firstmate must act, and what on (FI3-710). */
      needsFirstmate?: string;
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
      /** A reviewer reported with no verdict line, so no verdict was recorded. */
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
      /** A findings verdict whose findings were all info. */
      derived: boolean;
      excerpt: string;
    }
  | {
      /** A task closed as failed. */
      kind: "task-failed";
      task: WakeTask;
      error: string;
    }
  | {
      /** A settle the captain chose on a card, run by the host, and its outcome. */
      kind: "settled";
      task: WakeTask;
      /** What the captain chose: merge, land, discard. */
      chose: string;
      outcome: string;
      refusal?: SettleRefusal;
    }
  | {
      /** The captain's choice closed an answer task; the payload is the wake. */
      kind: "answer-closed";
      handoff: AnswerTaskClosedPayload;
    }
  | {
      /** A task lane's guidance spent its attempts and was set aside. */
      kind: "guidance-set-aside";
      task: WakeTask;
      attempts: number;
      /** The guidance, already capped for a wake. */
      excerpt: string;
    }
  | {
      /** The quiet watchdog: a streaming turn with no events for this many minutes. */
      kind: "quiet";
      task: WakeTask;
      crewmate: string;
      minutes: number;
    }
  | {
      /** One turn past the wall-clock bound, in hours to one decimal. */
      kind: "long-turn";
      task: WakeTask;
      crewmate: string;
      hours: number;
    }
  | {
      /**
       * A queued task's wait ended and a crewmate started on it. A start
       * someone asked for - the Firstmate's start_now, the captain's Start -
       * raises none (FI3-695).
       */
      kind: "queued-started";
      task: WakeTask;
      /** The model the user named and the one that took the task (FI3-444). */
      model?: NamedModel;
    }
  | {
      /** A queued task's start failed; `by` is the captain when he pressed Start. */
      kind: "queued-start-failed";
      task: WakeTask;
      error: string;
      by?: "captain";
    }
  | {
      /**
       * The captain moved a task toward starting (Start, a drag to Working,
       * or a drag to Queued): his standing directions apply to it before a
       * crewmate begins. `start` is held as Starting until the turn that
       * reads this starts it; `queue` only asks for the directions, and the
       * host starts the task when its wait ends. `at` tells one press from
       * the next.
       */
      kind: "captain-start";
      task: WakeKeyedTask;
      move: "start" | "queue";
      at: number;
      /** Where the press came from, so the history still records it as his. */
      from?: "task-card";
      panel?: string;
    }
  | {
      /** A queued task waits on a task that closed without finishing. */
      kind: "dead-gate";
      task: WakeKeyedTask;
      blocker: WakeKeyedTask;
      /** How the blocker closed. */
      closed: string;
    }
  | {
      /** The ask-first wake: a reasoning class no model can serve now. */
      kind: "reasoning-wait";
      task: WakeTask;
      requested: string;
      /** The class that could serve it now; absent for the default model. */
      served?: string;
      /**
       * No model sits in the requested class at all, so no quota reset ends
       * the wait: placing a model there does (FI3-848).
       */
      empty?: true;
    }
  | {
      /** The captain chose on a card with no effect: the choice returns to its author. */
      kind: "card-choice";
      to: WakeLane;
      card: { title: string; id?: string; taskId?: string };
      source?: "chrome" | "frame";
      choice: WakeChoice;
      /**
       * The choice was a request card's open-browser action, and the browser
       * the card named was gone (docs/task-browser.md, "Asking for help"): it
       * had stopped, or it ended when the app quit.
       */
      browserGone?: "stopped" | "quit";
    }
  | {
      /**
       * The captain closed a crewmate's card without choosing (FI3-435): its
       * steer, so the author judges what the close meant.
       */
      kind: "card-closed";
      card: { id: string; title: string };
    }
  | {
      /**
       * The captain answered the app's setup card for a project the
       * Firstmate proposed (docs/fleet.md, "Asking the first mate to add a
       * project"): added with the settings he chose there, already on the
       * list, not now - or the card closed - or the setup failed. Told once.
       */
      kind: "project-setup";
      outcome: ProjectSetupOutcome;
      name: string;
      repoId?: string;
      /** The settings it was added with, in words. */
      settings?: string;
      /** The work the card said the Firstmate starts once it is added. */
      work?: string;
      /** Why it could not be added, or which setting could not be saved. */
      reason?: string;
    }
  | {
      kind: "project-change";
      outcome: "applied" | "not-now" | "failed";
      title: string;
      reason?: string;
    }
  | {
      /** The captain replied in a crewmate card's thread: the crewmate's steer. */
      kind: "thread-reply";
      card: { id: string; title: string };
      /** The captain's words, verbatim. */
      words: string;
      answers?: CardAnswer[];
    }
  | {
      /**
       * A line the captain typed in the task card's Crewmate tab
       * (docs/task-card-tabs.md, "Typing"): the crewmate's steer.
       */
      kind: "crewmate-tab-line";
      /** The captain's words, verbatim. */
      words: string;
    }
  | {
      /** A timed wait on an active task is over: its steer. */
      kind: "timed-wait-over";
      reason?: string;
    }
  | {
      /**
       * The captain returned the task's browser (docs/task-browser.md,
       * "Taking control"): its crewmate's one steer, to take a fresh look.
       */
      kind: "browser-returned";
      /** The page's host and port, as the captain read it. */
      site: string;
      /** What the crewmate said it would do once control came back, when it asked. */
      after?: string;
      /**
       * The captain let the task use the saved sign-in for the site rather
       * than signing in (docs/task-browser.md, "Saved sign-ins").
       */
      saved?: true;
    }
  | {
      /**
       * The independent assessment of a repair its crewmate declared unknown
       * ended the captain's kept merge approval (FI3-663): the crewmate's
       * one steer, to put up a new completion card.
       */
      kind: "repair-assessed";
      /** The repaired head the assessment read. */
      head: string;
      verdict: "changed-work" | "unknown" | "unstated" | "failed";
      /** The assessment's report, already capped. */
      excerpt?: string;
    }
  | {
      /** Work an active task waited on closed (FI3-250): its one steer. */
      kind: "dependency-closed";
      /** The work that closed, by its key and title. */
      dependency: { key: string; title: string };
      closed: "done" | "dropped";
      /** How the wait was declared: a baseline wait on its checks, or a blocks link holding its merge. */
      wait: "baseline" | "blocks";
    }
  | {
      /**
       * A requested merge finished and the task is still open (FI3-1543):
       * a referenced pull request merged, or the merge was refused. One
       * confirmed merge wakes once.
       */
      kind: "merge-continued";
      ok: boolean;
      change: string;
      head?: string;
      text: string;
    }
  | {
      /**
       * The captain's click on a kept write (FI3-1571 piece 4): sent once,
       * with the host's answer; unknown, never sent again; or nothing sent.
       * One click wakes once.
       */
      kind: "write-answered";
      ask: string;
      /** `METHOD /path`, as it was kept. */
      call: string;
      place: string;
      outcome: "answered" | "unknown" | "refused";
      status?: number;
      why?: string;
      /** The host's answer as github_write renders it, within the gateway's caps. */
      answer?: string;
    }
  | {
      /**
       * The host's check watch (docs/forge.md, "The check watch"): the first
       * red check while others run, or the steer that ends the watch.
       */
      kind: "checks-settled";
      outcome: CheckWatchOutcome;
      /** How the change is named: "PR #23 <link>", or the sent-up branch. */
      change?: string;
      head?: string;
      /** passed: how many checks completed. */
      count?: number;
      /** failed: the red checks; not-green: the ones that did not pass; timed-out: the ones still running. */
      checks?: { name: string; state: string }[];
      /** timed-out: how long the host watched. */
      waitedMs?: number;
      /** failed at the CI cap: the rounds spent and the cap. */
      cap?: { rounds: number; cap: number };
      /** unreadable: why, in words the crewmate can act on. */
      problem?: string;
      /** unreadable because the app is not signed in: the problem already says what to do. */
      signIn?: boolean;
    }
  | {
      /** A task-scoped run's first failure or terminal reading, independent of PR green. */
      kind: "run-watch";
      outcome:
        | "first-failure"
        | "passed"
        | "failed"
        | "cancelled"
        | "timed-out"
        | "gone"
        | "unreadable";
      runId: number;
      name: string;
      attempt?: number;
      jobs?: { id: number; name: string; failedAt: string | null }[];
      complete?: boolean;
      state?: string;
      problem?: string;
    }
  | {
      /** A background job finished (R2): its owner's next wake or turn. */
      kind: "job-exit";
      to: WakeLane;
      jobId: string;
      /** The command, already cut to its excerpt. */
      command: string;
      exitCode: number | null;
      durationMs: number;
      /** The output's tail, already capped; absent when there was none. */
      tail?: string;
    }
  | {
      /** A schedule came due (R3). */
      kind: "scheduled";
      /** Persisted authority from creation, never inferred from prompt words. */
      captainRequested?: boolean;
      prompt: string;
      /** It was missed while the app was closed. */
      catchUp: boolean;
      /** Further occurrences folded into this one by downtime. */
      missed?: number;
      /**
       * Occurrences also came due while this delivery waited unsent, and were
       * folded into it (docs/automation.md, "Deliveries").
       */
      waited?: true;
      /** The run this delivery records; absent on a wake queued before deliveries were followed. */
      run?: number;
      /** The rule it came from (docs/automation.md); absent on a wake queued before rules had one. */
      rule?: { id: string; name?: string };
      /** The project the rule's prompt is about, when it names one. */
      project?: { key: string; name: string };
    }
  | {
      /** The first launch's one welcome (docs/first-launch.md). */
      kind: "welcome";
      account?: { providerName: string; label: string };
    }
  | {
      /**
       * The captain's words as the Firstmate is served them: live, or parked
       * on its lane (benched, or a steer the session refused).
       */
      kind: "captain-turn";
      words: string;
      /** A legacy row whose pictures were not kept; the parked copy says they are gone. */
      imagesDropped: boolean;
      /** The accepted message's own picture copies; they ride the turn when it is served. */
      attachments?: AttachmentRef[];
      /**
       * The message these words are, on a parked copy: the turn that serves
       * the row reads that message and judges it (answer delivery). Absent
       * on rows older builds queued and on words with no saved message.
       */
      askId?: string;
    }
  | {
      /**
       * The answer-delivery check's one retry: the captain's message was read
       * and nothing took effect after it. Served alone, and the turn may only
       * show an answer (`ANSWER_ONLY_REFUSED_TOOLS`).
       */
      kind: "answer-missing";
      askId: string;
      /** The captain's words, clipped. */
      excerpt: string;
      /** The task the message was filed on, when it was. */
      filedOn?: { id: string; title: string };
      /** The Firstmate card the message was a reply under, when it was. */
      aboutCard?: { id: string; title: string };
      /** Why the card was refused, when a refusal is typed. */
      refusal?: "crewmate-owns" | "card-refused";
      /** The card that owns the work, when a refused card named it. */
      ownedBy?: string;
    }
  | {
      /** Guidance whose pictures a legacy durable copy could not keep, and says so. */
      kind: "attachments-dropped";
      guidance: string | WakeFacts;
    }
  | {
      /** Guidance whose pictures the message keeps copies of; they ride its delivery. */
      kind: "attachments-kept";
      guidance: string | WakeFacts;
      attachments: AttachmentRef[];
    }
  | {
      /**
       * The captain's guidance while his kept merge approval stands
       * (FI3-662), with the mark that holds the merge until its crewmate
       * declares the guidance's impact.
       */
      kind: "kept-merge-guidance";
      guidance: string | WakeFacts;
      mark: number;
    }
  | {
      /**
       * The Firstmate's seat moved on the captain's click (W1 S9): the first
       * turn after the move is told where it answers now, and - when the
       * move changed sessions - what the host saw of the turns it cannot
       * read back (`seatDigest.ts`, bounded there).
       */
      kind: "seat-moved";
      /** Where it answered before and where it answers now: provider name and model. */
      from: WakeSeat;
      to: WakeSeat;
      /**
       * Why it moved, when not only on the captain's word: what paused the
       * seat it left, or its instructions changing under a session that
       * cannot serve them on resume.
       */
      reason?: SeatMoveReason;
      /** The conversation carried over: the new seat resumed the same session. */
      carried: boolean;
      /** The turns served elsewhere that this session has not seen, oldest first. */
      recent: SeatDigestTurn[];
    };

/** What a check watch reports: the first red check, the finish, or the host stopping. */
export type CheckWatchOutcome =
  | "first-failure"
  | "passed"
  | "failed"
  | "not-green"
  | "timed-out"
  | "gone"
  | "unreadable";

function renderRunWatch(facts: Extract<WakeFacts, { kind: "run-watch" }>): string {
  const run = `${facts.name} (run ${facts.runId}${facts.attempt ? `, attempt ${facts.attempt}` : ""})`;
  const jobs = (facts.jobs ?? [])
    .map((job) => `${job.id} ${job.name}${job.failedAt ? ` — failed at "${job.failedAt}"` : ""}`)
    .join("; ");
  const incomplete =
    facts.complete === false
      ? " The job list is incomplete; read the run for the remaining jobs."
      : "";
  switch (facts.outcome) {
    case "first-failure":
      return `The first failed job in ${run} was seen while the run is still going: ${jobs}.${incomplete} Read its log with read_workflow and diagnose it. The app wakes you again when the run ends; end your turn instead of sleeping or looping on reads.`;
    case "passed":
      return `${run} passed. Carry on from where you stopped. This is a run outcome, not a pull request check reading or merge approval.`;
    case "failed":
      return `${run} ended (${facts.state ?? "failed"})${jobs ? `: ${jobs}` : ". No failed job was named"}.${incomplete} Read failed logs with read_workflow before diagnosing; use check_change for a pull request's checks.`;
    case "cancelled":
      return `${run} was cancelled. The app stopped watching it; read the run and report what stopped your work.`;
    case "timed-out":
      return `${run} is still going after 3 hours. The app stopped watching it; take a short read with read_workflow and report a blocker if it never ends.`;
    case "gone":
      return `${run} is no longer available, so the app stopped watching it. Read the run and report what stopped your work.`;
    case "unreadable":
      return `The app could not read ${run}, so it stopped watching it: ${facts.problem ?? "the host did not answer"}. Report a sign-in or access blocker; the captain signs in, never you.`;
  }
}

type ChecksSettledFacts = Extract<WakeFacts, { kind: "checks-settled" }>;

/** The check watch's steer, in the crewmate's words (docs/forge.md, "The check watch"). */
function renderChecksSettled(facts: ChecksSettledFacts): string {
  const change = facts.change ?? "your pull request";
  const head = facts.head ? ` at ${facts.head.slice(0, 7)}` : "";
  const named = (facts.checks ?? []).map((check) => `${check.name} (${check.state})`).join(", ");
  switch (facts.outcome) {
    case "first-failure":
      return `The first failed check on ${change} was seen while others are still running${head}: ${named || "a check failed"}. Read its log and diagnose it. The app wakes you again when the checks finish; end your turn instead of calling check_change again.`;
    case "passed": {
      const next =
        "Carry on from where you stopped. If the rest needs this merged first, file it as Continue: … and end this task with the completion decision.";
      return facts.count
        ? `The checks on ${change} passed${head}: all ${facts.count} completed successfully. ${next}`
        : `The checks on ${change} finished${head} and it reports no checks, so it reads green on the strength of your local gate. ${next}`;
    }
    case "failed":
      return `The checks on ${change} failed${head}: ${named || "a check failed"}. ${
        facts.cap
          ? `${facts.cap.rounds} own repairs failed (the limit is ${facts.cap.cap}): stop here and report it as a blocker.`
          : CHECK_DIAGNOSIS_NEXT
      }`;
    case "not-green":
      return `The checks on ${change} finished${head} without all passing: ${named || "a check did not pass"}. A neutral check keeps it from green. ${facts.cap ? `${facts.cap.rounds} own repairs failed (the limit is ${facts.cap.cap}): stop here and report it as a blocker.` : CHECK_DIAGNOSIS_NEXT}`;
    case "timed-out":
      return `The checks on ${change}${head} are still running after ${formatDurationShort(facts.waitedMs ?? 0)}${named ? `: ${named}` : ""}. The app stopped watching them: read them with check_change, and report a blocker if they never finish.`;
    case "gone":
      return `${change.charAt(0).toUpperCase()}${change.slice(1)} is no longer open where the project lives, so the app stopped watching its checks. Read it with check_change and carry on.`;
    case "unreadable":
      return `The app could not read the checks on ${change}, so it stopped watching them: ${(facts.problem ?? "the host did not answer").replace(/\.$/, "")}.${
        facts.signIn
          ? ""
          : " Read them with check_change; if that fails too, report it as a blocker."
      }`;
  }
}

/** How the wake for a browser the captain returned opens; a scripted stand-in recognizes it by it. */
export const BROWSER_RETURNED_OPENING = "The captain returned control of this task's browser";

/**
 * The captain's return of a task's browser, in the crewmate's words
 * (docs/task-browser.md, "Taking control"): what it may now read, and what
 * returning does not grant.
 */
function renderBrowserReturned(facts: Extract<WakeFacts, { kind: "browser-returned" }>): string {
  const after = facts.after
    ? ` You said that next you would: ${facts.after.replace(/\.$/, "")}.`
    : "";
  if (facts.saved) {
    return `The captain let this task use the sign-in saved on ${HERE.this} for ${facts.site}, and your browser is yours again: its page reloaded with that sign-in. Your earlier refs are gone: run ${browserCommand()} for a fresh look at the page as it is now, and check that it is signed in before you carry on.${after} If the site still asks for a sign-in, it did not take the saved one: ask the captain again on a card, and the captain signs in. A saved sign-in gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.`;
  }
  return `${BROWSER_RETURNED_OPENING}, on ${facts.site}. Your earlier refs are gone: run ${browserCommand()} for a fresh look at the page as it is now, including anything the captain signed in to, and check what changed before you carry on.${after} If you asked the captain to pay or submit something, read what the page says happened and keep only the result, such as a reference. If the page does not confirm it - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain on a card to check in the browser. ${UNKNOWN_OUTCOME_WORDS} Returning control gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.`;
}

/** How the steer for a request card whose browser was gone opens; a scripted stand-in recognizes it by it. */
export const BROWSER_GONE_OPENING = "The captain chose to open your browser from your card";

/**
 * The captain's open-browser choice on a request card whose browser was
 * gone, in the crewmate's words (docs/task-browser.md, "Asking for help"):
 * what the click could not do, and how to ask anew. It never names the
 * action, so a saved sign-in the host offered on the card stays unnamed.
 */
/** What the Firstmate hears when the captain's Add project could not add the project. */
export const SETUP_CARD_FAILED_WORDS = "it could not be added";

/** The setup card's answer, as the Firstmate hears it once. */
function renderProjectSetup(facts: Extract<WakeFacts, { kind: "project-setup" }>): string {
  const work = facts.work ? ` The card said you start this once it is added: ${facts.work}` : "";
  switch (facts.outcome) {
    case "added":
      return `[fm-op] the captain added ${facts.name} (repo_id ${facts.repoId ?? "unknown"}) on its setup card${facts.settings ? `: ${facts.settings}` : ""}.${facts.reason ? ` ${facts.reason}` : ""}${work ? `${work}. Start it now.` : ""}`;
    case "already":
      return `[fm-op] ${facts.name} (repo_id ${facts.repoId ?? "unknown"}) was already on the captain's list when he clicked Add project on its setup card, so nothing changed.${work ? `${work}. Start it now.` : ""}`;
    case "not-now":
      return `[fm-op] the captain did not add ${facts.name}: he chose Not now on its setup card, or closed it. Nothing was added, so do not start work that needs it; ask again only if he does.`;
    case "failed":
      return `[fm-op] the captain clicked Add project on the setup card for ${facts.name}, and ${SETUP_CARD_FAILED_WORDS}: ${facts.reason ?? "no reason was given"}. Nothing was added.`;
  }
}

function renderBrowserGone(facts: Extract<WakeFacts, { kind: "card-choice" }>): string {
  const ended = facts.browserGone === "quit" ? "stopped when Infinitary quit" : "had stopped";
  return `${BROWSER_GONE_OPENING} "${facts.card.title}", but the browser that card named ${ended}, so the captain got no page and nothing the card asked for was done there. Nothing from that browser was kept, and any browser you have now is a newer one. If you still need the captain on the page, open the site again with ${browserCommand("open <url>")} and ask again on a new card with browser_handoff. If the card was about something whose outcome is unknown, such as a payment the site never confirmed, it still is: never submit, reload or resend it, and check where the site lists it, such as its bookings, before you ask. ${UNKNOWN_OUTCOME_WORDS}${answersText(facts.choice, facts.source)}`;
}

/** How the steer after an independent repair assessment ended a kept approval opens. */
export const REPAIR_ASSESSED_OPENING = "An independent assessment of your repair";

/** What ended the approval, in the crewmate's words. */
const ASSESSED_FINDING: Record<Extract<WakeFacts, { kind: "repair-assessed" }>["verdict"], string> =
  {
    "changed-work":
      "found that bringing the change up to date changed the work the captain approved",
    unknown:
      "could not tell whether bringing the change up to date kept the work the captain approved",
    unstated: "gave no clear verdict on what bringing the change up to date did",
    failed: "did not finish",
  };

/**
 * The end of a kept approval its independent repair assessment brought
 * (FI3-663), in the crewmate's words: the captain decides again, on a new
 * completion card for the change as it is now.
 */
function renderRepairAssessed(facts: Extract<WakeFacts, { kind: "repair-assessed" }>): string {
  return `${REPAIR_ASSESSED_OPENING} at ${facts.head} ${ASSESSED_FINDING[facts.verdict]}, so the captain's kept merge approval ended and he decides again. Drive the checks green on the change as it is now and put up a new completion card${facts.verdict === "changed-work" ? " that says what changed from the version he approved" : ""}; do not declare the repair again.${facts.excerpt ? `\n\nThe assessment's report:\n${facts.excerpt}` : ""}`;
}

/** A closed dependency's one steer, in the crewmate's words (FI3-250). */
function renderDependencyClosed(facts: Extract<WakeFacts, { kind: "dependency-closed" }>): string {
  const name = `${facts.dependency.key} "${facts.dependency.title}"`;
  if (facts.wait === "baseline") {
    return facts.closed === "done"
      ? `${name}, the separately owned work your failing checks waited on, is done. Bring your change up to date and read the checks again.`
      : `${name}, the separately owned work your failing checks waited on, was dropped, so nobody is fixing that failure. Lead your report with its key and that it was dropped: that report wakes the first mate, which decides the next move.`;
  }
  return facts.closed === "done"
    ? `${name}, which your task could not merge before, is done. Carry on from where you stopped.`
    : `${name}, which your task could not merge before, was dropped and no longer holds it. Carry on from where you stopped.`;
}

/** A seat as a wake names it: the provider's name and the model id. */
export type WakeSeat = { provider: string; model: string };

/** Why the seat moved, beyond the captain's word. */
export type SeatMoveReason = SeatPauseClass | "instructions";

/**
 * A wake whose facts are typed, with the ways out when it is a hold. `once`
 * names the fact a wake goes out once for (an outage, a job past its
 * bound): the inbox records it durably with the row it queues and never
 * queues a wake with that name about that task again (`enqueueWake`).
 */
export type TypedWake = { facts: WakeFacts; ways?: HoldWay[]; once?: string };

/** What the inbox holds: prose an agent wrote (the Firstmate's steer, a brief), or a typed wake. */
export type WakeBody = string | TypedWake;

/**
 * One inbox row's message (`inbox.payload`): `origin` is the existing
 * `ServedOrigin` column and `ref` the task column; the payload itself holds
 * `{v, facts, ways}` or, for prose, `{v, text}`.
 */
export type WakeEnvelope = {
  v: typeof WAKE_ENVELOPE_VERSION;
  origin: ServedOrigin | null;
  ref: string | null;
  facts?: WakeFacts;
  ways?: HoldWay[];
  text?: string;
};

/** The captain's words, framed as his turn (`[user]`), and whether their pictures were dropped. */
export function captainTurn(
  words: string,
  imagesDropped: boolean,
  attachments?: readonly AttachmentRef[],
  askId?: string,
): TypedWake {
  return {
    facts: {
      kind: "captain-turn",
      words,
      imagesDropped,
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
      ...(askId ? { askId } : {}),
    },
  };
}

/** The name the answer-missing wake goes out once for: the message, so one retry ever. */
export function answerRepairOnce(askId: string): string {
  return `answer-repair:${askId}`;
}

/** The answer-delivery check's one retry for a captain message nothing took effect after. */
export function answerMissingWake(
  facts: Omit<Extract<WakeFacts, { kind: "answer-missing" }>, "kind">,
): TypedWake {
  return { facts: { kind: "answer-missing", ...facts }, once: answerRepairOnce(facts.askId) };
}

/**
 * The nudge as a typed wake: the ladder's rung 1, and the stall card's
 * Continue. The thread's nudge outranks the note's and the step's: the
 * captain spoke, and its words are the same for a step.
 */
export function idleNudge(thread = false, note?: WakeNote, step = false): TypedWake {
  return {
    facts: {
      kind: "idle-nudge",
      thread,
      ...(note && !thread ? { note } : {}),
      ...(step && !thread ? { step: true as const } : {}),
    },
  };
}

/** The CI cap's one wake, asking the Firstmate for the decision card. */
export function ciCapWake(
  task: WakeTask,
  facts: { rounds: number; cap: number; headSha: string },
  premiumCanServe = true,
): TypedWake {
  return {
    facts: {
      kind: "ci-cap",
      task: { id: task.id, title: task.title },
      rounds: facts.rounds,
      cap: facts.cap,
      head: facts.headSha,
    },
    ways: crewHoldWays(task.id, task, undefined, premiumCanServe),
  };
}

/** The findings wake that reached the review cap, with the cap riding it. */
export function reviewCapWake(
  builder: WakeTask,
  facts: { rounds: number; cap: number; findings: ReviewVerdictFacts },
  premiumCanServe = true,
): TypedWake {
  return {
    facts: {
      kind: "review-cap",
      task: { id: builder.id, title: builder.title },
      rounds: facts.rounds,
      cap: facts.cap,
      findings: facts.findings,
    },
    ways: crewHoldWays(builder.id, builder, undefined, premiumCanServe),
  };
}

/** The honest retry's wake at the first provider failure of an outage. */
export function outageFailedWake(task: WakeTask & { crewmate: string }, error: string): TypedWake {
  return {
    facts: {
      kind: "outage-failed",
      task: { id: task.id, title: task.title },
      crewmate: task.crewmate,
      error,
    },
  };
}

/** The name the still-down wake goes out once for: the outage, by when it began. */
export function stillDownOnce(since: number): string {
  return `outage-still-down:${since}`;
}

/** The honest retry's one wake fifteen minutes into an outage, once per outage. */
export function stillDownWake(
  task: WakeTask & { key: string; crewmate?: string },
  outage: { since: number; failures: number },
  now: number,
): TypedWake {
  return {
    facts: {
      kind: "outage-still-down",
      task: { id: task.id, title: task.title },
      ...(task.crewmate ? { crewmate: task.crewmate } : {}),
      key: task.key,
      since: outage.since,
      downMs: now - outage.since,
      failures: outage.failures,
    },
    once: stillDownOnce(outage.since),
  };
}

/** The honest retry's wake when the provider answers after two or more failures. */
export function recoveredWake(task: WakeTask & { crewmate: string }, failures: number): TypedWake {
  return {
    facts: {
      kind: "outage-recovered",
      task: { id: task.id, title: task.title },
      crewmate: task.crewmate,
      failures,
    },
  };
}

/** What every cut-off wake's once-name starts with, so the names can be read back. */
export const CUT_OFF_ONCE_PREFIX = "cut-off:";

/** The name the cut-off wake goes out once for: the cut-off, by its account and when it began. */
export function cutOffOnce(accountId: string, since: number): string {
  return `${CUT_OFF_ONCE_PREFIX}${accountId}:${since}`;
}

/** The name the back wake goes out once for: the cut-off it ends. */
export function providerBackOnce(accountId: string, since: number): string {
  return `provider-back:${accountId}:${since}`;
}

/** The one wake when a cut-off on an account pauses the crewmates on it, once per cut-off. */
export function providerCutOffWake(
  account: { id: string; provider: string },
  cutOff: { class: CutOffClass; since: number; resetsAt?: number },
  tasks: readonly WakeTask[],
): TypedWake {
  return {
    facts: {
      kind: "provider-cut-off",
      provider: account.provider,
      class: cutOff.class,
      since: cutOff.since,
      ...(cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined
        ? { resetsAt: cutOff.resetsAt }
        : {}),
      tasks: tasks.map((task) => ({ id: task.id, title: task.title })),
    },
    once: cutOffOnce(account.id, cutOff.since),
  };
}

/** The one wake when that cut-off ends and the account serves again. */
export function providerBackWake(
  account: { id: string; provider: string },
  since: number,
  tasks: readonly WakeTask[],
): TypedWake {
  return {
    facts: {
      kind: "provider-back",
      provider: account.provider,
      since,
      tasks: tasks.map((task) => ({ id: task.id, title: task.title })),
    },
    once: providerBackOnce(account.id, since),
  };
}

/** The name the job bound's wake goes out once for: the job. */
export function jobBoundOnce(job: { jobId: string; startedAt: number }): string {
  return `job-bound:${job.jobId}:${job.startedAt}`;
}

/** The job bound's one wake, once per job. */
export function jobBoundWake(
  task: WakeTask,
  job: { jobId: string; command: string; startedAt: number },
  now: number,
): TypedWake {
  return {
    facts: {
      kind: "job-bound",
      task: { id: task.id, title: task.title },
      jobId: job.jobId,
      command: job.command,
      runMs: now - job.startedAt,
    },
    once: jobBoundOnce(job),
  };
}

/** The name a closed dependency's steer goes out once for: the work that closed. */
export function dependencyClosedOnce(task: { id: string }): string {
  return `dependency-closed:${task.id}`;
}

/** The one steer to a task whose wait on other work ended with that work's close (FI3-250). */
export function dependencyClosedWake(
  task: { id: string; key: string; title: string; status: string },
  wait: "baseline" | "blocks",
): TypedWake {
  return {
    facts: {
      kind: "dependency-closed",
      dependency: { key: task.key || task.id, title: task.title },
      closed: task.status === "done" ? "done" : "dropped",
      wait,
    },
    once: dependencyClosedOnce(task),
  };
}

const SECOND_WAKE =
  " This is the second time: if nothing is done about it in 30 minutes, the host puts it to the captain on a card of its own.";

/** What a thread reply's steer says before the captain's words. */
function threadReplyLead(facts: Extract<WakeFacts, { kind: "thread-reply" }>): string {
  return [
    THREAD_STEER_PREAMBLE,
    `Card "${facts.card.title}" (${facts.card.id}).`,
    "The captain's words, verbatim:",
  ].join("\n");
}

/**
 * What a line the captain typed in the Crewmate tab says before his words:
 * he reads the crewmate's session as it works, so the line is his direct
 * guidance, answered by the work and the next report.
 */
export const CREWMATE_TAB_STEER_LEAD = [
  "The captain typed this to you in your task's Crewmate tab, where he reads your session as you work.",
  "Treat it as his direct guidance: do what his words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.",
  "Putting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.",
  "The captain's words, verbatim:",
].join("\n");

/**
 * Where the captain's own words sit in a thread reply's steer, or a line he
 * typed in the Crewmate tab, as `renderWake` words it
 * (`SteerEventData.words`), so the record reads them without a copy;
 * undefined for any other wake, or one not worded that way.
 */
export function replyWordsSpan(wake: WakeBody): { from: number; to: number } | undefined {
  if (typeof wake === "string") return undefined;
  const lead =
    wake.facts.kind === "thread-reply"
      ? threadReplyLead(wake.facts)
      : wake.facts.kind === "crewmate-tab-line"
        ? CREWMATE_TAB_STEER_LEAD
        : undefined;
  if (lead === undefined || !("words" in wake.facts)) return undefined;
  const words = wake.facts.words;
  const from = lead.length + 1;
  const to = from + words.length;
  return renderWake(wake).slice(from, to) === words ? { from, to } : undefined;
}

/**
 * The one renderer: a wake's prose, from its facts and ways, or its text
 * when the row holds prose. Pure and deterministic, so the
 * ledger's copy and the served copy are the same bytes.
 */
export function renderWake(wake: string | Pick<WakeEnvelope, "facts" | "ways" | "text">): string {
  if (typeof wake === "string") return wake;
  const facts = wake.facts;
  if (!facts) return wake.text ?? "";
  try {
    return renderFacts(facts, wake);
  } catch {
    // A known kind whose facts are not the shape this build words - a row
    // an older build queued, or a malformed one - is served as data, never
    // thrown: one row must not wedge its lane's drain.
    return wake.text ?? unknownWake(facts, wake.ways);
  }
}

/** A report wake's words for work its crewmate declared finished; a scripted stand-in recognizes them. */
export const FINISHED_REPORT_WORDS = "It declared its work finished";
/** The welcome wake's words for a captain new to cards; a scripted stand-in recognizes them. */
export const WELCOME_WAKE_WORDS = "has never seen a card";

/** Which rule a scheduled wake came from and the project it names: ` by automation 1a2b "Weekly review" for project FI3 (firstmate-3000)`. */
function scheduledSource(facts: Extract<WakeFacts, { kind: "scheduled" }>): string {
  const rule = facts.rule
    ? ` by automation ${facts.rule.id}${facts.rule.name ? ` ${JSON.stringify(facts.rule.name)}` : ""}`
    : "";
  const project = facts.project ? ` for project ${facts.project.key} (${facts.project.name})` : "";
  return rule + project;
}

function renderFacts(facts: WakeFacts, wake: Pick<WakeEnvelope, "ways" | "text">): string {
  switch (facts.kind) {
    case "task-policies-changed":
      return `Current policies for ${facts.task.key || facts.task.id}: ${JSON.stringify(facts.policies)}. These replace earlier delivery/care/merging instructions, not scope. Keep working without restarting; never start queued work from this notice. Before the next push or merge, perform any validation/review the new care requires. Retain published work, the existing pull request, evidence, repair counts and all unrelated holds. A lower care removes only policy-owned requirements. Explicit self-merging permission can release an already-ready result: the first mate rechecks every requirement and uses the existing settle path, without another approval click. It grants no permission past other decisions, explicit withdrawal holds, dependencies, caps or failed checks. Ask-first cancels unsent merges; a merge already sent cannot be stopped. Read the current record before acting.`;
    case "idle-nudge":
      if (facts.thread) return IDLE_THREAD_NUDGE_TEXT;
      if (facts.note) return idleNoteNudgeText(facts.note, facts.step === true);
      return facts.step ? IDLE_STEP_NUDGE_TEXT : IDLE_NUDGE_TEXT;
    case "idle-stall": {
      const state = facts.thread
        ? "since the captain wrote under its card, without answering him, and nothing queued will"
        : facts.note
          ? `with nothing running, nothing queued and only the note "${facts.note.title}" (${facts.note.id}) up, which asks the captain nothing`
          : "with nothing running, nothing queued and no card up";
      // A crewmate whose outcome that note is need only say it waits.
      const noted =
        facts.note && !facts.thread
          ? " If that note is its outcome, steer it to report waiting on the captain naming the note, never to post it again."
          : "";
      const crewmate = facts.crewmate ?? `the crewmate on ${facts.key}`;
      const last = !facts.last
        ? ""
        : facts.last.kind === "report"
          ? ` Its last report: ${facts.last.excerpt}`
          : ` Its last turn ${facts.last.excerpt}`;
      return renderHold(
        hold(
          "idle-stall",
          facts.task,
          wake.ways,
          `[fm-op] ${crewmate} on task ${facts.task.id} "${facts.task.title}" has been idle for ${formatDurationShort(facts.idleMs)} ${state}${facts.nudged ? "; the host's nudge did not move it" : ""}.${noted}${repeat(facts.wakes)}${last}`,
        ),
      );
    }
    case "idle-asked": {
      const crewmate = facts.crewmate ?? `the crewmate on ${facts.key}`;
      const last = facts.last?.kind === "report" ? ` Its report: ${facts.last.excerpt}` : "";
      const reminder =
        facts.wakes >= 3
          ? " This is the last reminder: nothing more is sent about it, and its crew line says it is stalled."
          : " If nothing is done about it in 30 minutes, you are reminded once more.";
      return `[fm-op] ${crewmate} on task ${facts.task.id} "${facts.task.title}" asked you ${formatDurationShort(facts.askedMs)} ago to act: ${facts.request}. You have not acted on that task since: no steer, card or change to it, and no task built on it or under it was created or started.${reminder} The ask authorizes nothing by itself; the captain's own words do. Act on it, or steer the crewmate to tell it why not.${last}`;
    }
    case "idle-owed":
      return renderHold(
        hold(
          facts.held,
          facts.task,
          wake.ways,
          `[fm-op] task ${facts.task.id} "${facts.task.title}" is held for the captain${facts.reason ? ` by ${facts.reason}` : ""} and has had no card up for ${formatDurationShort(facts.idleMs)}: its crewmate cannot move until the captain answers one.${repeat(facts.wakes)}`,
        ),
      );
    case "ci-cap":
      return renderHold(
        hold(
          "ci-cap",
          facts.task,
          wake.ways,
          `[fm-op] task ${facts.task.id} "${facts.task.title}" hit its CI cap: ${facts.rounds} own repairs failed (the cap is ${facts.cap}), last at ${facts.head.slice(0, 7)}. Its completion card and its re-reviews are held until the captain answers and your steer reopens its rounds.`,
        ),
      );
    case "review-cap":
      return `${facts.findings ? renderReviewVerdict(facts.findings, false) : (facts.report ?? "")}${renderHold(
        hold(
          "review-cap",
          facts.task,
          wake.ways,
          ` This is findings round ${facts.rounds} on task ${facts.task.id}, past the review cap of ${facts.cap} re-reviews: no more re-reviews go out until the captain answers and your steer reopens the rounds.`,
        ),
      )}`;
    case "outage-failed":
      return `[fm-op] ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}" failed at the provider: ${facts.error}. Nothing was set aside: the host keeps its guidance and retries it on its own, backing off to every 15 minutes, so do not resend it. You will hear when it answers again, and if it is still failing in 15 minutes. You can still steer or interrupt it.`;
    case "outage-still-down":
      return `[fm-op] ${facts.crewmate ?? `the crewmate on ${facts.key}`} on task ${facts.task.id} "${facts.task.title}" is still failing at the provider after ${Math.round(facts.downMs / 60_000)} minutes and ${facts.failures} tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.`;
    case "outage-recovered":
      return `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" is answering again after ${facts.failures} failed tries at the provider; its guidance went through.`;
    case "provider-cut-off":
      return `[fm-op] ${cutOffOpening(facts)}: ${tasksText(facts.tasks)}. Their guidance is kept, and nothing is sent to ${facts.provider} ${cutOffWayBack(facts)}; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.`;
    case "provider-back":
      return facts.tasks.length > 0
        ? `[fm-op] ${providerBackOpening(facts.provider)}: ${tasksText(facts.tasks)}. Their kept guidance goes out now.`
        : `[fm-op] ${facts.provider} is answering again; no crewmate is left waiting on it.`;
    case "job-bound":
      return `[fm-op] task ${facts.task.id} "${facts.task.title}" has had a background job running for ${Math.round((facts.runMs / 3_600_000) * 10) / 10} hours: "${facts.command}". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.`;
    case "turn-failed":
      return `[fm-op] ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}" failed: ${facts.error}. The crewmate is still steerable; you can retry, steer, or interrupt it.`;
    case "commit-failed":
      return `[fm-op] the host could not commit the personal workspace at the end of ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}", so the task stays open rather than closing as built in place. What it changed is saved in the workspace but not committed. Its crewmate's next report tries the commit again: steer it to look into the error and report again, or tell the captain. The error: ${facts.error}`;
    case "report":
      return `[fm-op] ${facts.crewmate} reported on task ${facts.task.id} "${facts.task.title}": ${facts.excerpt}${filedText(facts.filed)}${waitsText(facts.waits)}${refusedText(facts.refused, facts.cards)}${cardsText(facts.cards)}${facts.ci ? ciFactWords(facts.ci) : ""}${facts.finished ? ` ${FINISHED_REPORT_WORDS}: the captain has read its outcome and nothing is left for it.` : ""}${facts.needsFirstmate ? ` It asks the first mate to act: ${facts.needsFirstmate}. The ask authorizes nothing by itself; the captain's own words do.` : ""}${facts.review ? openReviewText(facts.review) : ""}`;
    case "review-orphan":
      return `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}", but the task it reviewed is no longer on record: ${facts.excerpt}`;
    case "review-unstated":
      return `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}" - the review of task ${facts.builder.id} "${facts.builder.title}" - with no verdict line, so no verdict was recorded: ${facts.excerpt} ${REVIEWER_IDLE_NEXT}`;
    case "review-verdict":
      return renderReviewVerdict(facts);
    case "review-passed": {
      const risk = facts.risk
        ? `risk ${facts.risk}${facts.riskNote ? `: ${facts.riskNote}` : ""}`
        : "risk unstated";
      return `[fm-op] the review of task ${facts.task.id} "${facts.task.title}" passed at ${facts.head ? facts.head.slice(0, 7) : "an unrecorded head"} (${risk})${facts.derived ? " (info-only findings; derived pass)" : ""}; the hold is released and review task ${facts.reviewKey} is closed. ${facts.crewmate}'s report: ${facts.excerpt} ${REVIEW_PASSED_NEXT}`;
    }
    case "task-failed":
      return `[fm-op] task ${facts.task.id} "${facts.task.title}" failed: ${facts.error}`;
    case "settled":
      return `[fm-op] the captain chose ${facts.chose} for task ${facts.task.id} "${facts.task.title}"; the host settled it and the outcome was: ${facts.outcome}${facts.refusal ? `\n\`\`\`json\n${JSON.stringify(facts.refusal, null, 2)}\n\`\`\`` : ""}`;
    case "answer-closed":
      return `[fm-op] ${JSON.stringify({
        ...facts.handoff,
        read: {
          tool: "tasks",
          arguments: { key: facts.handoff.task.key || facts.handoff.task.id },
        },
        next: `This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: ${APPROVE_AND_BUILD}, ${START_THE_NEXT_STEP} and ${SAVE_AND_DEFER} are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, ${ABANDON}) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates.`,
      })}`;
    case "guidance-set-aside":
      return `[fm-op] guidance for task ${facts.task.id} "${facts.task.title}" could not be delivered after ${facts.attempts} attempts and was set aside: ${facts.excerpt}. You can interrupt the task or spawn a follow-up.`;
    case "quiet":
      return `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" has produced no events for ${facts.minutes} minutes; it may be stuck. You can steer or interrupt it.`;
    case "long-turn":
      return `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" has been on one turn for ${facts.hours} hours.`;
    case "queued-started":
      return `[fm-op] queued task ${facts.task.id} "${facts.task.title}" started - its wait ended. A crewmate is working on it now${facts.model ? `, ${namedModelWords(facts.model)}` : ""}.`;
    case "queued-start-failed":
      return facts.by === "captain"
        ? `[fm-op] the captain pressed Start on task ${facts.task.id} "${facts.task.title}", and it could not start: ${facts.error}`
        : `[fm-op] queued task ${facts.task.id} "${facts.task.title}" could not start: ${facts.error}`;
    case "captain-start":
      return facts.move === "start"
        ? `[fm-op] the captain pressed Start on task ${facts.task.id} ${facts.task.key} "${facts.task.title}". It shows Starting and waits for you. Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction's id, then update_task start_now. Never decline his Start; if no direction applies, just start_now.`
        : `[fm-op] the captain queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}". Apply every standing direction that bears on it with update_task (merging, delivery, care, model, runs_on), passing direction with each direction's id. Do not start it: the host starts it when its wait ends.`;
    case "dead-gate":
      return `[fm-op] queued task ${facts.task.id} ${facts.task.key} "${facts.task.title}" waits on ${facts.blocker.key} "${facts.blocker.title}", which was ${facts.closed}, so its wait can never end; the dead edge is blocks ${facts.blocker.key} -> ${facts.task.key}.`;
    case "reasoning-wait": {
      const wait = facts.empty
        ? `no model is placed at ${facts.requested}, so no quota reset will start it; it waits until one is placed at ${facts.requested} in Settings → Intelligence → Models`
        : `none has quota right now; it waits on the ${facts.requested} quota reset`;
      return `[fm-op] task ${facts.task.id} "${facts.task.title}" needs a ${facts.requested} model and ${wait} unless you say otherwise, and ${facts.served ? `a ${facts.served} model` : "the default model"} could serve it now.`;
    }
    case "card-choice":
      if (facts.to === "firstmate") {
        const about = `card "${facts.card.title}"${facts.card.id ? ` (${facts.card.id})` : ""}${facts.card.taskId ? ` on task ${facts.card.taskId}` : ""}`;
        return facts.source === "frame"
          ? `[fm-op] a script chose "${facts.choice.label}" (${facts.choice.id}) on ${about}.${valueText(facts.choice)}${answersText(facts.choice, facts.source)}`
          : `[user]\n${facts.choice.label}\nChoice on ${about}.${valueText(facts.choice)}${answersText(facts.choice)}`;
      }
      if (facts.browserGone) return renderBrowserGone(facts);
      return `Card "${facts.card.title}": ${facts.source === "frame" ? "a script" : "the user"} chose "${facts.choice.label}" (${facts.choice.id}).${valueText(facts.choice)}${answersText(facts.choice, facts.source)}`;
    case "card-closed":
      return `${CARD_CLOSED_STEER_PREFIX}"${facts.card.title}" (${facts.card.id}) without choosing.`;
    case "project-change":
      return `The captain answered the app’s project change card “${facts.title}”: ${facts.outcome}.${facts.reason ? ` ${facts.reason}` : ""} Read the current project values before starting work. This is an outcome, not permission for another change.`;
    case "project-setup":
      return renderProjectSetup(facts);
    case "crewmate-tab-line":
      return `${CREWMATE_TAB_STEER_LEAD}\n${facts.words}`;
    case "thread-reply":
      return [
        threadReplyLead(facts),
        facts.words,
        ...(facts.answers?.length ? [REPLY_SETTINGS_HEAD, ...cardAnswerLines(facts.answers)] : []),
      ].join("\n");
    case "timed-wait-over":
      return `The time this task was waiting for has come${facts.reason ? ` (${facts.reason})` : ""}. Carry on from where you stopped.`;
    case "merge-continued":
      return facts.ok
        ? `[fm-op] ${MERGE_CONTINUED_LEAD} ${facts.change}${facts.head ? ` at ${facts.head}` : ""}. The task stays open. Continue from that result. Dropping this task does not close that pull request. ${facts.text}`
        : `[fm-op] the captain's merge of ${facts.change} did not happen. Nothing was merged. ${facts.text}`;
    case "write-answered":
      return facts.outcome === "answered"
        ? `[fm-op] ${WRITE_ANSWERED_LEAD} ${facts.ask} (${facts.call}) to ${facts.place}, once. ${facts.place} answered ${facts.status}. It is never sent again; continue from this answer.\n${facts.answer ?? ""}`
        : facts.outcome === "unknown"
          ? `[fm-op] ${WRITE_ANSWERED_LEAD} ${facts.ask} (${facts.call}) to ${facts.place}, once, and what came of it is unknown: ${sentence(facts.why)} It is never sent again; read ${facts.place} to see what happened before you do anything that depends on it.`
          : `[fm-op] the captain's click on ask ${facts.ask}${facts.call ? ` (${facts.call})` : ""} sent nothing: ${sentence(facts.why)} To try again, make a new write with github_write and ask on a new card.`;
    case "run-watch":
      return renderRunWatch(facts);
    case "checks-settled":
      return renderChecksSettled(facts);
    case "dependency-closed":
      return renderDependencyClosed(facts);
    case "repair-assessed":
      return renderRepairAssessed(facts);
    case "browser-returned":
      return renderBrowserReturned(facts);
    case "job-exit":
      return `${facts.to === "firstmate" ? "[fm-op]" : "[job]"} background job ${facts.jobId} finished: "${facts.command}" exited ${facts.exitCode ?? "by signal"} after ${formatJobDuration(facts.durationMs)}${facts.tail !== undefined ? `. Output tail:\n${facts.tail}` : " with no output"}`;
    case "scheduled":
      return `[fm-op] scheduled${scheduledSource(facts)}${facts.catchUp ? ` (catch-up - missed while Infinitary was ${facts.waited ? "closed or busy" : "closed"}${facts.missed ? `; ${facts.missed} more ${facts.missed === 1 ? "occurrence" : "occurrences"} folded in` : ""})` : ""}: ${facts.prompt}`;
    case "welcome":
      return (
        `[fm-op] The captain just connected their first subscription${facts.account ? ` (${facts.account.providerName}, ${facts.account.label})` : ""} and ${WELCOME_WAKE_WORDS}. ` +
        "No repositories are set up yet. Introduce how you work in one standalone note, in your own words: " +
        "a card comes back for every ask - an answer, a decision, or word that a crewmate is on it; " +
        "crew do the work in the background and report to the activity feed on the left; " +
        "every ask becomes a task in the tasks panel on the right; then say what to tell you first - " +
        "a repository to clone, a new project, or a folder to adopt. No project work."
      );
    case "captain-turn":
      return `[user]\n${facts.words}${facts.imagesDropped ? `\n\n${ATTACHMENTS_DROPPED_NOTE}` : ""}`;
    case "answer-missing":
      return renderAnswerMissing(facts);
    case "seat-moved":
      return renderSeatMoved(facts);
    case "attachments-kept":
      return `${
        typeof facts.guidance === "string"
          ? facts.guidance
          : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
      }\n\n[attached: ${attachmentWords(facts.attachments)}]`;
    case "kept-merge-guidance":
      return `${
        typeof facts.guidance === "string"
          ? facts.guidance
          : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
      }\n\n${guidanceMarkNote(facts.mark)}`;
    case "attachments-dropped":
      return `${ATTACHMENTS_DROPPED_NOTE}\n\n${
        typeof facts.guidance === "string"
          ? facts.guidance
          : renderWake({ facts: facts.guidance, ...(wake.ways ? { ways: wake.ways } : {}) })
      }`;
    default:
      // A kind this build does not know - a row a newer build queued - is
      // still served: its text if it carries one, else its facts as data.
      return wake.text ?? unknownWake(facts, wake.ways);
  }
}

/** How the answer-delivery retry's wake opens; a scripted stand-in recognizes the retry by it. */
export const ANSWER_MISSING_OPENING = "Nothing took effect after the captain's message";

function renderAnswerMissing(facts: Extract<WakeFacts, { kind: "answer-missing" }>): string {
  const about = facts.aboutCard
    ? ` It was a reply under your card "${facts.aboutCard.title}" (${facts.aboutCard.id}).`
    : facts.filedOn
      ? ` It was filed on task ${facts.filedOn.id} "${facts.filedOn.title}".`
      : "";
  const refused = facts.refusal
    ? facts.refusal === "crewmate-owns"
      ? ` Your card was refused because ${facts.ownedBy ? `the crewmate's card ${facts.ownedBy}` : "the crewmate's card"} owns that work.`
      : " Your card was refused."
    : "";
  return `[fm-op] ${ANSWER_MISSING_OPENING}, so they have no answer yet. Their words, verbatim: "${facts.excerpt}".${about}${refused} Show them the answer now with emit_card, or answer in the card's thread; a reaction may stand in only when the message asks for nothing. Starting, steering, stopping or closing work and changing settings are refused this turn.`;
}

/** How the seat-moved wake opens when the captain moved the seat. */
export const SEAT_MOVED_OPENING = "Your seat moved on the captain's word";

/** What paused the seat a move left, in the words the seat-moved wake uses. */
const SEAT_PAUSE_WORDS: Record<SeatPauseClass, string> = {
  signed_out: "needed a new sign-in",
  no_headroom: "had used up its allowance",
  refused: "had stopped answering",
  client: `could not run on ${HERE.this}`,
  unavailable: "was no longer available",
};

function renderSeatMoved(facts: Extract<WakeFacts, { kind: "seat-moved" }>): string {
  const seat = (entry: WakeSeat) => `${entry.provider} (${entry.model})`;
  const reason = facts.reason;
  const renewed = reason === "instructions";
  const head = renewed
    ? `[fm-op] Your instructions changed, so you now answer in a new conversation on ${seat(facts.to)}.`
    : `[fm-op] ${SEAT_MOVED_OPENING}: you now answer on ${seat(facts.to)}; before, you answered on ${seat(facts.from)}${
        reason ? `, which ${SEAT_PAUSE_WORDS[reason]}` : ""
      }.`;
  if (facts.carried) return `${head} This conversation carried over.`;
  const there = renewed ? "before the change" : "there";
  const truth = ` Your conversation ${there} does not carry over to this one: the context block is the host's truth about the crew, tasks and cards.`;
  if (facts.recent.length === 0) {
    return `${head}${truth} The host has no record of turns you took ${there} that this conversation has not seen.`;
  }
  const lines = facts.recent.map((turn) => {
    const parts = [
      turn.trigger === "captain"
        ? turn.asked
          ? `the captain said "${turn.asked}"`
          : "the captain spoke"
        : "operational updates",
      turn.tools.length > 0 ? `you used ${turn.tools.join(", ")}` : "you used no tool",
      ...(turn.said ? [`you said "${turn.said}"`] : []),
      ...(turn.failed ? ["the turn failed"] : []),
    ];
    return `- ${parts.join("; ")}`;
  });
  const count =
    facts.recent.length === 1
      ? `Your last turn ${there}, as the host recorded it:`
      : `Your last ${facts.recent.length} turns ${there}, as the host recorded them, oldest first:`;
  return `${head}${truth} ${count}\n${lines.join("\n")}`;
}

/** One inbox row as the drain serves it: its prose, and the row it came from. */
export type DrainedWake = {
  id: number;
  ref: string | null;
  origin: ServedOrigin | null;
  body: string;
};

/**
 * The one drain (the primitives review's P4): a lane's rows as they are
 * served, each rendered once by `renderWake`, oldest first. The Firstmate
 * frames each as a segment of its turn; a crewmate's lane joins them into
 * one turn (`laneTurnText`) or quotes them (`laneText`).
 */
export function drainWakes(rows: readonly InboxRow[]): DrainedWake[] {
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref ?? null,
    origin: row.origin ?? null,
    body: renderWake(row),
  }));
}

/**
 * How a crewmate's message opens when a quit or crash cut short the turn
 * that was serving it and the next launch delivers it again (docs/inbox.md,
 * "A turn a quit or crash cut"); a scripted stand-in recognizes it by it.
 */
export const RESTART_REPLAY_NOTE =
  "Delivered again after a restart: the app closed - a quit or a crash - while your turn on the message below was running, so that turn may already have done part of it. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - and carry on from there rather than doing it twice.";

/**
 * A crewmate lane's rows as the words they carry, joined by a space: the
 * guidance a feed line or a wake quotes. The turn that serves them is
 * `laneTurnText`.
 */
export function laneText(rows: readonly InboxRow[]): string {
  return drainWakes(rows)
    .map((wake) => wake.body)
    .join(" ");
}

/**
 * A crewmate lane's rows as the turn that serves them: each row a quit or
 * crash cut a turn on opens with `RESTART_REPLAY_NOTE`, so the crewmate
 * reads a replay as one, never as new work.
 */
export function laneTurnText(rows: readonly InboxRow[]): string {
  return rows
    .map((row) => {
      const body = renderWake(row);
      return row.cuts > 0 ? `${RESTART_REPLAY_NOTE}\n\n${body}` : body;
    })
    .join("\n\n");
}

/**
 * Guidance whose pictures ride only the live steer: the durable copy says
 * they could not be kept, so a redelivered turn never loses them silently.
 */
export function withAttachmentsKept(
  body: WakeBody,
  attachments: readonly AttachmentRef[],
): TypedWake {
  if (typeof body === "string") {
    return { facts: { kind: "attachments-kept", guidance: body, attachments: [...attachments] } };
  }
  return {
    facts: { kind: "attachments-kept", guidance: body.facts, attachments: [...attachments] },
    ...(body.ways ? { ways: body.ways } : {}),
  };
}

/**
 * The captain's guidance with the mark that holds his kept merge (FI3-662):
 * the mark rides the message itself, so its crewmate can declare only
 * guidance it read. Pictures wrap outside it (`withAttachmentsKept`).
 */
export function withGuidanceMark(body: WakeBody, mark: number): TypedWake {
  if (typeof body === "string") {
    return { facts: { kind: "kept-merge-guidance", guidance: body, mark } };
  }
  return {
    facts: { kind: "kept-merge-guidance", guidance: body.facts, mark },
    ...(body.ways ? { ways: body.ways } : {}),
    ...(body.once !== undefined ? { once: body.once } : {}),
  };
}

/** The pictures a lane row's message keeps copies of, in order. */
export function rowAttachments(rows: readonly InboxRow[]): AttachmentRef[] {
  return rows.flatMap((row) => {
    const facts = row.facts;
    if (facts?.kind === "attachments-kept") return facts.attachments;
    if (facts?.kind === "captain-turn") return facts.attachments ?? [];
    return [];
  });
}

export function withAttachmentsDropped(body: WakeBody): TypedWake {
  if (typeof body === "string") return { facts: { kind: "attachments-dropped", guidance: body } };
  return {
    facts: { kind: "attachments-dropped", guidance: body.facts },
    ...(body.ways ? { ways: body.ways } : {}),
  };
}

function unknownWake(facts: unknown, ways: HoldWay[] | undefined): string {
  return `[fm-op] a wake this version cannot word:\n\`\`\`json\n${JSON.stringify({ facts, ...(ways ? { ways } : {}) }, null, 2)}\n\`\`\``;
}

/**
 * A reviewer's findings or blocked verdict, with what it asks next. The
 * review cap rides a findings one without them: its own words name the way.
 */
function renderReviewVerdict(facts: ReviewVerdictFacts, next = true): string {
  return `[fm-op] ${facts.crewmate} reported on review task ${facts.task.id} "${facts.task.title}" - the review of task ${facts.builder.id} "${facts.builder.title}" - with verdict ${facts.verdict}: ${facts.excerpt}${cardsText(facts.cards)}${next ? ` ${reviewFindingsNext(facts.briefed === true)}` : ""}`;
}

/** A builder report's open review, and the re-review it may ask for. */
function openReviewText(review: WakeOpenReview): string {
  return ` Its open review ${review.key} last returned ${review.verdict} at ${review.head ? review.head.slice(0, 7) : "an unrecorded head"}. ${REVIEW_NEW_HEAD_NEXT}`;
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
  return ` The host refused its completion card "${refused.title}" at ${new Date(refused.at).toISOString()}: ${why}. That card did not reach the captain${screen}.`;
}

/** Tasks as a wake names them. */
function tasksText(tasks: readonly WakeTask[]): string {
  return tasks.map((task) => `task ${task.id} "${task.title}"`).join(", ");
}

type CutOffFacts = Extract<WakeFacts, { kind: "provider-cut-off" }>;

/** How the cut-off wake opens: what stopped the account, and that its crewmates are paused. */
export function cutOffOpening(facts: Pick<CutOffFacts, "class" | "provider">): string {
  return `${cutOffCause(facts)}, so the crewmates on it are paused`;
}

/** How the back wake opens when crewmates were paused on the account. */
export function providerBackOpening(provider: string): string {
  return `${provider} is answering again, so the crewmates paused on it go on`;
}

/** What stopped the account serving, per class. */
function cutOffCause(facts: Pick<CutOffFacts, "class" | "provider">): string {
  switch (facts.class) {
    case "refused":
      return `${facts.provider} is refusing this sign-in`;
    case "signed_out":
      return `${facts.provider} needs the captain to sign in again`;
    case "no_headroom":
      return `${facts.provider} has used up this plan's allowance`;
  }
}

/**
 * When the host asks the account again: only when a fact changes, never on
 * a timer (the cut-off contract). A fresh sign-in into the same account is
 * not such a fact for a refusal.
 */
function cutOffWayBack(facts: CutOffFacts): string {
  switch (facts.class) {
    case "refused":
      return `until a different ${facts.provider} account is signed in, its app is updated, or the captain asks to try again`;
    case "signed_out":
      return "until the captain signs in again";
    case "no_headroom":
      return facts.resetsAt !== undefined
        ? `before it resets at ${new Date(facts.resetsAt).toISOString()}`
        : "before it resets";
  }
}

/** A frame action's value, as the choice's author reads it. */
function valueText(choice: WakeChoice): string {
  return choice.value !== undefined ? `\nCard action value (JSON): ${choice.value}` : "";
}

/** The answers a footer click carried, as the card's author reads them. */
function answersText(choice: WakeChoice, source?: "chrome" | "frame"): string {
  if (!choice.answers?.length) return "";
  const who = source === "frame" ? "The script submitted answers" : "The user's answers";
  return `\n${who} to the card's questions:\n${cardAnswerLines(choice.answers).join("\n")}`;
}

/** A job's run time in the words its exit wake has always used. */
function formatJobDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function repeat(wakes: number): string {
  return wakes >= 2 ? SECOND_WAKE : "";
}

function hold(
  held: HoldRefusal["held"],
  task: WakeTask,
  ways: HoldWay[] | undefined,
  text: string,
): HoldRefusal {
  return { held, task: { id: task.id, title: task.title }, ways: ways ?? [], text };
}

/** Words a host wrote, ended as one sentence. */
function sentence(words: string | undefined): string {
  const trimmed = (words ?? "").trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** How a confirmed `merge-continued` steer opens, after its `[fm-op]` mark. */
export const MERGE_CONTINUED_LEAD = "the captain merged";

/** How a `write-answered` steer opens when the captain's click sent the write. */
export const WRITE_ANSWERED_LEAD = "the captain sent ask";
