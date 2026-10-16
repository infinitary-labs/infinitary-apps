import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostEnv, SHELL_CAP_ENV, withTaskShell } from "../hostEnv";
import type { TypedWake, WakeLane } from "../orchestrator/wakes";
import { appendOverflow, capWithOverflow, overflowFilePath } from "../overflow";
import type { TaskShell } from "../session/session";
import type { AppDatabase } from "../storage/db";
import { type InterruptedJob, JobStore } from "../storage/jobStore";
import { atUtilityQos } from "../utilityQos";

/**
 * Background jobs for the event-driven bash tool (R2): a command that
 * finishes within the synchronous cap returns like ordinary bash; anything
 * longer keeps running as a job, the calling turn stays free, and the
 * process EXIT is what wakes the owning session - nothing polls.
 *
 * Job lifetime is app lifetime: quit kills the processes and leaves each
 * one's row, marked, in the jobs table. Rows left there at boot are the
 * honest record: a marked one the quit stopped; an unmarked one was running
 * when the app ended without its quit, and since jobs run detached, its
 * command may have run on, even to the end.
 */

export type JobExit = {
  jobId: string;
  ownerId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  tail: string;
};

export type BashOutcome =
  | { kind: "done"; exitCode: number | null; output: string }
  | { kind: "job"; jobId: string; tail: string };

/** The captain's synchronous cap (R2, round-2 decision): 3 seconds. */
export const SYNC_CAP_MS = 3000;

/** Keep the tail; a command that prints megabytes keeps its last words. */
const OUTPUT_CAP = 32_768;
const COMMAND_EXCERPT = 80;

type RunningJob = {
  id: string;
  ownerId: string;
  command: string;
  startedAt: number;
  child: ReturnType<typeof spawn>;
  output: { text: string; truncated: boolean; overflowFile?: string };
  /** Who killed it (its owner's cancel, the app's quit): the exit is not news. */
  stoppedBy?: "owner" | "quit";
};

export type JobManagerOptions = {
  onChange?: () => void;
  /** Absent (tests) means no interrupted-at-quit record. */
  db?: AppDatabase;
  /** The wake: one call per background-job exit, with the bounded tail. */
  onExit: (exit: JobExit) => void;
  /**
   * The host's one clock (the ticker's): a job's `startedAt`, which the
   * idle ladder's job bound compares against, and its duration. Absent
   * reads `Date.now()`.
   */
  now?: () => number;
};

export class JobManager {
  private readonly jobs = new Map<string, RunningJob>();
  private readonly now: () => number;
  /** The interrupted-at-quit record; absent with no database (tests). */
  private readonly rows: JobStore | undefined;

  constructor(private readonly options: JobManagerOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    this.rows = options.db ? new JobStore(options.db) : undefined;
  }

  /**
   * Boot: rows left by a previous process are jobs its quit stopped, or that
   * were running when it ended without one. Returns them (cleared) so the
   * caller can say which, honestly, once.
   */
  reportInterrupted(): InterruptedJob[] {
    return this.rows?.takeInterrupted() ?? [];
  }

