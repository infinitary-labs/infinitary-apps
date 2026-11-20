/**
 * The words of the first mate's wakes that `outageWakes.ts` words, byte for
 * byte (INF-2625's plan, the wakes row; `tests/helpers/wakeWords.ts` says
 * why): the honest retry: a crewmate's turn failing at its provider, still
 * failing, answering again, and a provider cutting the crew off and coming
 * back.
 */
import {
  WAKE_AT as AT,
  type FirstmateOutageWakeKind,
  pinWakeWords,
  WAKE_REVIEW as REVIEW,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

const CASES: WordsCases<FirstmateOutageWakeKind> = {
  "outage-failed": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "outage-failed",
          task: TASK,
          crewmate: "crewmate 61",
          error: "529 overloaded_error",
        },
      },
      words:
        '[fm-op] crewmate 61\'s turn on task 479823ee "Restructure the wakes file" failed at the provider: 529 overloaded_error. Nothing was set aside: the host keeps its guidance and retries it on its own, backing off to every 15 minutes, so do not resend it. You will hear when it answers again, and if it is still failing in 15 minutes. You can still steer or interrupt it.',
    },
  ],
  "outage-still-down": [
    {
      name: "with a runtime",
      wake: {
        facts: {
          kind: "outage-still-down",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-2696",
          since: AT,
          downMs: 930_000,
          failures: 5,
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" is still failing at the provider after 16 minutes and 5 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.',
    },
    {
      name: "with no runtime",
      wake: {
        facts: {
          kind: "outage-still-down",
          task: TASK,
          key: "INF-2696",
          since: AT,
          downMs: 1_000_000,
          failures: 6,
        },
      },
      words:
        '[fm-op] the crewmate on INF-2696 on task 479823ee "Restructure the wakes file" is still failing at the provider after 17 minutes and 6 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.',
    },
  ],
  "outage-recovered": [
    {
      name: "its one wording",
      wake: {
        facts: { kind: "outage-recovered", task: TASK, crewmate: "crewmate 61", failures: 3 },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" is answering again after 3 failed tries at the provider; its guidance went through.',
    },
  ],
  "provider-stuck": [
    {
      name: "with another model to move to",
      wake: {
        facts: {
          kind: "provider-stuck",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-3570",
          error: 'hit a problem: {"detail":"Bad Request"}',
          since: Date.UTC(2026, 10, 11, 0, 55),
          refusals: 3,
          moveTo: "Claude Opus 5.5",
          provider: "OpenAI",
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" is stuck at its provider: the provider refused its request the same way 3 times in a row since 2026-11-11T00:55:00.000Z: hit a problem: {"detail":"Bad Request"}. The host stopped retrying and keeps its guidance; nothing is lost. Answer it one way: steer_crewmate with new words; update_task task INF-3570 unstick restart, to continue in a fresh conversation from its brief and record; or update_task task INF-3570 unstick move, to move it to Claude Opus 5.5 off OpenAI. If the answer meets the same refusal, you hear at once. Until you answer it counts as idle.',
    },
    {
      name: "with no move that can work",
      wake: {
        facts: {
          kind: "provider-stuck",
          task: TASK,
          crewmate: "crewmate 61",
          key: "INF-3570",
          error: "Bad Request",
          since: Date.UTC(2026, 10, 11, 0, 55),
          refusals: 4,
        },
      },
      words:
        '[fm-op] crewmate 61 on task 479823ee "Restructure the wakes file" is stuck at its provider: the provider refused its request the same way 4 times in a row since 2026-11-11T00:55:00.000Z: Bad Request. The host stopped retrying and keeps its guidance; nothing is lost. Answer it one way: steer_crewmate with new words; update_task task INF-3570 unstick restart, to continue in a fresh conversation from its brief and record. If the answer meets the same refusal, you hear at once. Until you answer it counts as idle.',
    },
  ],
  "provider-cut-off": [
    {
      name: "refused",
      wake: {
        facts: {
          kind: "provider-cut-off",
          provider: "Claude",
          class: "refused",
          since: AT,
          tasks: [TASK, REVIEW],
        },
      },
      words:
        '[fm-op] Claude is refusing this sign-in, so the crewmates on it are paused: task 479823ee "Restructure the wakes file", task b9299a73 "Review: Restructure the wakes file". Their guidance is kept, and nothing is sent to Claude until a different Claude account is signed in, its app is updated, or the captain asks to try again; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.',
    },
    {
      name: "signed out",
      wake: {
        facts: {
          kind: "provider-cut-off",
          provider: "Codex",
          class: "signed_out",
          since: AT,
          tasks: [TASK],
        },
      },
      words:
        '[fm-op] Codex needs the captain to sign in again, so the crewmates on it are paused: task 479823ee "Restructure the wakes file". Their guidance is kept, and nothing is sent to Codex until the captain signs in again; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.',
    },
    {
      name: "no headroom with its reset",
      wake: {
        facts: {
          kind: "provider-cut-off",
          provider: "Claude",
          class: "no_headroom",
          since: AT,
          resetsAt: AT + 7_200_000,
          tasks: [TASK],
        },
      },
      words:
        '[fm-op] Claude has used up this plan\'s allowance, so the crewmates on it are paused: task 479823ee "Restructure the wakes file". Their guidance is kept, and nothing is sent to Claude before it resets at 2026-11-05T20:32:08.000Z; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.',
    },
    {
      name: "no headroom with no reset",
      wake: {
        facts: {
          kind: "provider-cut-off",
          provider: "Grok",
          class: "no_headroom",
          since: AT,
          tasks: [TASK],
        },
      },
      words:
        '[fm-op] Grok has used up this plan\'s allowance, so the crewmates on it are paused: task 479823ee "Restructure the wakes file". Their guidance is kept, and nothing is sent to Grok before it resets; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.',
    },
  ],
  "provider-back": [
    {
      name: "with crewmates waiting",
      wake: {
        facts: { kind: "provider-back", provider: "Claude", since: AT, tasks: [TASK, REVIEW] },
      },
      words:
        '[fm-op] Claude is answering again, so the crewmates paused on it go on: task 479823ee "Restructure the wakes file", task b9299a73 "Review: Restructure the wakes file". Their kept guidance goes out now.',
    },
    {
      name: "with none",
      wake: { facts: { kind: "provider-back", provider: "Claude", since: AT, tasks: [] } },
      words: "[fm-op] Claude is answering again; no crewmate is left waiting on it.",
    },
  ],
};

pinWakeWords("the first mate's outage wakes, byte for byte", CASES);
