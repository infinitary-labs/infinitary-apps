import { type CardNote, pointedAtLines } from "@shared/cardNotes";

/**
 * The captain's own moves as a lane hears them: a card's choice, close or
 * thread reply, a line in the Crewmate tab, a returned browser, a project
 * setup or change, a closed answer task, a stale validation question, and
 * the retry when the captain's message moved nothing.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import { attachmentWords } from "@shared/attachments";
import { cardAnswerLines, REPLY_SETTINGS_HEAD } from "@shared/cardAnswerLines";
import { DECLINE_ACTION_ID, NOTE_GOT_IT_LABEL } from "@shared/cardLeave";
import type { CardAnswer, CardEffect, ChoiceCarriedRecord } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import type { ProjectSetupOutcome } from "@shared/projectSetup";
import { SAVED_SIGN_IN_FAILED_WORDS, UNKNOWN_OUTCOME_WORDS } from "@shared/taskBrowser";
import type { Through } from "@shared/through";
import { browserCommand } from "../browser/commandWords";
import { FROM_THE_COMMAND } from "../integrations/commandWords";
import {
  ABANDON,
  APPROVE_AND_BUILD,
  ORDINARY_NOTE_READ_GUIDANCE,
  SAVE_AND_DEFER,
  START_THE_NEXT_STEP,
} from "../prompts/cardContract";
import { CARRIED_OUT_WORDS, CARRIED_WITH_CHOICE_LEAD } from "../prompts/choiceCarried";
import { pageUnansweredWords } from "../prompts/pageUnanswered";
import type { KindWords, TypedWake, WakeFacts, WakeLane } from "./wakes";

export type CaptainFacts =
  | { kind: "validation-question-stale"; card: string; reason: string }
  | {
      /**
       * The captain pressed a card button the app could not carry out
       * (INF-4072 finding 1): the first mate hears it at once with the
       * reason, rather than a feed line nobody acts on. `undone` names the
       * part of the click the app could not do.
       */
      kind: "card-action-undone";
      card: { id: string; title: string };
      task: { id: string; key: string; title: string };
      label: string;
      undone: CardActionUndone;
      reason: string;
    }
  | {
      /** The captain's choice closed an answer task; the payload is the wake. */
      kind: "answer-closed";
      handoff: AnswerTaskClosedPayload;
      /**
       * What else the captain's closing choice carried (`choice-attachments.md`):
       * its notes and files in words, and its pictures, which ride the turn.
       */
      carried?: ChoiceCarriedRecord;
    }
  | {
      /** The captain chose on a card with no effect: the choice returns to its author. */
      kind: "card-choice";
      to: WakeLane;
      card: { title: string; id?: string; taskId?: string };
      source?: "chrome" | "frame";
      choice: WakeChoice;
      /**
       * The computer or phone whose window the captain chose from, in the
       * crewmate's words (docs/devices.md, "Where the captain is"); absent
       * with one computer, from a script, and on older rows.
       */
      from?: string;
      /**
       * The choice was a request card's open-browser action, and the browser
       * the card named was gone (docs/task-browser.md, "Asking for help"): it
       * had stopped, or it ended when the app quit.
       */
      browserGone?: "stopped" | "quit";
      /** The choice came from the captain's own command, `infinitary-axi` (INF-3898 piece 2). */
      through?: Through;
      /**
       * The app already carried out the choice - a merge, a discard, an app
       * card's own button - and its author hears nothing of what the card's
       * field sent with it, so the first mate is told once, with it
       * (`choice-attachments.md`).
       */
      carriedOut?: true;
    }
  | {
      /**
       * The captain's Got it on an ordinary note, or a legacy/duplicate card
       * closure without choosing. The host marks Got it as `read`; only that
       * fact carries acknowledgement.
       */
      kind: "card-closed";
      card: { id: string; title: string };
      /** The captain pressed Got it on an ordinary note, rather than putting a card aside. */
      read?: true;
      /** The earlier card it repeats, when the captain closed it as a duplicate (INF-759). */
      duplicateOf?: { id: string; title: string };
    }
  | {
      /**
       * The captain answered the app's setup card for a project the
       * Firstmate proposed (docs/fleet.md, "Asking the first mate to add a
       * project"): added with the settings he chose there, already on the
       * list, explicit Not now, or setup failure. Told once; putting the
       * card aside produces no setup outcome.
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
      /**
       * The card, and the captain message and lifecycle this reply is
       * (docs/card-threads.md, "Shared cards"); older rows name neither.
       */
      card: { id: string; title: string; messageId?: number; lifecycle?: string };
      /** The captain's words, verbatim. */
      words: string;
      answers?: CardAnswer[];
      notes?: CardNote[];
      /** The computer or phone whose window they wrote from, as `card-choice` names it. */
      from?: string;
      /**
       * The captain holds the browser this request card asked about and
       * wrote from beside its page (docs/task-browser.md, "Asking for help").
       */
      browserHeld?: true;
    }
  | {
      /**
       * A line the captain typed in the task card's Crewmate tab
       * (docs/task-card-tabs.md, "Typing"): the crewmate's steer.
       */
      kind: "crewmate-tab-line";
      /** The words rendered to the crewmate, preserving the existing delivery behavior. */
      words: string;
      /** Original input before delivery normalization; unknown on older rows. */
      captainText?: string;
      /** The notes on the task's running page that left with the line (docs/task-browser.md, "Pointing at a page"). */
      notes?: CardNote[];
    }
  | {
      /**
       * The captain opened a card's page in the task's browser and nothing
       * answers at its loopback address (docs/task-browser.md, "When
       * nothing answers"): its crewmate's one steer for that outage.
       */
      kind: "page-unanswered";
      /** The page's host and port. */
      site: string;
      /** The page's address, bare of its query and fragment. */
      url: string;
      /** The saved start the host ran first and how it failed (docs/task-browser.md, "Starting a page again"). */
      start?: { command: string; exit?: number | null; ranOut?: true; log: string };
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
       * than signing in (docs/task-browser.md, "Signed-in sites").
       */
      saved?: true;
      /**
       * What the captain left in the reply field of the request docked
       * beside the page as he returned control, verbatim
       * (docs/task-browser.md, "Asking for help").
       */
      words?: string;
    }
  | {
      /**
       * The answer-delivery check's one retry: the captain's message was read
       * and nothing took effect after it. Served alone, and the turn may only
       * show an answer (`ANSWER_ONLY_REFUSED_TOOLS`).
       */
      kind: "answer-missing";
      askId: string;
      excerpt: string;
      filedOn?: { id: string; title: string };
      /** The Firstmate card the message was a reply under, when it was. */
      aboutCard?: { id: string; title: string; messageId?: number };
      /** Why the card was refused, when a refusal is typed. */
      refusal?: "crewmate-owns" | "card-refused";
      /** The card that owns the work, when a refused card named it. */
      ownedBy?: string;
      /** The work a crewmate ran for the message, all ended with no card answering it. */
      workEnded?: { id: string; title: string }[];
    };

