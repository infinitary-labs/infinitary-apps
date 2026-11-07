import type { QueueAnswer, RepoView } from "@shared/repos";
import type { Forge } from "../forge";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { QueueReading } from "./projectQueue";
import type { WakeFacts } from "./wakes";

/** The words a paused batch puts on the Activity feed and its tasks, from one owner. */
export const QUEUE_PAUSE_WORDS = {
  /** The Activity line when this app first reads a pause. */
  paused: (name: string, run: number) =>
    `${name}'s batch paused: batch run ${run} failed its checks, so its approved changes wait for a fix.`,
  /** The Activity line once the pause ends. */
  resumed: (name: string) => `${name}'s batch is no longer paused.`,
  /** A paused task's own line: who repairs the pause. */
  task: (run: number, claimedBy: string | undefined) =>
    claimedBy
      ? `Paused with batch run ${run}: ${claimedBy} is repairing it.`
      : `Paused with batch run ${run}: nobody has taken the repair yet.`,
  /** The refusal of an answer to a batch run that no longer holds the pause. */
  ended: (run: number) =>
    `Batch run ${run} no longer holds the pause, so nothing was sent; Settings now shows the queue as it is.`,
  /** The Activity line after a by-hand answer is sent. */
  answered: (name: string, answer: QueueAnswer) =>
    answer.action === "resume"
      ? `Asked ${name}'s queue to resume: ${answer.reason}`
      : `Asked ${name}'s queue to send #${answer.number} back: ${answer.reason}`,
} as const;

/**
 * A project's paused batch, as this app follows it (docs/forge.md, "A
 * paused batch"). The shipped queue holds the pause where the project lives,
 * in one open issue; this reads it when a task's queue status names a paused
 * run it does not keep yet, and again on every pass while it keeps one, so a
 * claim, a resume, a send-back or a new push shows however long the pause
 * lasts. It keeps the pause on the project's row for Settings, puts one
 * Activity line up as it starts and ends, notes on each paused task who
 * repairs it, and tells the first mate once per paused run, which starts the
 * repair unless a teammate took it. No card: the captain chose a quiet pause.
 *
 * When the issue cannot be read (Issues turned off), the pause is kept from
 * the paused statuses alone, marked `unread`, so Settings still shows it
 * with its Resume and each paused task still says so; it ends when one of
 * its changes reads anything but paused. The first mate is not told then:
 * the issue is where a repair is claimed, and with none every teammate's
 * first mate would start its own repair of the same batch.
 */
