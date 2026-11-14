/**
 * The honest retry's wakes: a crewmate's turn failing at its provider,
 * still failing, answering again, and a provider cutting the crew off and
 * coming back.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import type { CutOffClass } from "@shared/authFailure";
import type { KindWords, TypedWake, WakeFacts, WakeTask } from "./wakes";

/** The facts of the honest retry's and the cut-off wakes. */
export type OutageFacts =
  | {
      /** The honest retry: an outage's first provider failure on a lane with guidance. */
      kind: "outage-failed";
      task: WakeTask;
      crewmate: string;
      /** The provider's error, already capped for a wake. */
      error: string;
      /** The headline of the report the turn made before it failed, kept on the record (INF-3165). */
      keptReport?: string;
      /** For a provider refusal: the other open tasks on the same account (`sameAccountWords`). */
      sameAccount?: WakeTask[];
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
      /**
       * Stuck at its provider (docs/inbox.md, "Stuck at its provider"): the
       * same refusal `refusals` times in a row, so the host stopped
       * retrying and keeps the guidance until the first mate answers.
       */
      kind: "provider-stuck";
      task: WakeTask;
      crewmate: string;
      /** The task's key, which update_task takes. */
      key: string;
      /** The provider's words, already capped for a wake. */
      error: string;
      /** When its outage began. */
      since: number;
      refusals: number;
      /** The model the app would move it to, when one serves; absent when no move can work. */
      moveTo?: string;
      /** The provider that refused it, as the captain names it. */
      provider?: string;
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
    };

/** The honest retry's wake at the first provider failure of an outage. */
export function outageFailedWake(
  task: WakeTask & { crewmate: string },
  error: string,
  keptReport?: string,
  sameAccount?: readonly WakeTask[],
): TypedWake {
  return {
    facts: {
      kind: "outage-failed",
      task: { id: task.id, title: task.title },
      crewmate: task.crewmate,
      error,
      ...(keptReport ? { keptReport } : {}),
      ...(sameAccount ? { sameAccount: sameAccount.map(({ id, title }) => ({ id, title })) } : {}),
    },
  };
}

/**
 * What a provider refusal's wake says of the account it met (docs/inbox.md,
 * "The same refusal on one account"): the other open tasks on it, that a
 * refusal in the same words there wakes nobody again, and what an account
 * refusal asks of the first mate. Empty for a failure that is no refusal.
 */
export function sameAccountWords(sameAccount: readonly WakeTask[] | undefined): string {
  if (!sameAccount) return "";
  const others =
    sameAccount.length > 0
      ? `The same account serves ${tasksText(sameAccount)}.`
      : "No other open task uses the same account.";
  return ` The provider refused the request. ${others} You are not woken again for a refusal in these words on this account until a turn on it goes through, and a crewmate on it that stops retrying in these words is not told separately. If the refusal is about the account rather than this request, such as new terms only the captain can accept, ask the captain once and name every crewmate on the account; a steer sends a waiting crewmate's guidance again at once.`;
}

/**
 * What a failed turn's wake says of the report it made before it failed
 * (INF-3165): kept on the record, not counted, and named to the crewmate
 * on its next turn. Empty when it made none.
 */
export function keptReportWords(keptReport: string | undefined): string {
  return keptReport
    ? ` Before it failed, the crewmate reported "${keptReport}": the host kept that report on the task's record, but it did not count as the turn's result. The crewmate's next turn names it and asks it to check what already took effect and report again, so do not ask it to redo the work.`
    : "";
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

/** The one wake when a task gets stuck at its provider. */
export function stuckWake(
  task: WakeTask & { key: string; crewmate: string },
  stuck: { error: string; since: number; refusals: number; moveTo?: string; provider?: string },
): TypedWake {
  return {
    facts: {
      kind: "provider-stuck",
      task: { id: task.id, title: task.title },
      crewmate: task.crewmate,
      key: task.key,
      error: stuck.error,
      since: stuck.since,
      refusals: stuck.refusals,
      ...(stuck.moveTo ? { moveTo: stuck.moveTo } : {}),
      ...(stuck.provider ? { provider: stuck.provider } : {}),
    },
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

/** The honest retry's and the cut-off wakes, worded. */
export const OUTAGE_WORDS: KindWords<OutageFacts> = {
  "outage-failed": (facts) =>
    `[fm-op] ${facts.crewmate}'s turn on task ${facts.task.id} "${facts.task.title}" failed at the provider: ${facts.error}.${keptReportWords(facts.keptReport)}${sameAccountWords(facts.sameAccount)} Nothing was set aside: the host keeps its guidance and retries it on its own, backing off to every 15 minutes, so do not resend it. You will hear when it answers again, and if it is still failing in 15 minutes. You can still steer or interrupt it.`,
  "outage-still-down": (facts) =>
    `[fm-op] ${facts.crewmate ?? `the crewmate on ${facts.key}`} on task ${facts.task.id} "${facts.task.title}" is still failing at the provider after ${Math.round(facts.downMs / 60_000)} minutes and ${facts.failures} tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.`,
  "provider-stuck": (facts) =>
    `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" is stuck at its provider: the provider refused its request the same way ${facts.refusals} times in a row since ${new Date(facts.since).toISOString()}: ${facts.error}. The host stopped retrying and keeps its guidance; nothing is lost. Answer it one way: steer_crewmate with new words; update_task task ${facts.key} unstick restart, to continue in a fresh conversation from its brief and record${facts.moveTo ? `; or update_task task ${facts.key} unstick move, to move it to ${facts.moveTo}${facts.provider ? ` off ${facts.provider}` : ""}` : ""}. If the answer meets the same refusal, you hear at once. Until you answer it counts as idle.`,
  "outage-recovered": (facts) =>
    `[fm-op] ${facts.crewmate} on task ${facts.task.id} "${facts.task.title}" is answering again after ${facts.failures} failed tries at the provider; its guidance went through.`,
  "provider-cut-off": (facts) =>
    `[fm-op] ${cutOffOpening(facts)}: ${tasksText(facts.tasks)}. Their guidance is kept, and nothing is sent to ${facts.provider} ${cutOffWayBack(facts)}; you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.`,
  "provider-back": (facts) =>
    facts.tasks.length > 0
      ? `[fm-op] ${providerBackOpening(facts.provider)}: ${tasksText(facts.tasks)}. Their kept guidance goes out now.`
      : `[fm-op] ${facts.provider} is answering again; no crewmate is left waiting on it.`,
};
