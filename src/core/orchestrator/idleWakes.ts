/**
 * The idle ladder's wakes: a crewmate left idle with nothing running, one
 * stalled after its nudge, an ask the first mate has not acted on, a task
 * held for the captain with no card up, finished work still open an hour
 * on, and the retired round caps an
 * older build queued, whose saved rows still read.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import { formatDurationShort } from "@shared/quotaSignals";
import { type HoldRefusal, type HoldWay, renderHold } from "./holds";
import {
  builtOnText,
  type ReviewVerdictFacts,
  renderReviewVerdict,
  type WakeBuiltOn,
} from "./reportWakes";
import type { WaitingMessage } from "./waitingWords";
import { waitingWords } from "./waitingWords";
import type { KindWords, TypedWake, WakeTask } from "./wakes";

/** The facts of the idle ladder's wakes. */
export type IdleFacts =
  | {
      /** The idle ladder's first rung, to the crewmate. */
      kind: "idle-nudge";
      /** The captain wrote last under one of its cards. */
      thread: boolean;
      /** The cards whose captain reply waits on the crewmate, when `thread` (INF-990 friction 4). */
      waiting?: WakeNote[];
      /** The newest note up on the task, when one is (FI3-438). */
      note?: WakeNote;
      /** The Firstmate declared the task an internal step (`shape.internal_step`, FI3-801). */
      step?: true;
      /** The task's deliverable is an answer the captain asked for (INF-1732). */
      answer?: true;
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
      /** The cards whose captain reply waits on the crewmate, when `thread` (INF-990 friction 4). */
      waiting?: WakeNote[];
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
       * to act (`needs_firstmate`), or declared its work finished with no
       * card of its own up (INF-1428), and it has not acted on the task since.
       */
      kind: "idle-asked";
      task: WakeTask;
      /** The live crewmate's name; absent when no runtime holds the task. */
      crewmate?: string;
      /** The task's key (or id), naming the crewmate when no runtime does. */
      key: string;
      /** What it asked the Firstmate to do, in its own words; absent when `finished`. */
      request?: string;
      /** It declared its work finished with no card of its own up: its close is asked. */
      finished?: boolean;
      /** How long ago it asked. */
      askedMs: number;
      /** 1 when the captain read its finished crewmate's card; 2 for the first reminder, 3 for the last: the report's own wake was the first. */
      wakes: number;
      /** The work built on the task, open or closed, when there is any (INF-976). */
      builtOn?: WakeBuiltOn[];
      /** The task's newest report, already capped for a wake. */
      last?: { kind: "report" | "failed"; excerpt: string };
    }
  | {
      /**
       * Work its crewmate declared finished is still open an hour on, with
       * no card of the task up and no reminder about it left to come
       * (INF-4072, finding 4): told once per finish.
       */
      kind: "finished-open";
      task: WakeTask;
      /** The task's key, or its id when it has none. */
      key: string;
      /** How long ago its crewmate declared it finished. */
      finishedMs: number;
      /** The messages still waiting for its crewmate, which hold the first mate's close. */
      waiting: WaitingMessage[];
    }
  | {
      /**
       * The host's news reached a started task in the backlog, where it waits
       * on its lane until a Start (INF-3143, direction A): told once per stay
       * there, so a parked blocker that changes is not missed.
       */
      kind: "backlog-news";
      task: WakeTask;
      /** How long it has waited in the backlog when the news reached it. */
      waitedMs: number;
      /** The news as its lane holds it, already capped for a wake. */
      news: string;
    }
  | {
      /**
       * A part of begun work with no next move (INF-3846 piece 2): it waits
       * for a start nobody gave, no card of it asks the captain anything,
       * and no stop from the captain is recorded on it. Told once per stay in that state;
       * if it still stands after the turn that read it, the captain gets
       * one card.
       */
      kind: "next-move";
      task: WakeTask;
      key: string;
      /** How it waits: open on request, or started and back in the backlog. */
      stands: "on-request" | "backlog";
      /** Why it counts as begun work, and the task that makes it so when another does. */
      begun: NextMoveBegun;
      /** How long it has stood that way. */
      standingMs: number;
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
      /** Missing on queued legacy wakes means captain. */
      owner?: "firstmate" | "captain";
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
    };

