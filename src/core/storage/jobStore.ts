import type { AppDatabase } from "./db";

/**
 * The background jobs a quit would interrupt (`jobs`, R2): a row while a job
 * runs, gone when it exits on its own or its owner stops it. The app's quit
 * marks each row as it kills the job and leaves it, so rows left at boot are
 * the honest record: a marked one the quit stopped; an unmarked one was
 * still running when the app ended without its quit (a crash, a force quit),
 * and since jobs run detached, its command may have run on. The one writer
 * of the table; the live processes are the job manager's.
 */

export type InterruptedJob = {
  ownerId: string;
  command: string;
  /** The app's quit killed it; otherwise nothing is known of how it ended. */
  stoppedByQuit: boolean;
};

export class JobStore {
  constructor(private readonly db: AppDatabase) {}

  /** Boot: the rows a previous process left, removed as they are read. */
  takeInterrupted(): InterruptedJob[] {
    const rows = this.db
      .prepare("SELECT owner_id, command, stopped_by_quit FROM jobs ORDER BY started_at")
      .all() as { owner_id: string; command: string; stopped_by_quit: number }[];
    this.db.prepare("DELETE FROM jobs").run();
    return rows.map((row) => ({
      ownerId: row.owner_id,
      command: row.command,
      stoppedByQuit: row.stopped_by_quit === 1,
    }));
  }

  add(job: { id: string; ownerId: string; command: string; startedAt: number }): void {
    this.db
      .prepare("INSERT INTO jobs (id, owner_id, command, started_at) VALUES (?, ?, ?, ?)")
      .run(job.id, job.ownerId, job.command, job.startedAt);
  }

  /** The quit has sent this job its kill: the next boot names it as stopped. */
  markStoppedByQuit(id: string): void {
    this.db.prepare("UPDATE jobs SET stopped_by_quit = 1 WHERE id = ?").run(id);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
}
