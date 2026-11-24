import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  KEPT_JOB_ORDER,
  type KeptCheckOutcome,
  type KeptJobsView,
  type KeptJobView,
  type KeptRemoveResult,
  keptJobOrders,
} from "@shared/keptJobs";
import type { StopOutcome, TaskStop } from "@shared/leftoverPrograms";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { WorkDevices } from "../placed/workDevices";
import { removeAll } from "../removeWhole";
import type { KeptJob, KeptJobs } from "./keptJobs";
import { runStop, STOP_TIME_MS } from "./leftoverPrograms";

/**
 * Kept running (docs/leftover-programs.md, "Kept running"; INF-4381's
 * approved plan, piece 2): the jobs the captain asked to keep past their
 * task's close, as the home records them (`KeptJobs`), and each one's own
 * check and remove, run on the computer the job runs on - here as a close
 * runs a stop, or there through `inf:computer:kept-job`. A remove that ran
 * cleanly takes the job off the record and its kept folder with it; one
 * that did not finish keeps the job listed with how it went.
 */

/** Asking a computer that runs work to run a kept job's command (`kept-job-orders.md`). */
const KEPT_JOB_ORDERS = contractChange("kept-job-orders");

export type KeptRunningOptions = {
  jobs: KeptJobs;
  work: Pick<WorkDevices, "ask" | "inReach" | "takesCurrentWork" | "version">;
  /** A computer that runs work's name, as Settings → Computers names it. */
  computerName: (deviceId: string) => string | undefined;
  homeName: () => string;
  stopTimeMs?: number;
  now?: () => number;
};

/**
 * One kept job's id: its kept folder's own name (`<task>-<keep id>`), and
 * for a job on a computer that runs work, `@` and that computer's id too. A
 * folder's name is unique only on its own computer: a task that moved
 * computers counts its keeps again from 1 there.
 */
export function keptJobId(job: Pick<KeptJob, "folder" | "computer">): string {
  const name = basename(job.folder);
  return job.computer === null ? name : `${name}@${job.computer}`;
}

type Ran = StopOutcome["outcome"] | "unreachable";

/** The app's own Kept running: the home's kept jobs, run here or on the computer that keeps them. */
export function keptRunningAt(
  jobs: KeptJobs,
  work: KeptRunningOptions["work"],
  computers: { list(): readonly { id: string; name: string }[] },
  homeName: () => string,
): KeptRunning {
  return new KeptRunning({
    jobs,
    work,
    computerName: (id) => computers.list().find((computer) => computer.id === id)?.name,
    homeName,
  });
}

export class KeptRunning {
  constructor(private readonly options: KeptRunningOptions) {}

  list(): KeptJobsView {
    return { jobs: this.options.jobs.list().map((job) => this.view(job)) };
  }

  /** Hears each change to the record of kept jobs (`KeptJobs.onChange`). */
  onChange(listener: () => void): () => void {
    return this.options.jobs.onChange(listener);
  }

  async check(id: string): Promise<KeptJobView> {
    const job = this.find(id);
    const ran = await this.run(job, "check");
    const outcome: KeptCheckOutcome =
      ran.outcome === "ran" ? "running" : ran.outcome === "failed" ? "not-running" : ran.outcome;
    const noted = this.options.jobs.note(job.computer, job.folder, {
      checked: { at: this.now(), outcome },
    });
    return this.view(noted ?? { ...job, checked: { at: this.now(), outcome } });
  }

  /**
   * Runs the job's remove where it runs. Cleanly run, the job leaves the
   * record and its kept folder goes; otherwise it stays, with how it went.
   * `say` hears the words of the trail (the catalog's `kept-job-remove`).
   */
  async remove(
    id: string,
    options: { say?: (text: string) => void } = {},
  ): Promise<KeptRemoveResult> {
    const job = this.find(id);
    const where = this.computerName(job);
    const ran = await this.run(job, "remove");
    if (ran.outcome === "ran") {
      // There, the computer took the folder with the remove; here, it goes now.
      if (job.computer === null) removeAll(job.folder);
      this.options.jobs.forget(job.computer, job.folder);
      options.say?.(`Removed the kept job "${job.label}" on ${where}.`);
      return { id, removed: true };
    }
    const noted = this.options.jobs.note(job.computer, job.folder, {
      removeFailed: {
        at: this.now(),
        outcome: ran.outcome,
        ...(ran.exitCode !== undefined ? { exitCode: ran.exitCode } : {}),
      },
    });
    options.say?.(
      ran.outcome === "unreachable"
        ? `Could not remove the kept job "${job.label}": ${where} is out of reach, so it stays under Kept running.`
        : `The remove of the kept job "${job.label}" on ${where} did not finish, so it stays under Kept running.`,
    );
    return { id, removed: false, ...(noted ? { job: this.view(noted) } : {}) };
  }