export const IDLE_NUDGE_TEXT =
  "You stopped with nothing running and nothing up for the captain to decide. Either finish - report under the five headings and emit your merge card - or say what blocks you.";

/**
 * What a declared internal step is told it is (FI3-801): its brief makes
 * its report the answer the next step builds on and takes no completion
 * card, so the nudge never asks it for one.
 */
const STEP_ANSWER_WORDS =
  "This task is a step whose answer the next step builds on: your report is that answer, and it takes no merge card - a card is only for something the captain must decide or see before the next step can start.";

/** How the nudge asks a declared internal step to finish: its answer, or what blocks it. */
const STEP_FINISH_WORDS =
  "report the whole answer, if your report does not carry it yet, or say what blocks you. If it already does, nothing is left for you: say so in one line, and the first mate decides the next step.";

/** The nudge to a task the Firstmate declared an internal step (`shape.internal_step`). */
export const IDLE_STEP_NUDGE_TEXT = `You stopped with nothing running and nothing up for the captain to decide. ${STEP_ANSWER_WORDS} Either ${STEP_FINISH_WORDS}`;

/**
 * A captain-asked answer task shows its outcome on a card marked answering.
 * Its saved answer waits for explicit Done, never the minimize corner.
 * Other acknowledged work reaches settlement through the typed `finished`
 * report flag, not the word "finished" in prose.
 */
const ANSWER_WORDS =
  "This task's deliverable is an answer, shown on your card marked answering; it takes no merge card.";

/** How the nudge asks an answer task to finish: the typed flag, never the words. */
const ANSWER_FINISH_WORDS =
  "when nothing is left for you, report with finished true - saying so in words does not close the task - or say what blocks you.";

/** The nudge to a task whose deliverable is an answer the captain asked for. */
export const IDLE_ANSWER_NUDGE_TEXT = `You stopped with nothing running and nothing up for the captain to decide. ${ANSWER_WORDS} Either post that card, or ${ANSWER_FINISH_WORDS}`;

/**
 * The nudge while a note is up on the task (FI3-438). A note does not hold
 * the turn, so the ladder still nudges, but it names the note: a crewmate
 * whose outcome it is says it waits, and is never asked to post it again.
 * A declared internal step is asked for its answer, never a completion card.
 */
export function idleNoteNudgeText(note: WakeNote, step = false, answer = false): string {
  const noted = `You stopped with nothing running, and the note "${note.title}" (${note.id}) is up, asking the captain nothing.`;
  const waits =
    "If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again.";
  if (step) return `${noted} ${STEP_ANSWER_WORDS} ${waits} Otherwise either ${STEP_FINISH_WORDS}`;
  if (answer) return `${noted} ${ANSWER_WORDS} ${waits} Otherwise, ${ANSWER_FINISH_WORDS}`;
  return `${noted} ${waits} Otherwise either finish - report under the five headings and emit your merge card - or say what blocks you.`;
}

/** The nudge when the captain wrote last under one of this crewmate's cards. */
export const IDLE_THREAD_NUDGE_TEXT =
  "The captain wrote under your card and you have not answered: answer in the thread with reply, or pass your answer as the reply of your emit_card revision, naming their message in answers_message.";

/**
 * The nudge naming the cards the captain wrote under (INF-990 friction 4):
 * a crewmate with another card, or one it already closed, answers the
 * card that waits rather than the one it last touched.
 */
export function idleThreadNudgeText(waiting?: readonly WakeNote[]): string {
  if (!waiting?.length) return IDLE_THREAD_NUDGE_TEXT;
  const one = waiting.length === 1;
  return `The captain wrote under your ${waitingCardWords(waiting)} and you have not answered: answer in ${one ? "that card's" : "each card's"} thread with reply, naming its card_id, or pass your answer as the reply of ${one ? "that card's" : "its"} emit_card revision under the same id, naming their message in answers_message.`;
}

type NamedTask = { id: string; key: string; title: string };

