/**
 * The words of the first mate's wakes that `captainWakes.ts` words, byte for
 * byte (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says
 * why): the captain's own moves: a stale validation question, a closed answer
 * task, a project setup or change, and the retry when the captain's message
 * moved nothing.
 */
import {
  type FirstmateCaptainWakeKind,
  pinWakeWords,
  WAKE_REVIEW as REVIEW,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FirstmateCaptainWakeKind> = {
  "validation-question-stale": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "validation-question-stale",
          card: "card-validate-1",
          reason: "The version it asked about is no longer the pull request's head.",
        },
      },
      words:
        "The captain tried to answer validation question card-validate-1, but nothing was approved: The version it asked about is no longer the pull request's head. Its unusable actions were removed. Record a fresh request with a new identity and revise that same card for the current facts; do not repeat an unknown effect.",
    },
  ],
  "answer-closed": [
    {
      name: "its receipt",
      wake: {
        facts: {
          kind: "answer-closed",
          handoff: {
            version: 1,
            event: "answer_task_closed",
            task: { id: "bc46286c", key: "INF-2625", title: "Verify the large-file audit" },
            card: { id: "card-bc46286c-large-files-plan", title: "Restructure 39 files" },
            choice: { id: "approve", label: "Approve and build", effect: null },
            close: { status: "done", reason: "answered", actor: "captain" },
          },
        },
      },
      words:
        '[fm-op] {"version":1,"event":"answer_task_closed","task":{"id":"bc46286c","key":"INF-2625","title":"Verify the large-file audit"},"card":{"id":"card-bc46286c-large-files-plan","title":"Restructure 39 files"},"choice":{"id":"approve","label":"Approve and build","effect":null},"close":{"status":"done","reason":"answered","actor":"captain"},"read":{"tool":"tasks","arguments":{"key":"INF-2625"}},"next":"This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: Approve and build, Start the next step and Save and defer are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, Abandon) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates."}',
    },
    {
      name: "with no key",
      wake: {
        facts: {
          kind: "answer-closed",
          handoff: {
            version: 1,
            event: "answer_task_closed",
            task: { id: "bc46286c", key: "", title: "Verify the large-file audit" },
            card: { id: "card-plan", title: "Restructure 39 files" },
            choice: { id: "abandon", label: "Abandon", effect: null },
            close: { status: "done", reason: "answered", actor: "captain" },
          },
        },
      },
      words:
        '[fm-op] {"version":1,"event":"answer_task_closed","task":{"id":"bc46286c","key":"","title":"Verify the large-file audit"},"card":{"id":"card-plan","title":"Restructure 39 files"},"choice":{"id":"abandon","label":"Abandon","effect":null},"close":{"status":"done","reason":"answered","actor":"captain"},"read":{"tool":"tasks","arguments":{"key":"bc46286c"}},"next":"This receipt is not the plan. For any choice that files, starts or saves work, use read to recover the full report, closing offer and submitted answers before acting. Judge the choice by meaning, not its label: Approve and build, Start the next step and Save and defer are examples, not an allowlist. Routine acknowledgements and choices that abandon work (for example, Abandon) need no read. Follow HANDOFF: reuse an existing successor for authorized work, save deferred work unstarted, and keep design-only and later gates."}',
    },
  ],
  "project-setup": [
    {
      name: "added with settings, a note and work",
      wake: {
        facts: {
          kind: "project-setup",
          outcome: "added",
          name: "infinitary",
          repoId: "b3483155",
          settings: "delivery direct-pr, care standard",
          work: "the large-file audit",
          reason: "Its care could not be saved.",
        },
      },
      words:
        "[fm-op] the captain added infinitary (repo_id b3483155) on its setup card: delivery direct-pr, care standard. Its care could not be saved. The card said you start this once it is added: the large-file audit. Start it now.",
    },
    {
      name: "added bare",
      wake: { facts: { kind: "project-setup", outcome: "added", name: "infinitary" } },
      words: "[fm-op] the captain added infinitary (repo_id unknown) on its setup card.",
    },
    {
      name: "already there, with work",
      wake: {
        facts: {
          kind: "project-setup",
          outcome: "already",
          name: "infinitary",
          repoId: "b3483155",
          work: "the large-file audit",
        },
      },
      words:
        "[fm-op] infinitary (repo_id b3483155) was already on the captain's list when they clicked Add project on its setup card, so nothing changed. The card said you start this once it is added: the large-file audit. Start it now.",
    },
    {
      name: "already there, bare",
      wake: { facts: { kind: "project-setup", outcome: "already", name: "infinitary" } },
      words:
        "[fm-op] infinitary (repo_id unknown) was already on the captain's list when they clicked Add project on its setup card, so nothing changed.",
    },
    {
      name: "not now",
      wake: { facts: { kind: "project-setup", outcome: "not-now", name: "infinitary" } },
      words:
        "[fm-op] the captain did not add infinitary: they chose Not now on its setup card, or closed it. Nothing was added, so do not start work that needs it; ask again only if they do.",
    },
    {
      name: "failed with a reason",
      wake: {
        facts: {
          kind: "project-setup",
          outcome: "failed",
          name: "infinitary",
          reason: "the clone was refused",
        },
      },
      words:
        "[fm-op] the captain clicked Add project on the setup card for infinitary, and it could not be added: the clone was refused. Nothing was added.",
    },
    {
      name: "failed with none",
      wake: { facts: { kind: "project-setup", outcome: "failed", name: "infinitary" } },
      words:
        "[fm-op] the captain clicked Add project on the setup card for infinitary, and it could not be added: no reason was given. Nothing was added.",
    },
  ],
  "project-change": [
    {
      name: "applied with a reason",
      wake: {
        facts: {
          kind: "project-change",
          outcome: "applied",
          title: "Run infinitary on Builder",
          reason: "Builder now runs its tasks.",
        },
      },
      words:
        "The captain answered the app’s project change card “Run infinitary on Builder”: applied. Builder now runs its tasks. Read the current project values before starting work. This is an outcome, not permission for another change.",
    },
    {
      name: "not now",
      wake: {
        facts: { kind: "project-change", outcome: "not-now", title: "Run infinitary on Builder" },
      },
      words:
        "The captain answered the app’s project change card “Run infinitary on Builder”: not-now. Read the current project values before starting work. This is an outcome, not permission for another change.",
    },
  ],
  "answer-missing": [
    {
      name: "a reply under a card the crewmate owns",
      wake: {
        facts: {
          kind: "answer-missing",
          askId: "ask-9",
          excerpt: "Is the wakes split done?",
          aboutCard: { id: "card-f", title: "Restructure status" },
          refusal: "crewmate-owns",
          ownedBy: "card-a",
        },
      },
      words:
        '[fm-op] Nothing took effect after the captain\'s message, so they have no answer yet. Their words, verbatim: "Is the wakes split done?". It was a reply under your card "Restructure status" (card-f). Your card was refused because the crewmate\'s card card-a is already on screen for that work: write on it with emit_card and its id. Show them the answer now with emit_card and answering true, or answer in the card\'s thread; a reaction may stand in only when the message asks for nothing. Starting, steering, stopping or closing work and changing settings are refused this turn.',
    },
    {
      name: "a reply under the first mate's own card names its thread alone (INF-5202)",
      wake: {
        facts: {
          kind: "answer-missing",
          askId: "ask-11",
          excerpt: "Is that cosmetic or legal?",
          aboutCard: { id: "card-fm-11", title: "Google sign-in ownership", messageId: 5897 },
        },
      },
      words:
        '[fm-op] Nothing took effect after the captain\'s message, so they have no answer yet. Their words, verbatim: "Is that cosmetic or legal?". It was the captain\'s message 5897, a reply under your card "Google sign-in ownership" (card-fm-11). Answer it once, in that card\'s thread: emit_card with id card-fm-11, reply and answers_message 5897. Change the card itself only when the answer changes what it says. A reaction may stand in only when the message asks for nothing. Starting, steering, stopping or closing work and changing settings are refused this turn.',
    },
    {
      name: "filed on a task, owner unnamed",
      wake: {
        facts: {
          kind: "answer-missing",
          askId: "ask-10",
          excerpt: "Is the wakes split done?",
          filedOn: TASK,
          refusal: "crewmate-owns",
        },
      },
      words:
        '[fm-op] Nothing took effect after the captain\'s message, so they have no answer yet. Their words, verbatim: "Is the wakes split done?". It was filed on task 479823ee "Restructure the wakes file". Your card was refused because the crewmate\'s card is already on screen for that work: write on it with emit_card and its id. Show them the answer now with emit_card and answering true, or answer in the card\'s thread; a reaction may stand in only when the message asks for nothing. Starting, steering, stopping or closing work and changing settings are refused this turn.',
    },
    {
      name: "a refused card",
      wake: {
        facts: {
          kind: "answer-missing",
          askId: "ask-11",
          excerpt: "Is the wakes split done?",
          refusal: "card-refused",
        },
      },
      words:
        "[fm-op] Nothing took effect after the captain's message, so they have no answer yet. Their words, verbatim: \"Is the wakes split done?\". Your card was refused. Show them the answer now with emit_card and answering true, or answer in the card's thread; a reaction may stand in only when the message asks for nothing. Starting, steering, stopping or closing work and changing settings are refused this turn.",
    },
    {
      name: "work that ended unanswered",
      wake: {
        facts: {
          kind: "answer-missing",
          askId: "ask-12",
          excerpt: "Is the wakes split done?",
          filedOn: TASK,
          workEnded: [TASK, REVIEW],
        },
      },
      words:
        '[fm-op] The work for the captain\'s message ended with no card that answers it: 479823ee "Restructure the wakes file", b9299a73 "Review: Restructure the wakes file", so they have no answer yet. Their words, verbatim: "Is the wakes split done?". It was filed on task 479823ee "Restructure the wakes file". Show them the answer the work found now with emit_card and answering true, from its record. If another task took the work over, link it as the replacement with link_tasks instead. Starting, steering, stopping or closing work and changing settings are refused this turn.',
    },
  ],
};

pinWakeWords("the first mate's wakes of the captain's moves, byte for byte", CASES);