  /**
   * Takes a job whose remove did not finish off the record without running
   * anything (Settings → Automation's Forget); the job may still run on its
   * computer, and its kept folder stays there.
   */
  forget(id: string, options: { say?: (text: string) => void } = {}): { id: string } {
    const job = this.find(id);
    this.options.jobs.forget(job.computer, job.folder);
    options.say?.(
      `Forgot the kept job "${job.label}" without removing it; it may still run on ${this.computerName(job)}.`,
    );
    return { id };
  }

  private find(id: string): KeptJob {
    const job = this.options.jobs.list().find((entry) => keptJobId(entry) === id);
    if (!job) throw new Error(`No kept job ${id}. Its id is in the list of kept jobs.`);
    return job;
  }

  private async run(
    job: KeptJob,
    action: "check" | "remove",
  ): Promise<{ outcome: Ran; exitCode?: number }> {
    const command = action === "check" ? job.check : job.remove;
    const timeMs = this.options.stopTimeMs ?? STOP_TIME_MS;
    if (job.computer === null) return runKeptCommand(job.label, command, job.folder, timeMs);
    const { work } = this.options;
    if (
      !work.inReach(job.computer) ||
      !work.takesCurrentWork(job.computer) ||
      !listsChange(work.version(job.computer)?.changes, KEPT_JOB_ORDERS)
    )
      return { outcome: "unreachable" };
    try {
      const answer = keptJobOrders[KEPT_JOB_ORDER].response.parse(
        await work.ask(job.computer, KEPT_JOB_ORDER, [
          { action, label: job.label, command, folder: job.folder },
        ]),
      );
      return answer;
    } catch {
      return { outcome: "unreachable" };
    }
  }

  private view(job: KeptJob): KeptJobView {
    return {
      id: keptJobId(job),
      label: job.label,
      computer: job.computer,
      computerName: this.computerName(job),
      account: job.account,
      task: job.task,
      key: job.key,
      at: job.at,
      ...(job.checked ? { checked: job.checked } : {}),
      ...(job.removeFailed ? { removeFailed: job.removeFailed } : {}),
    };
  }

  private computerName(job: KeptJob): string {
    if (job.computer === null) return this.options.homeName();
    return this.options.computerName(job.computer) ?? job.computer;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/**
 * Runs one kept job's command in its kept folder, as a close runs a stop.
 * A folder that is gone is made again, readable only by the user, so the
 * command never runs in the kept folder that holds every other job's.
 */
function runKeptCommand(
  label: string,
  command: string,
  folder: string,
  timeMs: number,
): Promise<StopOutcome> {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stop: TaskStop = { id: "s1", label, command, cwd: folder, at: 0 };
  return runStop(stop, dirname(folder), timeMs);
}

/**
 * A computer that runs work's answer to `inf:computer:kept-job`: the
 * command the home sent, run in the job's kept folder, which must be one
 * folder directly in this computer's own kept folder. A remove that ran
 * cleanly takes the folder with it.
 */
export async function runKeptJobHere(
  keptRootDir: string,
  args: unknown,
  timeMs: number = STOP_TIME_MS,
): Promise<{ outcome: StopOutcome["outcome"]; exitCode?: number }> {
  const [request] = keptJobOrders[KEPT_JOB_ORDER].request.parse(args);
  const folder = resolve(request.folder);
  if (dirname(folder) !== resolve(keptRootDir) || basename(folder) !== basename(request.folder))
    throw new Error("That folder is not a kept job's folder on this computer.");
  const { label: _label, ...ran } = await runKeptCommand(
    request.label,
    request.command,
    folder,
    timeMs,
  );
  if (request.action === "remove" && ran.outcome === "ran") removeAll(folder);
  return ran;
}
