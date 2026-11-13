import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type CardMediaExtension,
  parseCardMediaFileName,
  parseCardPictureFileName,
} from "@shared/cardPictures";
import {
  PLACED_COPY_CHUNK_BYTES,
  type PlacedEventRecord,
  placedEventRecordSchema,
  placedTaskFolders,
  placedTaskIdSchema,
  type WorkOrderRequest,
  type WorkOrderResponse,
  workOrders,
} from "@shared/work";
import { z } from "zod";
import type { JobRows } from "../jobs/jobManager";
import { rm } from "../plainFs";
import { receiveEvidenceFile } from "../tasks/evidenceFile";
import { HANDOVER_IN_DIR_NAME } from "../tasks/handoverFiles";
import { APP_KEPT_PARTS, removeTaskLeftovers } from "../tasks/taskLeftovers";
import { provisionTaskTemp, removeOwnedTempFolder, type TempRemoval } from "../tasks/taskTemp";
import { sha256Of } from "../workspace/bundles";
import { migrateConversations } from "./migrateConversations";

/**
 * The one writer over `userData/work/tasks/` on a computer that runs work
 * (docs/helper.md, "Holding a conversation"): one folder per task a home
 * opened a conversation for, with the conversation's record, the folders
 * its tools read and write, the orders it already applied, the outbox of
 * what it did that the home has not kept yet, and the background jobs its
 * shell runs. 0700 folders, 0600 files, like the rest of the work folder.
 * Nothing here reads a sign-in.
 */

/** What a task's folder keeps between runs, beside its outbox and orders. */
const taskStateSchema = z.object({
  /** The newest turn number it gave a prompt. */
  turn: z.number().int().nonnegative(),
  /** The newest event number it wrote. */
  seq: z.number().int().nonnegative(),
  /** The newest event number the home keeps for good. */
  kept: z.number().int().nonnegative(),
  /** The home closed the conversation; it opens no more. */
  closed: z.boolean(),
  /** The turn running when it was written, and the order that started it. */
  running: z.object({ turn: z.number().int().positive(), orderId: z.string() }).optional(),
  /**
   * The home was told a client-owned continuation started and not yet that
   * it ended: a boundary owed to the home, never whether the conversation
   * works, which only its live session says (INF-2332).
   */
  continuing: z.literal(true).optional(),
});
export type PlacedTaskState = z.infer<typeof taskStateSchema>;

const EMPTY_STATE: PlacedTaskState = { turn: 0, seq: 0, kept: 0, closed: false };

const orderLineSchema = z.object({ orderId: z.string(), answer: z.unknown() });

/**
 * A background job its crewmate's shell started here, or a background task
 * its Claude client runs (`SessionHost`), kept in `jobs.json` while it runs.
 */
const placedJobSchema = z.object({
  id: z.string(),
  command: z.string(),
  startedAt: z.number(),
  /** When this computer's stop killed it (`JobManager.disposeAll`); absent, nothing stopped it. */
  stoppedAt: z.number().optional(),
  /**
   * It exited, or ended with the Claude client it ran in (`client`), and its
   * home has not answered its end yet (`SessionHost`).
   */
  exit: z
    .object({
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      tail: z.string(),
      interrupted: z.literal("client").optional(),
    })
    .optional(),
});
export type PlacedJob = z.infer<typeof placedJobSchema>;

export class PlacedTasks {
  readonly tasksDir: string;
  private readonly trashDir: string;
  private readonly sourceTransfers = new Map<string, Promise<unknown>>();

  /**
   * `worktreesDir` is where this computer's working copies are
   * (`WorkingCopies`), which their own writer makes; absent, a task's
   * working folder is an empty one of its own.
   */
  constructor(
    dataDir: string,
    private readonly worktreesDir?: string,
  ) {
    this.tasksDir = join(dataDir, "tasks");
    this.trashDir = join(dataDir, "worktree-trash");
    migrateConversations(dataDir);
  }

  /** The task's folders, by the layout the home writes instructions with. */
  folders(task: string) {
    return placedTaskFolders(this.tasksDir, this.checked(task), this.worktreesDir);
  }

