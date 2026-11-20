import type { HostChildProcess, HostChildSpawner } from "../host";
import type { PlacedWorkAnswer, PlacedWorkRead } from "../routing/placedWork";
import type {
  ClosedTaskSearch,
  ClosedTaskSearchInput,
  TaskSelection,
  TaskSelectionInput,
} from "../storage/taskSelection";
import type { RecordAnswer, RecordChild, RecordParent, RecordRead } from "./protocol";

// Keep reader failure recoverable at attachment points. Opening uses the SQL
// process startup allowance; answering gets the same bounded wait before
// optional placement charges are dropped and task searches report the failure.
export const RECORD_READER_TIMEOUTS = { openMs: 10_000, answerMs: 10_000 };

type Pending = {
  timer?: ReturnType<typeof setTimeout>;
  request: RecordRead;
  resolve: (answer: RecordAnswer) => void;
  reject: (error: Error) => void;
};

/** One read-only process, shared by concurrent starts and the agents' and window's searches; never a synchronous fallback. */
export class RecordReader {
  private child: HostChildProcess | undefined;
  private ready = false;
  private disposed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly queued: number[] = [];
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private opening: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly spawner: HostChildSpawner | undefined,
    private readonly path: string,
    private readonly timeouts = RECORD_READER_TIMEOUTS,
  ) {}

  placed(input: PlacedWorkRead): Promise<PlacedWorkAnswer> {
    return this.read({ kind: "placed", input }) as Promise<PlacedWorkAnswer>;
  }

  tasks(input: TaskSelectionInput): Promise<TaskSelection> {
    return this.read({ kind: "tasks", input }) as Promise<TaskSelection>;
  }

  /** The window's search of earlier work (`TaskProtocol.search`). */
  closed(input: ClosedTaskSearchInput): Promise<ClosedTaskSearch> {
    return this.read({ kind: "closed", input }) as Promise<ClosedTaskSearch>;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    const stopped = child
      ? new Promise<void>((resolve) => child.onExit(() => resolve()))
      : Promise.resolve();
    this.fail(new Error("the record reader is shut down"));
    return stopped;
  }

  private fail(error: Error): void {
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    if (this.opening) clearTimeout(this.opening);
    this.opening = undefined;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.queued.length = 0;
    child?.kill();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private read(request: RecordRead): Promise<RecordAnswer> {
    const spawner = this.spawner;
    if (this.disposed || !spawner)
      return Promise.reject(new Error("the record reader is unavailable"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { request, resolve, reject });
      this.queued.push(id);
      try {
        if (!this.child) {
          const child = spawner.spawn();
          this.child = child;
          child.onMessage((raw) => {
            if (this.child !== child) return;
            const message = raw as RecordChild;
            if (message.type === "ready") {
              if (this.opening) clearTimeout(this.opening);
              this.opening = undefined;
              this.ready = true;
              this.schedule();
              return;
            }
            if (message.type === "failed") {
              this.fail(new Error(message.message));
              return;
            }
            const pending = this.pending.get(message.id);
            if (pending?.timer) clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.type === "answer") pending?.resolve(message.answer);
            else pending?.reject(new Error(message.message));
          });
          child.onExit(() => {
            if (this.child === child) this.fail(new Error("the record reader stopped"));
          });
          this.opening = setTimeout(() => {
            if (this.child === child && !this.ready)
              this.fail(new Error("the record reader did not open in time"));
          }, this.timeouts.openMs);
          const open: RecordParent = { type: "open", path: this.path };
          child.postMessage(open);
        }
        this.schedule();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private schedule(): void {
    if (!this.ready || this.scheduled || !this.queued.length) return;
    // One event-loop batch of starts shares the expensive work snapshot.
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      const reads = this.queued.splice(0).flatMap((id) => {
        const pending = this.pending.get(id);
        return pending ? [{ id, request: pending.request }] : [];
      });
      for (const { id } of reads) {
        const pending = this.pending.get(id);
        if (pending)
          pending.timer = setTimeout(() => {
            if (this.pending.has(id))
              this.fail(new Error("the record reader did not answer in time"));
          }, this.timeouts.answerMs);
      }
      const message: RecordParent = { type: "batch", reads };
      try {
        this.child?.postMessage(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