/**
 * Why a task counts as begun work (INF-3846 piece 2): it sits under a parent
 * where building work has started (`part`, naming the parent), started work
 * waits on it (`waited-on`, naming that work, and `via`, the parent above it
 * that work waits on when it is not the task itself), or it started itself
 * (`started`).
 */
export type NextMoveBegun =
  | { why: "part"; task: NamedTask }
  | { why: "waited-on"; task: NamedTask; via?: NamedTask }
  | { why: "started" };

/** The begun work a next-move wake names, in words. */
function begunWords(begun: NextMoveBegun): string {
  if (begun.why === "started") return "it started before";
  const named = `${begun.task.key} "${begun.task.title}"`;
  if (begun.why === "part") return `it is a part of ${named}, where work has started`;
  return begun.via
    ? `started work waits on ${begun.via.key} "${begun.via.title}", which it is a part of: ${named}`
    : `started work waits on it: ${named}`;
}

/** A note up on a task: a card with no actions, which holds no turn. */
export type WakeNote = { id: string; title: string };

/** The cards a reminder or refusal names: `card "Title" (id)`, joined. */
export function waitingCardWords(cards: readonly WakeNote[]): string {
  const named = cards.map((card) => `"${card.title}" (${card.id})`);
  return `card${cards.length === 1 ? "" : "s"} ${named.join(" and ")}`;
}

/**
 * The nudge as a typed wake: the ladder's rung 1, and the stall card's
 * Continue. The thread's nudge outranks the note's and the step's: the
 * captain spoke, and its words are the same for a step. A step's words
 * outrank an answer's: its answer goes to the next step, not to a card.
 */
export function idleNudge(
  thread = false,
  note?: WakeNote,
  step = false,
  waiting: readonly WakeNote[] = [],
  answer = false,
): TypedWake {
  return {
    facts: {
      kind: "idle-nudge",
      thread,
      ...(thread && waiting.length > 0 ? { waiting: [...waiting] } : {}),
      ...(note && !thread ? { note } : {}),
      ...(step && !thread ? { step: true as const } : {}),
      ...(answer && !step && !thread ? { answer: true as const } : {}),
    },
  };
}

const SECOND_WAKE =
  " This is the second time: if nothing is done about it in 30 minutes, the host puts it to the captain on a card of its own.";