  /** Discard staging copies after their consumer has received them, never source evidence. */
  async discardCardCopies(task: string, files: string[]): Promise<void> {
    const dir = this.folders(task).cards;
    for (const file of new Set(files)) {
      const parsed = parseCardPictureFileName(file) ?? parseCardMediaFileName(file);
      if (!parsed || parsed.taskId !== task)
        throw new Error("The media copy belongs to another task.");
      await rm(join(dir, file), { force: true });
    }
  }

  /** Makes the task's folders, each 0700; a working copy is its own writer's to make. */
  ensure(task: string): ReturnType<PlacedTasks["folders"]> {
    const folders = this.folders(task);
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
    for (const [name, dir] of Object.entries(folders)) {
      if (name === "work" && this.worktreesDir) continue;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // An empty temp directory from the loop above is provisioned; one that
    // already holds files and has no marker stays on the week-long policy.
    provisionTaskTemp(folders.root);
    return folders;
  }

  /** A source file's pieces arrive in order; retries never append duplicate bytes. */
  sourceFile(
    input: WorkOrderRequest<"inf:session:source-file">[0],
  ): Promise<WorkOrderResponse<"inf:session:source-file">> {
    const key = `${input.task}/${input.evidence ? "evidence" : (input.into ?? "")}/${input.name}`;
    const run = (this.sourceTransfers.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.writeSourceFile(input));
    this.sourceTransfers.set(key, run);
    void run
      .finally(() => {
        if (this.sourceTransfers.get(key) === run) this.sourceTransfers.delete(key);
      })
      .catch(() => {});
    return run;
  }

  private async writeSourceFile(
    input: WorkOrderRequest<"inf:session:source-file">[0],
  ): Promise<WorkOrderResponse<"inf:session:source-file">> {
    const [piece] = workOrders["inf:session:source-file"].request.parse([input]);
    const folders = this.ensure(piece.task);
    if (piece.evidence) return receiveEvidenceFile(folders.evidence, folders.temp, piece);
    // A handed file goes in the temporary folder, so it goes when the task closes.
    const dir =
      piece.into === "handover" ? join(folders.temp, HANDOVER_IN_DIR_NAME) : folders.sourceCards;
    if (piece.into === "handover") mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, piece.name);
    if (existsSync(file)) {
      if (statSync(file).size === piece.size && (await sha256Of(file)) === piece.sha256)
        return { file, complete: true };
      // A retried dispatch may carry a revised card; replace it only after verification.
    }
    const part = `${file}.${piece.sha256}.part`;
    const bytes = Buffer.from(piece.data, "base64");
    const held = existsSync(part) ? statSync(part).size : 0;
    if (piece.offset > held || piece.offset + bytes.length > piece.size)
      throw new Error("The source file's pieces are incomplete or exceed its size.");
    const fd = openSync(part, "a+", 0o600);
    closeSync(fd);
    const handle = openSync(part, "r+");
    try {
      let written = 0;
      while (written < bytes.length)
        written += writeSync(
          handle,
          bytes,
          written,
          bytes.length - written,
          piece.offset + written,
        );
    } finally {
      closeSync(handle);
    }
    if (statSync(part).size !== piece.size) return { file, complete: false };
    if ((await sha256Of(part)) !== piece.sha256) {
      rmSync(part, { force: true });
      throw new Error("The source file did not arrive unchanged.");
    }
    renameSync(part, file);
    return { file, complete: true };
  }