  /**
   * Run one command. Resolves with the output when it finishes within the
   * cap (or the command was quick), with a job handle otherwise - and then
   * the exit arrives through onExit when it comes.
   */
  run(input: {
    ownerId: string;
    command: string;
    cwd: string;
    background?: boolean;
    capMs?: number;
    /** What the session's shell carries beyond the host's environment (`SessionSpec.shell`). */
    shell?: TaskShell;
  }): Promise<BashOutcome> {
    const id = randomUUID().slice(0, 8);
    const startedAt = this.now();
    // A crewmate's builds and tests run below the UI (../utilityQos.ts).
    const command = atUtilityQos("/bin/bash", ["-c", input.command]);
    const child = spawn(command.file, command.args, {
      cwd: input.cwd,
      // The person's search path, so node, pnpm and gh are there from a Dock
      // launch, the session's own shell over it, and the cap this command
      // answers within, which a task command keeps to (docs/axi-commands.md).
      env: withTaskShell(
        hostEnv({ [SHELL_CAP_ENV]: String(input.background ? 0 : (input.capMs ?? SYNC_CAP_MS)) }),
        input.shell,
      ),
      // Its own process group, so killing a job kills what it spawned.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job: RunningJob = {
      id,
      ownerId: input.ownerId,
      command: input.command,
      startedAt,
      child,
      output: { text: "", truncated: false },
    };
    const append = (chunk: Buffer) => {
      job.output.text += chunk.toString("utf8");
      if (job.output.text.length > OUTPUT_CAP) {
        // The live buffer only ever holds the tail (memory, not information,
        // is the constraint here); what falls off the front is not lost -
        // it spills to a file so the full output is still one open away.
        const evicted = job.output.text.length - OUTPUT_CAP;
        job.output.overflowFile ??= overflowFilePath("job-output", job.id);
        appendOverflow(job.output.overflowFile, job.output.text.slice(0, evicted));
        job.output.text = job.output.text.slice(-OUTPUT_CAP);
        job.output.truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    return new Promise<BashOutcome>((resolve) => {
      let becameJob = false;
      let exited = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const becomeJob = () => {
        if (becameJob || exited) return;
        becameJob = true;
        this.jobs.set(id, job);
        this.options.onChange?.();
        this.rows?.add({ id, ownerId: input.ownerId, command: input.command, startedAt });
        resolve({ kind: "job", jobId: id, tail: renderOutput(job.output) });
      };

      child.on("error", (error) => {
        append(Buffer.from(`${error.message}\n`));
      });
      child.on("close", (code, signal) => {
        exited = true;
        if (timer) clearTimeout(timer);
        this.jobs.delete(id);
        this.options.onChange?.();
        // The quit's kill leaves the row for the next boot to name; a job
        // that finished on its own before the kill landed leaves none.
        if (job.stoppedBy !== "quit" || signal === null) this.rows?.remove(id);
        if (!becameJob) {
          resolve({ kind: "done", exitCode: code, output: renderOutput(job.output) });
          return;
        }
        if (job.stoppedBy) return;
        this.options.onExit({
          jobId: id,
          ownerId: input.ownerId,
          command: input.command,
          exitCode: code,
          durationMs: this.now() - startedAt,
          tail: renderOutput(job.output),
        });
      });

      if (input.background) {
        becomeJob();
      } else {
        timer = setTimeout(becomeJob, input.capMs ?? SYNC_CAP_MS);
      }
    });
  }

  /** How many background commands this owner still has running. */
  runningJobCount(ownerId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId) count += 1;
    }
    return count;
  }

  hasRunningJobs(ownerId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId) return true;
    }
    return false;
  }

  /**
   * The owner's longest-running job, for the bound on background jobs as
   * proof of life (docs/report-sort.md): the host reads its start beside
   * `hasRunningJobs` and never kills it for its age.
   */
  oldestRunningJob(
    ownerId: string,
  ): { jobId: string; command: string; startedAt: number } | undefined {
    let oldest: RunningJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId) continue;
      if (!oldest || job.startedAt < oldest.startedAt) oldest = job;
    }
    return oldest
      ? { jobId: oldest.id, command: oldest.command, startedAt: oldest.startedAt }
      : undefined;
  }

  /**
   * The owner ended (cancel, discard): its jobs die and stay quiet, and no
   * later boot has anything to say about them.
   */
  killForOwner(ownerId: string): void {
    for (const job of this.jobs.values()) {
      if (job.ownerId !== ownerId) continue;
      job.stoppedBy = "owner";
      this.rows?.remove(job.id);
      killGroup(job, "SIGTERM");
    }
  }

  /**
   * App quit: everything dies, and each row is marked once its kill is sent,
   * so the next boot names the jobs the quit stopped. The mark comes after
   * the kill: a row a crash leaves unmarked only ever says less.
   */
  disposeAll(): void {
    for (const job of this.jobs.values()) {
      job.stoppedBy = "quit";
      killGroup(job, "SIGKILL");
      this.rows?.markStoppedByQuit(job.id);
    }
  }
}

function killGroup(job: RunningJob, signal: NodeJS.Signals): void {
  const pid = job.child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    job.child.kill(signal);
  }
}

function renderOutput(output: { text: string; truncated: boolean; overflowFile?: string }): string {
  const text = output.text.trimEnd();
  return output.truncated
    ? `[earlier output truncated; full output: ${output.overflowFile}]\n${text}`
    : text;
}

/**
 * A job's exit as the typed wake its owner hears (R2): the Firstmate's
 * `[fm-op]` or a crewmate's `[job]` turn, worded by `renderWake`. The
 * command is cut to its excerpt and the tail capped here, once, because
 * a long tail spills to an overflow file.
 */
export function jobExitWake(exit: JobExit, to: WakeLane): TypedWake {
  const command =
    exit.command.length > COMMAND_EXCERPT
      ? `${exit.command.slice(0, COMMAND_EXCERPT)}...`
      : exit.command;
  return {
    facts: {
      kind: "job-exit",
      to,
      jobId: exit.jobId,
      command,
      exitCode: exit.exitCode,
      durationMs: exit.durationMs,
      ...(exit.tail ? { tail: capWithOverflow(exit.tail, "job-exit-tail", { keep: "tail" }) } : {}),
    },
  };
}