export class QueuePauses {
  /** The paused run each task's line last named, with who repaired it then. */
  private readonly taskLines = new Map<string, string>();
  /** Projects whose pause is being read now, so readings in one sweep read once. */
  private readonly reading = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      repos: Pick<RepoRegistry, "get" | "list" | "recordQueue">;
      forgeFor: (repo: RepoView) => Pick<Forge, "queuePause" | "startQueue">;
      tell: (facts: Extract<WakeFacts, { kind: "queue-paused" }>) => void;
      note: (text: string) => void;
      taskNote: (taskId: string, text: string) => void;
      now: () => number;
    },
  ) {}

  /** One reading of a task's queue status (`ProjectQueue.onState`). */
  observed(reading: QueueReading): void {
    const { repoId, taskId, state, number } = reading;
    const repo = this.options.repos.get(repoId);
    const pause = repo?.queuePause;
    if (state.kind !== "paused") {
      // A pause read from the issue ends with the issue; one kept from the
      // statuses alone ends when one of its changes moves on.
      if (repo && pause?.unread && number !== undefined && pause.changes.includes(number)) {
        this.options.repos.recordQueue(repoId, { pause: null });
        this.options.note(QUEUE_PAUSE_WORDS.resumed(repo.name));
      }
      return;
    }
    if (pause?.run !== state.run) {
      void this.refresh(repoId, taskId, reading);
      return;
    }
    if (pause.unread && number !== undefined && !pause.changes.includes(number))
      this.options.repos.recordQueue(repoId, {
        pause: { ...pause, changes: [...pause.changes, number] },
      });
    this.noteTask(taskId, pause.run, pause.claimedBy);
  }

  /** The pass: read again every pause this app keeps, so its claim and its end show. */
  sweep(): Promise<void> {
    const kept = this.options.repos.list().filter((repo) => repo.queuePause);
    return Promise.all(kept.map((repo) => this.refresh(repo.id))).then(() => {});
  }

  /**
   * Read the project's pause where it lives and keep what changed: a new
   * pause is recorded, put on the Activity feed and told to the first mate
   * once; a claim updates the row; an ended pause clears it. A read that
   * fails changes nothing.
   */
  refresh(repoId: string, taskId?: string, reading?: QueueReading): Promise<void> {
    const running = this.reading.get(repoId);
    if (running) return running.then(() => this.noteFromRow(repoId, taskId));
    const read = this.read(repoId, taskId, reading).finally(() => this.reading.delete(repoId));
    this.reading.set(repoId, read);
    return read;
  }

  /**
   * A by-hand answer to the project's pause, from Settings or the first
   * mate: the queue starts where the project lives with the reason, and
   * closes the pause's issue itself. The pause is read again first, and an
   * answer to a run that no longer holds it is refused. Throws what the host
   * answered when it cannot start.
   */
  async answer(repoId: string, answer: QueueAnswer): Promise<void> {
    if (!this.options.repos.get(repoId)) throw new Error("That project is not in your projects.");
    await this.refresh(repoId);
    const repo = this.options.repos.get(repoId);
    if (!repo) throw new Error("That project is not in your projects.");
    if (repo.queuePause?.run !== answer.run) throw new Error(QUEUE_PAUSE_WORDS.ended(answer.run));
    const forge = this.options.forgeFor(repo);
    if (!forge.startQueue) throw new Error("This project's host cannot start its queue.");
    await forge.startQueue(answer);
    this.options.note(QUEUE_PAUSE_WORDS.answered(repo.name, answer));
  }

  private async read(
    repoId: string,
    taskId: string | undefined,
    reading?: QueueReading,
  ): Promise<void> {
    const repo = this.options.repos.get(repoId);
    if (!repo) return;
    const forge = this.options.forgeFor(repo);
    if (!forge.queuePause) return;
    const kept = repo.queuePause;
    let found: Awaited<ReturnType<NonNullable<Forge["queuePause"]>>>;
    try {
      found = await forge.queuePause();
    } catch {
      if (reading?.state.kind === "paused" && kept?.run !== reading.state.run)
        this.keepUnread(repo, reading.state.run, reading);
      this.noteFromRow(repoId, taskId);
      return;
    }
    if (!found) {
      // A pause kept from the statuses never had an issue to close.
      if (!kept || kept.unread) return;
      this.options.repos.recordQueue(repoId, { pause: null });
      this.options.note(QUEUE_PAUSE_WORDS.resumed(repo.name));
      return;
    }
    const isNew = kept?.run !== found.run;
    // A pause first kept from its statuses is told once its issue reads.
    const tell = isNew || kept?.unread === true;
    this.options.repos.recordQueue(repoId, {
      pause: {
        run: found.run,
        url: found.url,
        since: isNew ? this.options.now() : (kept?.since ?? this.options.now()),
        changes: found.changes,
        ...(found.claimedBy ? { claimedBy: found.claimedBy } : {}),
      },
    });
    if (isNew) this.options.note(QUEUE_PAUSE_WORDS.paused(repo.name, found.run));
    if (tell)
      this.options.tell({
        kind: "queue-paused",
        project: { id: repo.id, name: repo.name },
        run: found.run,
        url: found.url,
        changes: found.changes,
        ...(found.claimedBy ? { claimedBy: found.claimedBy } : {}),
      });
    this.noteFromRow(repoId, taskId);
  }

  /** Keep a pause whose issue cannot be read, as a task's paused status shows it. */
  private keepUnread(repo: RepoView, run: number, reading: QueueReading): void {
    this.options.repos.recordQueue(repo.id, {
      pause: {
        run,
        url: reading.link ?? "",
        since: this.options.now(),
        changes: reading.number !== undefined ? [reading.number] : [],
        unread: true,
      },
    });
    this.options.note(QUEUE_PAUSE_WORDS.paused(repo.name, run));
  }

  private noteFromRow(repoId: string, taskId: string | undefined): void {
    const pause = this.options.repos.get(repoId)?.queuePause;
    if (taskId && pause) this.noteTask(taskId, pause.run, pause.claimedBy);
  }

  /** Note who repairs the pause on a paused task, once per run and claim. */
  private noteTask(taskId: string, run: number, claimedBy: string | undefined): void {
    const line = QUEUE_PAUSE_WORDS.task(run, claimedBy);
    if (this.taskLines.get(taskId) === line) return;
    this.taskLines.set(taskId, line);
    this.options.taskNote(taskId, line);
  }
}