/** What the app's Decline means to the card's author (INF-3108). */
export const DECLINE_WORDS =
  "The captain declined every choice on the card: go on without them, and ask again only with something new.";

/** How the steer telling a crewmate the captain closed its card begins (FI3-435). */
export const CARD_CLOSED_STEER_PREFIX = "The captain closed your card ";

/** How the steer telling a crewmate the captain pressed Got it on its note begins (INF-2794). */
export const NOTE_GOT_IT_STEER_PREFIX = `The captain pressed ${NOTE_GOT_IT_LABEL} on your note `;

/** Whether a crewmate's served guidance is that steer: the replay finds it no recorded answer. */
export function isCardClosedSteer(text: string): boolean {
  return text.startsWith(CARD_CLOSED_STEER_PREFIX) || text.startsWith(NOTE_GOT_IT_STEER_PREFIX);
}

/**
 * The relay of standing words (INF-1216): the crewmate judges whether the
 * captain's words pass a hold or stand in for asking them, and if so
 * relays them, naming where they came, so the first mate records them as
 * the override in the turn that report starts. Nothing in the host reads
 * the words.
 */
function standingWordsRelay(where: string): string {
  return `When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming ${where}, so the first mate records them as their standing override; carry on with what their words already allow.`;
}

/**
 * The fixed host preamble every captain thread reply carries (cards-as-
 * threads phase 1, R4). It is the process direction the Firstmate used to
 * relay by hand on 27 of 40 turns, said once by the host instead: where to
 * answer, how to change the card, and what is not the crewmate's to do.
 *
 * Since contract v4.14 it also says WHEN (the captain's "ship it" of
 * 2026-09-27, docs/card-threads.md "When a card reaches the stage"): the
 * card comes back at the crewmate's close-out - its turn end since INF-926,
 * never a report while it works on - so the crewmate does the work first,
 * answers once, then reports - and never acknowledges, the shape that
 * brought 4 of 25 answered cards back before their answer.
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
  "Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report.",
  "Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer.",
  "When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer.",
  "On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed.",
  "Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it.",
  standingWordsRelay("this card's id"),
].join(" ");

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

/**
 * The captain's choice on a card: the action's id and label, a frame's value
 * as JSON, and the answers to the body's own questions a footer click
 * carried (inline decisions, contract 4.22).
 */