  /** Every task this computer holds a folder for. */
  list(): string[] {
    try {
      return readdirSync(this.tasksDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && placedTaskIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** This computer holds a folder for the task. */
  has(task: string): boolean {
    return existsSync(this.folders(task).root);
  }

  /**
   * Removes the task's folder whole: its conversation's record, its orders
   * and its outbox. Only for a task its home no longer records here, whose
   * conversation is closed for good and whose working copy is gone
   * (`SessionHost`, `inf:session:remove`).
   */
  remove(task: string): void {
    rmSync(this.folders(task).root, { recursive: true, force: true });
  }

  /** The home closed the task; only a provisioned temporary folder goes now. */
  async removeOwnedTemp(task: string): Promise<TempRemoval> {
    const deletes: Promise<void>[] = [];
    const result = await removeOwnedTempFolder(
      this.folders(task).root,
      this.trashDir,
      task,
      (dir) => deletes.push(rm(dir, { recursive: true, force: true })),
    );
    await Promise.all(deletes);
    return result;
  }

  /** The home checked the close age and live dependencies; protocol state stays here. */
  async removeLeftovers(task: string): Promise<{ removedFiles: string[]; bytes: number }> {
    if (!this.state(task).closed)
      throw new Error("This task's conversation is not closed here yet.");
    const deletes: Promise<void>[] = [];
    const result = await removeTaskLeftovers(
      this.folders(task).root,
      this.trashDir,
      task,
      new Set([...APP_KEPT_PARTS, "state.json", "orders.jsonl", "outbox.jsonl", "work"]),
      (dir) => deletes.push(rm(dir, { recursive: true, force: true })),
    );
    await Promise.all(deletes);
    return result;
  }

  state(task: string): PlacedTaskState {
    try {
      return taskStateSchema.parse(
        JSON.parse(readFileSync(join(this.folders(task).root, "state.json"), "utf8")),
      );
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  /** Written whole, then moved into place, so a quit never leaves half a state. */
  writeState(task: string, state: PlacedTaskState): void {
    const root = this.root(task);
    const temporary = join(root, "state.json.next");
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, join(root, "state.json"));
  }

  /** The events after `kept` that the home has not kept, in order. */
  outbox(task: string, kept: number): PlacedEventRecord[] {
    let text: string;
    try {
      text = readFileSync(join(this.folders(task).root, "outbox.jsonl"), "utf8");
    } catch {
      return [];
    }
    const records: PlacedEventRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = placedEventRecordSchema.parse(JSON.parse(line));
        if (record.seq > kept) records.push(record);
      } catch {
        // A line a quit cut short is the last one; the turn it ended says so.
      }
    }
    return records;
  }

  append(task: string, records: readonly PlacedEventRecord[]): void {
    if (records.length === 0) return;
    appendFileSync(
      join(this.root(task), "outbox.jsonl"),
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      { mode: 0o600 },
    );
  }

  /** Keeps only the events after `kept`. */
  trim(task: string, kept: number): void {
    const root = this.folders(task).root;
    const left = this.outbox(task, kept);
    const temporary = join(root, "outbox.jsonl.next");
    writeFileSync(temporary, left.map((record) => `${JSON.stringify(record)}\n`).join(""), {
      mode: 0o600,
    });
    renameSync(temporary, join(root, "outbox.jsonl"));
  }

  /** The orders this conversation already applied, with what each answered. */
  orders(task: string): Map<string, unknown> {
    const applied = new Map<string, unknown>();
    let text: string;
    try {
      text = readFileSync(join(this.folders(task).root, "orders.jsonl"), "utf8");
    } catch {
      return applied;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const order = orderLineSchema.parse(JSON.parse(line));
        applied.set(order.orderId, order.answer);
      } catch {
        // As for the outbox.
      }
    }
    return applied;
  }

  applied(task: string, orderId: string, answer: unknown): void {
    appendFileSync(
      join(this.root(task), "orders.jsonl"),
      `${JSON.stringify({ orderId, answer })}\n`,
      { mode: 0o600 },
    );
  }

  /** A verified card picture's copy, by the id the card names it by. */
  picture(task: string, id: string): { extension: "png" | "jpg" | "webp"; data: Buffer } {
    const dir = this.folders(task).cards;
    for (const extension of ["png", "jpg", "webp"] as const) {
      const file = join(dir, `${id}.${extension}`);
      if (existsSync(file)) return { extension, data: readFileSync(file) };
    }
    throw new Error(`The card picture ${id} is not in this task's folder.`);
  }

  /** A verified project font's copy, by the file name a preview names it by. */
  typeface(task: string, fileName: string): Buffer {
    const file = join(this.folders(task).cards, fileName);
    if (!existsSync(file))
      throw new Error(`The card font ${fileName} is not in this task's folder.`);
    return readFileSync(file);
  }

  /** A checked card data file's copy, by the file name its card names it by. */
  data(task: string, fileName: string): Buffer {
    const file = join(this.folders(task).cards, fileName);
    if (!existsSync(file))
      throw new Error(`The card data file ${fileName} is not in this task's folder.`);
    return readFileSync(file);
  }

  /** A verified demo recording's copy, by the id and kind its poster names it by. */
  recording(task: string, id: string, kind: CardMediaExtension): Buffer {
    const file = join(this.folders(task).cards, `${id}.${kind}`);
    if (!existsSync(file))
      throw new Error(`The card recording ${id} is not in this task's folder.`);
    return readFileSync(file);
  }

  /**
   * The conversation's record, from where the home's copy of each file
   * ends: every file under the task's `sessions` folder by its path there,
   * at most `PLACED_COPY_CHUNK_BYTES` in all.
   */
  copy(
    task: string,
    from: readonly { name: string; offset: number }[],
  ): WorkOrderResponse<"inf:session:copy"> {
    const dir = this.folders(task).sessions;
    const offsets = new Map(from.map((entry) => [entry.name, entry.offset]));
    let names: string[];
    try {
      names = (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
        .filter((name) => {
          try {
            return statSync(join(dir, name)).isFile();
          } catch {
            return false;
          }
        })
        .map((name) => relative(dir, join(dir, name)).split(sep).join("/"))
        .sort();
    } catch {
      names = [];
    }
    let budget = PLACED_COPY_CHUNK_BYTES;
    let more = false;
    const files: WorkOrderResponse<"inf:session:copy">["files"] = [];
    for (const name of names) {
      const fd = openSync(join(dir, name), "r");
      try {
        const size = fstatSync(fd).size;
        const offset = Math.min(offsets.get(name) ?? 0, size);
        if (offset === size && offsets.has(name)) continue;
        const length = Math.min(size - offset, budget);
        if (length < size - offset) more = true;
        const bytes = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const got = readSync(fd, bytes, read, length - read, offset + read);
          if (got === 0) break;
          read += got;
        }
        files.push({ name, size, offset, data: bytes.subarray(0, read).toString("base64") });
        budget -= read;
      } finally {
        closeSync(fd);
      }
      if (budget <= 0) {
        more = more || names.indexOf(name) < names.length - 1;
        break;
      }
    }
    return { files, more };
  }

  /** The task's own folder, made 0700 when it is first written to. */
  private root(task: string): string {
    const { root } = this.folders(task);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  /**
   * The background jobs a task's shell runs here, as `JobManager` keeps them
   * (`JobRows`): a row while a job runs, gone when it exits or its owner
   * stops it, and marked when this computer's stop kills it. A row that
   * cannot be kept only leaves the next start less to say; the job runs on.
   */
  readonly jobRows: JobRows = {
    add: (job) =>
      this.keepJobs(job.ownerId, (jobs) => [
        ...jobs,
        { id: job.id, command: job.command, startedAt: job.startedAt },
      ]),
    remove: (id, ownerId) => this.keepJobs(ownerId, (jobs) => jobs.filter((job) => job.id !== id)),
    markStoppedByQuit: (id, ownerId, at) =>
      this.keepJobs(ownerId, (jobs) =>
        jobs.map((job) => (job.id === id ? { ...job, stoppedAt: at } : job)),
      ),
  };

  /**
   * The task's job rows. At a start, before its conversation opens, each is
   * a job the last run's end cut off, or an exit its home had not answered
   * yet (`SessionHost`).
   */
  jobs(task: string): PlacedJob[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.folders(task).root, "jobs.json"), "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((row) => {
      const job = placedJobSchema.safeParse(row);
      return job.success ? [job.data] : [];
    });
  }

  /** A job's row as given, in place of the one with its id. */
  keepJob(task: string, row: PlacedJob): void {
    this.keepJobs(task, (jobs) => [...jobs.filter((job) => job.id !== row.id), row]);
  }

  /** The home has heard of this job: its row goes. */
  forgetJob(task: string, id: string): void {
    this.keepJobs(task, (jobs) => jobs.filter((job) => job.id !== id));
  }

  /** Written whole, then moved into place, and never into a folder that is gone. */
  private keepJobs(task: string, change: (jobs: PlacedJob[]) => PlacedJob[]): void {
    try {
      const { root } = this.folders(task);
      if (!existsSync(root)) return;
      const jobs = change(this.jobs(task));
      const file = join(root, "jobs.json");
      if (jobs.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      const temporary = `${file}.next`;
      writeFileSync(temporary, `${JSON.stringify(jobs)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      // As the rows say: the next start says less.
    }
  }

  /** A task id names a folder: anything but a minted one is refused before a path is built. */
  private checked(task: string): string {
    if (!placedTaskIdSchema.safeParse(task).success) throw new Error(`No task is named ${task}.`);
    return task;
  }
}
