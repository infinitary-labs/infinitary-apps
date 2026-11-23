/**
 * A background job's wakes: one running past its bound, its exit, a turn
 * that ended while it ran, and a timed wait that came due.
 *
 * The wake envelope, `renderWake` and `WAKE_WORDS`, the map of every
 * kind's words, are in `wakes.ts`.
 */

import { formatDurationShort } from "@shared/quotaSignals";
import type { KindWords, TypedWake, WakeFacts, WakeLane, WakeTask } from "./wakes";

export type JobFacts =
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
      /** A timed wait on an active task is over: its steer. */
      kind: "timed-wait-over";
      reason?: string;
      /**
       * The hold ended sooner because the event it waited for came
       * (INF-5145 part 2): what arrived, one line each with its fenced
       * outside words, as an Automation event rule's run lists them.
       */
      event?: string;
      /**
       * The task's oldest background job, still running when the wait ended
       * (INF-1244): its command, already capped, and how long it has run.
       */
      job?: { command: string; runMs: number };
    }
  | {
      /**
       * Its crewmate's turn ended with a background job running and no
       * check-back named (INF-1244): the one ask for a time, once per job.
       */
      kind: "check-back-ask";
      /** The job's command, already capped. */
      command: string;
      runMs: number;
      /** How long a job counts as the task moving (`JOB_BOUND_MS`). */
      boundMs: number;
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
      /** It never exited: its computer's run, or its Claude client, ended first (`JobExit.interrupted`). */
      interrupted?: "quit" | "crash" | "client";
    };

/** The name the job bound's wake goes out once for: the job. */
export function jobBoundOnce(job: { jobId: string; startedAt: number }): string {
  return `job-bound:${job.jobId}:${job.startedAt}`;
}

/**
 * Background work no one named, as the words about a job call it: by where
 * it runs - a Claude client here, or the computer that runs the task's work,
 * whatever its backend there (INF-1536).
 */
export function unnamedBackgroundWork(computer?: string): string {
  return computer ? `background work on ${computer}` : "background work in the Claude client";
}

function jobWords(job: { command: string; runMs: number }): string {
  return `background job is still running after ${formatDurationShort(job.runMs)}: "${job.command}".`;
}

/** The check-back ask's once-name: one ask per job (INF-1244). */
export function checkBackAskOnce(job: { jobId: string; startedAt: number }): string {
  return `check-back-ask:${job.jobId}:${job.startedAt}`;
}

/** The one ask for a check-back time while a job runs (INF-1244). */
export function checkBackAsk(
  job: { jobId: string; command: string; startedAt: number },
  now: number,
  boundMs: number,
): TypedWake {
  return {
    facts: { kind: "check-back-ask", command: job.command, runMs: now - job.startedAt, boundMs },
    once: checkBackAskOnce(job),
  };
}

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

/**
 * A job's end as its owner hears it: its exit, or that it never exited
 * because the run of the computer it ran on, or the Claude client it ran
 * in, ended first - and so no exit will come, which is what the owner may
 * have been waiting for.
 */
function renderJobExit(facts: Extract<WakeFacts, { kind: "job-exit" }>): string {
  const job = `${facts.to === "firstmate" ? "[fm-op]" : "[job]"} background job ${facts.jobId}`;
  if (facts.interrupted === "quit")
    return `${job} did not finish: "${facts.command}" was stopped after ${formatJobDuration(facts.durationMs)}, when Infinitary stopped on the computer running it. No exit will come; run it again if you still need its result.`;
  if (facts.interrupted === "crash")
    return `${job} did not finish there: "${facts.command}" was still running when Infinitary ended unexpectedly on the computer running it, and it may have kept running, even to the end. No exit will come; check what it left before you run it again.`;
  if (facts.interrupted === "client")
    return `${job} did not finish: "${facts.command}" was stopped after ${formatJobDuration(facts.durationMs)}, when the Claude Code process it ran in ended. No exit will come; run it again if you still need its result.`;
  return `${job} finished: "${facts.command}" exited ${facts.exitCode ?? "by signal"} after ${formatJobDuration(facts.durationMs)}${facts.tail !== undefined ? `. Output tail:\n${facts.tail}` : " with no output"}`;
}

/** A job's run time in the words its exit wake has always used. */
function formatJobDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const JOB_WORDS: KindWords<JobFacts> = {
  "job-bound": (facts) =>
    `[fm-op] task ${facts.task.id} "${facts.task.title}" has had a background job running for ${Math.round((facts.runMs / 3_600_000) * 10) / 10} hours: "${facts.command}". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.`,
  "timed-wait-over": (facts) =>
    facts.event !== undefined
      ? `The event this task was waiting for came${facts.reason ? ` (${facts.reason})` : ""}:\n${facts.event}\nCarry on from where you stopped.`
      : `The time this task was waiting for has come${facts.reason ? ` (${facts.reason})` : ""}.${facts.job ? ` Your ${jobWords(facts.job)} Read its output so far: if it is stuck or waiting on something that will not come, stop it and say so; if it is still making progress, report again with check_back for your next look.` : ""} Carry on from where you stopped.`,
  "check-back-ask": (facts) =>
    `Your turn ended while your ${jobWords(facts)} Nothing tells you if it stalls until it ends or runs for ${formatDurationShort(facts.boundMs)}. Report again with check_back: how many minutes until you look at it again, and what you wait for. The app wakes you then with the job's facts. If you are not waiting on it, say so in that report.`,
  "job-exit": (facts) => renderJobExit(facts),
};
