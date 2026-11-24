import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keptCheckSchema, keptRemoveFailedSchema } from "@shared/keptJobs";
import { type LeftoversReport, stopCommandSchema, stopLabelSchema } from "@shared/leftoverPrograms";
import { z } from "zod";
import { keptRoot } from "./taskStops";

/**
 * The home's record of the jobs the captain asked to keep running, which a
 * merged or answered close left running (docs/leftover-programs.md, "A job
 * the captain asked to keep"; INF-4381's approved plan, direction A): one
 * entry per job, naming the computer and account it runs as, its label,
 * the commands that check and remove it, its kept folder, the task that
 * set it up and when it was kept. Saved in `jobs.json` in the kept folder
 * beside the task folders, readable only by the user, so neither a close
 * nor retention's purge of a task removes it. Its one writer.
 */

export const KEPT_JOBS_FILE = "jobs.json";

export const keptJobSchema = z.object({
  /** The computer that runs work it runs on, by device id; null for this computer. */
  computer: z.string().min(1).max(128).nullable(),
  account: z.string().max(256),
  label: stopLabelSchema,
  check: stopCommandSchema,
  remove: stopCommandSchema,
  folder: z.string().min(1).max(4096),
  task: z.string().min(1).max(64),
  key: z.string().max(64),
  at: z.number().int().nonnegative(),
  /** How its last check from Kept running went (docs/leftover-programs.md, "Kept running"). */
  checked: keptCheckSchema.optional(),
  /** How its last remove went when it did not finish, which keeps it listed. */
  removeFailed: keptRemoveFailedSchema.optional(),
});
export type KeptJob = z.infer<typeof keptJobSchema>;

const keptJobsFileSchema = z.object({ jobs: z.array(keptJobSchema) });

export class KeptJobs {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every kept job, oldest first; a missing or unreadable file holds none. */
  list(): KeptJob[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = keptJobsFileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.jobs : [];
    } catch {
      return [];
    }
  }

  /**
   * Records the jobs one close kept. A close order answered again carries
   * the same jobs, so a job already recorded on that computer, by its kept
   * folder, is not recorded twice.
   */
  record(
    jobs: NonNullable<LeftoversReport["kept"]>,
    from: { computer: string | null; task: string; key: string },
  ): KeptJob[] {
    if (jobs.length === 0) return [];
    const known = this.list();
    const at = this.now();
    const added = jobs
      .filter(
        (job) =>
          !known.some((entry) => entry.computer === from.computer && entry.folder === job.folder),
      )
      .map(
        (job): KeptJob => ({
          computer: from.computer,
          account: job.account,
          label: job.label,
          check: job.check,
          remove: job.remove,
          folder: job.folder,
          task: from.task,
          key: from.key,
          at,
        }),
      );
    if (added.length === 0) return [];
    this.write([...known, ...added]);
    return added;
  }

  /**
   * Notes how a check or a remove that did not finish went on the job on
   * that computer with that kept folder; answers the job as now kept, or
   * undefined when it is no longer listed.
   */
  note(
    computer: string | null,
    folder: string,
    fact: Pick<KeptJob, "checked"> | Pick<KeptJob, "removeFailed">,
  ): KeptJob | undefined {
    const jobs = this.list();
    const at = jobs.findIndex((job) => job.computer === computer && job.folder === folder);
    const job = jobs[at];
    if (!job) return undefined;
    const next = { ...job, ...fact };
    jobs[at] = next;
    this.write(jobs);
    return next;
  }

  /** Takes the job on that computer with that kept folder off the record, once its remove ran or the captain forgot it. */
  forget(computer: string | null, folder: string): void {
    const jobs = this.list();
    const kept = jobs.filter((job) => !(job.computer === computer && job.folder === folder));
    if (kept.length !== jobs.length) this.write(kept);
  }

  /** Hears each write of the record, after it lands; returns the stop function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(jobs: KeptJob[]): void {
    const dir = join(this.file, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = `${this.file}.next`;
    writeFileSync(next, `${JSON.stringify({ jobs })}\n`, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, this.file);
    for (const listener of this.listeners) listener();
  }
}

/** The home's record beside its task folders (`crewmatesDir`): `<userData>/kept/jobs.json`. */
export function keptJobsAt(tasksDir: string, now?: () => number): KeptJobs {
  return new KeptJobs(join(keptRoot(tasksDir), KEPT_JOBS_FILE), now);
}