/** Typed legacy count notices remain readable, but no longer ask the agents to enforce a hold. */
function retiredCountHold(task: WakeTask): string {
  return `[fm-op] An earlier version recorded a count hold on task ${task.id} "${task.title}". Repair, re-review and rerun count holds are retired. This record places no hold and grants no authorization. Read current facts and judge the next action from your delivery guidance.`;
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

/** The idle ladder's wakes, worded. */
/** The name the finished-open wake goes out once for: the finish, by when it was declared. */
export function finishedOpenOnce(finishedAt: number): string {
  return `finished-open:${finishedAt}`;
}

/** The one wake when finished work is still open an hour on (INF-4072, finding 4). */
export function finishedOpenWake(
  task: WakeTask & { key: string },
  finishedAt: number,
  waiting: WaitingMessage[],
  now: number,
): TypedWake {
  return {
    facts: {
      kind: "finished-open",
      task: { id: task.id, title: task.title },
      key: task.key,
      finishedMs: now - finishedAt,
      waiting,
    },
    once: finishedOpenOnce(finishedAt),
  };
}

export const IDLE_WORDS: KindWords<IdleFacts> = {
  "idle-nudge": (facts) => {
    if (facts.thread) return idleThreadNudgeText(facts.waiting);
    if (facts.note) return idleNoteNudgeText(facts.note, facts.step === true, facts.answer);
    if (facts.step) return IDLE_STEP_NUDGE_TEXT;
    return facts.answer ? IDLE_ANSWER_NUDGE_TEXT : IDLE_NUDGE_TEXT;
  },
  "idle-stall": (facts, wake) => {
    const state = facts.thread
      ? `since the captain wrote under ${facts.waiting?.length ? waitingCardWords(facts.waiting) : "its card"}, without answering them, and nothing queued will`
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
  },
  "idle-asked": (facts) => {
    const crewmate = facts.crewmate ?? `the crewmate on ${facts.key}`;
    const last = facts.last?.kind === "report" ? ` Its report: ${facts.last.excerpt}` : "";
    const reminder =
      facts.wakes >= 3
        ? " This is the last reminder: nothing more is sent about it, and its crew line says it is stalled."
        : " If nothing is done about it in 30 minutes, you are reminded once more.";
    const since =
      "You have not acted on that task since: no steer, card or change to it, and no task built on it or under it was created or started.";
    if (facts.finished)
      return `[fm-op] ${crewmate} on task ${facts.task.id} "${facts.task.title}" declared its work finished ${formatDurationShort(facts.askedMs)} ago with no card of its own up, so nothing is left for it and it is not nudged. ${since}${builtOnText(facts.builtOn)}${reminder} Close the task if the record bears that out, or steer the crewmate with what is still missing.${last}`;
    return `[fm-op] ${crewmate} on task ${facts.task.id} "${facts.task.title}" asked you ${formatDurationShort(facts.askedMs)} ago to act: ${facts.request ?? ""}. ${since}${builtOnText(facts.builtOn)}${reminder} The ask authorizes nothing by itself; the captain's own words do. Act on it, or steer the crewmate to tell it why not.${last}`;
  },
  "finished-open": (facts) => {
    const waiting =
      facts.waiting.length > 0
        ? ` A message still waits for its crewmate, which holds your close. ${waitingWords(facts.waiting)}`
        : "";
    return `[fm-op] task ${facts.key} "${facts.task.title}" declared its work finished ${formatDurationShort(facts.finishedMs)} ago and is still open, with nothing up for the captain to decide and no reminder about it left to come. Close it with settle_task done if the record bears that out, or steer its crewmate with what is still missing. You are told this once.${waiting}`;
  },
  "backlog-news": (facts) =>
    `[fm-op] task ${facts.task.id} "${facts.task.title}" has waited in the backlog for ${formatDurationShort(facts.waitedMs)}, and news from the app reached it there; its crewmate hears it only once it starts again. If the news means it can move, start it with update_task start_now; otherwise leave it parked. You are told this once per stay in the backlog. The news: ${facts.news}`,
  "next-move": (facts) => {
    const open = facts.stands === "on-request";
    const stands = open
      ? `has waited on request for ${formatDurationShort(facts.standingMs)} for a start nobody has given`
      : `went back to the backlog ${formatDurationShort(facts.standingMs)} ago and waits there for a start`;
    const start = open
      ? "start it with update_task start_now, or start_policy when-ready to start once nothing holds it"
      : "start it with update_task start_now";
    return `[fm-op] task ${facts.key} "${facts.task.title}" is begun work (${begunWords(facts.begun)}), and nothing will move it: it ${stands}, no card of it asks the captain anything, and no stop from the captain is recorded on it. Begun work is always moving, waiting on the captain with a card up, or stopped by the captain. First read its history with tasks: if the captain asked for it to wait, record that with update_task captain_stop true and leave it. Otherwise give it a next move: ${start}; put what holds it to the captain on a card naming it in task_id or related; or drop it with update_task drop and a reason if it is no longer needed. You are told this once: if it still stands after this turn, the app shows the captain one card about it.`;
  },
  "idle-owed": (facts, wake) => {
    if (facts.held !== "captain-gate") return retiredCountHold(facts.task);
    return renderHold(
      hold(
        facts.held,
        facts.task,
        wake.ways,
        `[fm-op] task ${facts.task.id} "${facts.task.title}" is held for the captain${facts.reason ? ` (its crewmate waits on them to ${facts.reason})` : ""} and has had no card up for ${formatDurationShort(facts.idleMs)}: its crewmate cannot move until the captain answers one.${repeat(facts.wakes)}`,
      ),
    );
  },
  "ci-cap": (facts) => retiredCountHold(facts.task),
  "review-cap": (facts) => {
    const rode = facts.findings ? renderReviewVerdict(facts.findings, false) : facts.report;
    return rode ? `${retiredCountHold(facts.task)} ${rode}` : retiredCountHold(facts.task);
  },
};