export type WakeChoice = {
  id: string;
  label: string;
  value?: string;
  answers?: CardAnswer[];
  /**
   * What else the card's field sent with the choice (`choice-attachments.md`):
   * its notes and files, and on a first mate's choice its pictures, which ride
   * the turn. A crewmate's pictures ride its steer instead.
   */
  carried?: ChoiceCarriedRecord;
};

/**
 * What the card's field sent with a choice besides its words, as its reader
 * reads it: the files as a reply carries them, each note with where it
 * points, and the pictures by name. Served to a model, so English.
 */
export function carriedText(carried: ChoiceCarriedRecord | undefined): string {
  const lines = carriedLines(carried);
  return lines.length ? `\n${CARRIED_WITH_CHOICE_LEAD}\n${lines.join("\n")}` : "";
}

/** `carriedText`'s lines without their lead, as a builder's brief lists them. */
export function carriedLines(carried: ChoiceCarriedRecord | undefined): string[] {
  if (!carried) return [];
  return [
    ...(carried.files ? [carried.files] : []),
    ...pointedAtLines(carried.notes ?? []),
    ...(carried.pictures?.length ? [`[attached: ${attachmentWords(carried.pictures)}]`] : []),
  ];
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
  return `${renderBrowserReturnedLead(facts, after)}${facts.words ? `\n${BROWSER_RETURNED_WORDS_LEAD}\n${facts.words}` : ""}`;
}

export const BROWSER_RETURNED_WORDS_LEAD =
  "As they returned control, the captain left you these words in your request card's reply field. Do what they need first, and answer them in your next card or report. Their words, verbatim:";

function renderBrowserReturnedLead(
  facts: Extract<WakeFacts, { kind: "browser-returned" }>,
  after: string,
): string {
  if (facts.saved) {
    return `The captain let this task use the sign-in kept on ${HERE.this} for ${facts.site}, and your browser is yours again: its page opened with that sign-in. Your earlier refs are gone: run ${browserCommand()} for a fresh look at the page as it is now, and check that it is signed in before you carry on.${after} ${SAVED_SIGN_IN_FAILED_WORDS} A kept sign-in gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.`;
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

function renderProjectSetup(facts: Extract<WakeFacts, { kind: "project-setup" }>): string {
  const work = facts.work ? ` The card said you start this once it is added: ${facts.work}` : "";
  switch (facts.outcome) {
    case "added":
      return `[fm-op] the captain added ${facts.name} (repo_id ${facts.repoId ?? "unknown"}) on its setup card${facts.settings ? `: ${facts.settings}` : ""}.${facts.reason ? ` ${facts.reason}` : ""}${work ? `${work}. Start it now.` : ""}`;
    case "already":
      return `[fm-op] ${facts.name} (repo_id ${facts.repoId ?? "unknown"}) was already on the captain's list when they clicked Add project on its setup card, so nothing changed.${work ? `${work}. Start it now.` : ""}`;
    case "not-now":
      return `[fm-op] the captain did not add ${facts.name}: they chose Not now on its setup card, or closed it. Nothing was added, so do not start work that needs it; ask again only if they do.`;
    case "failed":
      return `[fm-op] the captain clicked Add project on the setup card for ${facts.name}, and ${SETUP_CARD_FAILED_WORDS}: ${facts.reason ?? "no reason was given"}. Nothing was added.`;
  }
}

function renderBrowserGone(facts: Extract<WakeFacts, { kind: "card-choice" }>): string {
  const ended = facts.browserGone === "quit" ? "stopped when Infinitary quit" : "had stopped";
  return `${BROWSER_GONE_OPENING} "${facts.card.title}", but the browser that card named ${ended}, so the captain got no page and nothing the card asked for was done there. Nothing from that browser was kept, and any browser you have now is a newer one. If you still need the captain on the page, open the site again with ${browserCommand("open <url>")} and ask again on a new card with browser_handoff. If the card was about something whose outcome is unknown, such as a payment the site never confirmed, it still is: never submit, reload or resend it, and check where the site lists it, such as its bookings, before you ask. ${UNKNOWN_OUTCOME_WORDS}${answersText(facts.choice, facts.source)}`;
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
 * What a thread reply's steer adds while the captain holds the browser the
 * request card asked about (docs/task-browser.md, "Asking for help").
 */
export const THREAD_BROWSER_HELD =
  "The captain has control of your browser and wrote this from beside its page, where your card stays docked. You cannot see the page or use the browser until they return control: answer from what you know, and revise the card under the same id when the steps or values on it should change.";

export function threadReplyLead(facts: Extract<WakeFacts, { kind: "thread-reply" }>): string {
  return [
    THREAD_STEER_PREAMBLE,
    ...(facts.browserHeld ? [THREAD_BROWSER_HELD] : []),
    `Card "${facts.card.title}" (${facts.card.id}).${facts.card.messageId !== undefined ? ` This is the captain's message ${facts.card.messageId}${facts.card.lifecycle ? ` in lifecycle ${facts.card.lifecycle}` : ""}; a line on this card answers it only when it names it in answers_message.` : ""}${fromText(facts.from, "wrote it")}`,
    "The captain's words, verbatim:",
  ].join("\n");
}

/**
 * What the captain sent from the Crewmate tab's box, as the crewmate reads it: his words, then
 * the notes on the task's running page that left with them. Notes need no words beside them.
 */
export function crewmateTabLine(facts: { words: string; notes?: CardNote[] }): string {
  return [...(facts.words ? [facts.words] : []), ...pointedAtLines(facts.notes ?? [])].join("\n");
}

export const CREWMATE_TAB_STEER_LEAD = [
  "The captain typed this to you in your task's Crewmate tab, where they read your session as you work.",
  "Treat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.",
  "Putting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.",
  standingWordsRelay("the Crewmate tab"),
  "The captain's words, verbatim:",
].join("\n");

/** How the answer-delivery retry's wake opens; a scripted stand-in recognizes the retry by it. */
export const ANSWER_MISSING_OPENING = "Nothing took effect after the captain's message";

function renderAnswerMissing(facts: Extract<WakeFacts, { kind: "answer-missing" }>): string {
  const about = facts.aboutCard
    ? ` It was ${facts.aboutCard.messageId !== undefined ? `the captain's message ${facts.aboutCard.messageId}, ` : ""}a reply under your card "${facts.aboutCard.title}" (${facts.aboutCard.id}).`
    : facts.filedOn
      ? ` It was filed on task ${facts.filedOn.id} "${facts.filedOn.title}".`
      : "";
  const refused = facts.refusal
    ? facts.refusal === "crewmate-owns"
      ? ` Your card was refused because ${facts.ownedBy ? `the crewmate's card ${facts.ownedBy}` : "the crewmate's card"} is already on screen for that work: write on it with emit_card and its id.`
      : " Your card was refused."
    : "";
  if (facts.workEnded?.length) {
    const work = facts.workEnded.map((task) => `${task.id} "${task.title}"`).join(", ");
    return `[fm-op] ${ANSWER_MISSING_ENDED_OPENING}: ${work}, so they have no answer yet. Their words, verbatim: "${facts.excerpt}".${about} Show them the answer the work found now with emit_card and answering true, from its record. If another task took the work over, link it as the replacement with link_tasks instead. Starting, steering, stopping or closing work and changing settings are refused this turn.`;
  }
  // Under a card, its thread is the one place for the answer (INF-5202):
  // a wake naming two places had the first mate answer in both. A refused
  // card already names where its answer goes.
  const answer =
    facts.aboutCard && !facts.refusal
      ? ` Answer it once, in that card's thread: emit_card with id ${facts.aboutCard.id}, reply and answers_message ${facts.aboutCard.messageId ?? "naming their message"}. Change the card itself only when the answer changes what it says. A reaction may stand in only when the message asks for nothing.`
      : " Show them the answer now with emit_card and answering true, or answer in the card's thread; a reaction may stand in only when the message asks for nothing.";
  return `[fm-op] ${ANSWER_MISSING_OPENING}, so they have no answer yet. Their words, verbatim: "${facts.excerpt}".${about}${refused}${answer} Starting, steering, stopping or closing work and changing settings are refused this turn.`;
}

export const ANSWER_MISSING_ENDED_OPENING =
  "The work for the captain's message ended with no card that answers it";

/**
 * Where the captain's choice or reply came from (docs/devices.md, "Where
 * the captain is"): the computer or phone whose window they used, which is
 * where they are, whatever the card's words said.
 */
function fromText(from: string | undefined, did: string): string {
  return from ? ` The captain ${did} in their window on ${from}.` : "";
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

/**
 * The part of a card button's click the app could not carry out: the rigor
 * the button sets, or the review it starts once that rigor is recorded.
 */
export type CardActionUndone = "set-rigor" | "start-review";

const CARD_ACTION_UNDONE_WORDS: Record<CardActionUndone, string> = {
  "set-rigor": "record the rigor the button sets, so the task's rigor and review are unchanged",
  "start-review":
    "start the review the button asks for; the task's new rigor is recorded, and no review of it is open",
};

export const CAPTAIN_WORDS: KindWords<CaptainFacts> = {
  "card-action-undone": (facts) =>
    `[fm-op] The captain pressed "${facts.label}" on card "${facts.card.title}" (${facts.card.id}) for task ${facts.task.key} "${facts.task.title}", and the app could not ${CARD_ACTION_UNDONE_WORDS[facts.undone]}. The reason: ${facts.reason.trim()} Carry out what the captain's click asked for with your own tools, or tell the captain on a card what stops it.`,
  "validation-question-stale": (facts) =>
    `The captain tried to answer validation question ${facts.card}, but nothing was approved: ${facts.reason} Its unusable actions were removed. Record a fresh request with a new identity and revise that same card for the current facts; do not repeat an unknown effect.`,
  "answer-closed": (facts) =>
    `[fm-op] ${JSON.stringify({
      ...facts.handoff,
      read: {
        tool: "tasks",
        arguments: { key: facts.handoff.task.key || facts.handoff.task.id },
      },
      next: `This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: ${APPROVE_AND_BUILD}, ${START_THE_NEXT_STEP} and ${SAVE_AND_DEFER} are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, ${ABANDON}) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates.`,
    })}${carriedText(facts.carried)}`,
  "card-choice": (facts) => {
    // The app's Decline (INF-3108) is the captain's no to every choice.
    const declined = facts.choice.id === DECLINE_ACTION_ID ? ` ${DECLINE_WORDS}` : "";
    if (facts.to === "firstmate") {
      const about = `card "${facts.card.title}"${facts.card.id ? ` (${facts.card.id})` : ""}${facts.card.taskId ? ` on task ${facts.card.taskId}` : ""}`;
      return facts.source === "frame"
        ? `[fm-op] a script chose "${facts.choice.label}" (${facts.choice.id}) on ${about}.${valueText(facts.choice)}${answersText(facts.choice, facts.source)}`
        : `[user]\n${facts.choice.label}\nChoice on ${about}${facts.through ? `, ${FROM_THE_COMMAND}` : ""}.${declined}${facts.carriedOut ? ` ${CARRIED_OUT_WORDS}` : ""}${valueText(facts.choice)}${answersText(facts.choice)}${carriedText(facts.choice.carried)}`;
    }
    if (facts.browserGone) return renderBrowserGone(facts);
    return `Card "${facts.card.title}": ${facts.source === "frame" ? "a script" : "the user"} chose "${facts.choice.label}" (${facts.choice.id}).${fromText(facts.from, "chose it")}${declined}${valueText(facts.choice)}${answersText(facts.choice, facts.source)}${carriedText(facts.choice.carried)}`;
  },
  "card-closed": (facts) =>
    facts.duplicateOf
      ? `${CARD_CLOSED_STEER_PREFIX}"${facts.card.title}" (${facts.card.id}) as a duplicate of "${facts.duplicateOf.title}" (${facts.duplicateOf.id}), without choosing.`
      : facts.read
        ? `${NOTE_GOT_IT_STEER_PREFIX}"${facts.card.title}" (${facts.card.id}). ${ORDINARY_NOTE_READ_GUIDANCE}`
        : `${CARD_CLOSED_STEER_PREFIX}"${facts.card.title}" (${facts.card.id}) without choosing.`,
  "project-change": (facts) =>
    `The captain answered the app’s project change card “${facts.title}”: ${facts.outcome}.${facts.reason ? ` ${facts.reason}` : ""} Read the current project values before starting work. This is an outcome, not permission for another change.`,
  "project-setup": (facts) => renderProjectSetup(facts),
  "crewmate-tab-line": (facts) => [CREWMATE_TAB_STEER_LEAD, crewmateTabLine(facts)].join("\n"),
  "thread-reply": (facts) =>
    [
      threadReplyLead(facts),
      facts.words,
      ...pointedAtLines(facts.notes ?? []),
      ...(facts.answers?.length ? [REPLY_SETTINGS_HEAD, ...cardAnswerLines(facts.answers)] : []),
    ].join("\n"),
  "browser-returned": (facts) => renderBrowserReturned(facts),
  "page-unanswered": (facts) => pageUnansweredWords(facts),
  "answer-missing": (facts) => renderAnswerMissing(facts),
};
