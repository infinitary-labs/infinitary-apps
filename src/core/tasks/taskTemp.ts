import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import type { AppPaths } from "../paths";
import { lstat, mkdir, readdir, readFile, rename, rm } from "../plainFs";
import type { TaskRetentionFields } from "../storage/taskRecords";
import { TaskService } from "./taskService";

/**
 * A task's temporary folder (FI3-1701, option A): `crewmates/<taskId>/temp/`,
 * beside evidence, for bulk working material. The app provisions it and
 * records that with a marker beside the folder, never inside it, so emptying
 * the folder does not drop the contract. A folder named temp that the app
 * did not provision — including one a crewmate already filled — keeps the
 * week-long leftover policy. Cleanup removes only a provisioned folder, and
 * only after the task is done or dropped. Its walks read through `plainFs`,
 * so an app's `.asar` file inside is a file, never a mounted volume.
 */

export const TEMP_DIR_NAME = "temp";
/** Beside `temp/`, not inside it. A regular file; a link is not ownership. */
export const TEMP_MARKER_NAME = ".infinitary-temp";
export const TEMP_OWNERSHIP_TOKEN = "infinitary-temp-v1\n";
/**
 * The marker Firstmate 3000 wrote before the Infinitary rename, with its own
 * token: still ownership, so a folder it provisioned is removed at the close.
 */
export const OLDER_TEMP_MARKER_NAME = ".fm3000-temp";
const OLDER_TEMP_OWNERSHIP_TOKEN = "fm3000-temp-v1\n";

/** Each marker name with the token that makes it ownership, Infinitary's first. */
const MARKERS = [
  [TEMP_MARKER_NAME, TEMP_OWNERSHIP_TOKEN],
  [OLDER_TEMP_MARKER_NAME, OLDER_TEMP_OWNERSHIP_TOKEN],
] as const;

export type TempRemoval =
  | { status: "removed"; bytes: number }
  | { status: "absent"; bytes: 0 }
  | { status: "pending"; bytes: 0; reason: string };

const ABSENT: TempRemoval = { status: "absent", bytes: 0 };

function pending(reason: string): TempRemoval {
  return { status: "pending", bytes: 0, reason };
}

function markerIsValidSync(path: string, token: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return false;
    return readFileSync(path, "utf8") === token;
  } catch {
    return false;
  }
}

async function markerIsValid(path: string, token: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile()) return false;
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === token;
}

/** The task folder's ownership marker under either name, or null when it has none of ours. */
async function ownedMarker(taskFolder: string): Promise<string | null> {
  for (const [name, token] of MARKERS) {
    const path = join(taskFolder, name);
    if (await markerIsValid(path, token)) return path;
  }
  return null;
}

/**
 * Creates the temporary folder and its ownership marker when the task does
 * not already have a temp directory with contents. An existing folder with
 * files and no marker is legacy and is left alone.
 */
export function provisionTaskTemp(taskFolder: string): void {
  mkdirSync(taskFolder, { recursive: true, mode: 0o700 });
  const temp = join(taskFolder, TEMP_DIR_NAME);
  const marker = join(taskFolder, TEMP_MARKER_NAME);
  if (MARKERS.some(([name, token]) => markerIsValidSync(join(taskFolder, name), token))) {
    const stat = lstatSync(temp, { throwIfNoEntry: false });
    if (!stat) mkdirSync(temp, { mode: 0o700 });
    return;
  }
  // A marker that is not ours, under either name, is not followed and not replaced.
  if (MARKERS.some(([name]) => lstatSync(join(taskFolder, name), { throwIfNoEntry: false })))
    return;
  const tempStat = lstatSync(temp, { throwIfNoEntry: false });
  if (tempStat?.isSymbolicLink() || (tempStat && !tempStat.isDirectory())) return;
  if (tempStat) {
    let entries: string[];
    try {
      entries = readdirSync(temp);
    } catch {
      return;
    }
    // Files and no marker: a legacy folder, left on the week-long policy.
    if (entries.length > 0) return;
  } else {
    mkdirSync(temp, { mode: 0o700 });
  }
  writeFileSync(marker, TEMP_OWNERSHIP_TOKEN, { mode: 0o600, flag: "wx" });
}

/** Bytes under a path. A link is counted as a link and never followed. */
async function sizeOf(path: string): Promise<number> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) total += await sizeOf(join(path, entry));
  return total;
}

/**
 * True when a directory is a mount, contains one, or cannot be verified.
 * Links are not followed. A missing path is not unsafe.
 */
export async function directoryRemovalUnsafe(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const parent = await lstat(join(path, "..")).catch(() => undefined);
  if (!parent?.isDirectory()) return true;
  if (stat.dev !== parent.dev) return true;
  return containsMount(path, stat.dev);
}

async function containsMount(path: string, rootDev: number): Promise<boolean> {
  const entries = await readdir(path).catch(() => undefined);
  if (!entries) return true;
  for (const entry of entries) {
    const child = join(path, entry);
    const stat = await lstat(child).catch(() => undefined);
    if (!stat) return true;
    if (stat.isSymbolicLink()) continue;
    if (stat.dev !== rootDev) return true;
    if (stat.isDirectory() && (await containsMount(child, rootDev))) return true;
  }
  return false;
}

/**
 * The week-long leftover pass must not fall through to a recursive delete
 * of a provisioned temporary folder that still holds a volume.
 */
export async function ownedTempUnsafe(taskFolder: string): Promise<boolean> {
  if (!(await ownedMarker(taskFolder))) return false;
  return directoryRemovalUnsafe(join(taskFolder, TEMP_DIR_NAME));
}

/**
 * Removes a provisioned temporary folder only: rename into the trash, then
 * delete in the background. A link, a mount, or a root that cannot be
 * verified stays in place. Never force-detaches a volume and never follows
 * a link. A folder the app did not provision is left for the week-long pass.
 */
export async function removeOwnedTempFolder(
  taskFolder: string,
  trashDir: string,
  taskId: string,
  deleteInBackground: (dir: string) => void,
): Promise<TempRemoval> {
  const root = await lstat(taskFolder).catch(() => undefined);
  // A missing folder, or one that is itself a link, is left alone. The app
  // provisions a real directory, so a link is not this contract.
  if (!root?.isDirectory() || root.isSymbolicLink()) return ABSENT;
  const marker = await ownedMarker(taskFolder);
  if (!marker) return ABSENT;
  const temp = join(taskFolder, TEMP_DIR_NAME);
  const stat = await lstat(temp).catch(() => undefined);
  if (!stat) {
    await rm(marker, { force: true }).catch(() => undefined);
    return ABSENT;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return pending("the temporary folder could not be verified");
  }
  if (stat.dev !== root.dev || (await containsMount(temp, stat.dev))) {
    return pending("a volume is still mounted");
  }
  const bytes = await sizeOf(temp);
  await mkdir(trashDir, { recursive: true }).catch(() => undefined);
  const aside = join(trashDir, `${taskId}-temp-${randomUUID().slice(0, 8)}`);
  const moved = await rename(temp, aside).then(
    () => true,
    () => false,
  );
  if (!moved) return pending("safe removal is uncertain");
  await rm(marker, { force: true }).catch(() => undefined);
  deleteInBackground(aside);
  return { status: "removed", bytes };
}

type TasksReader = Pick<
  TaskService,
  "get" | "listClosedRetentionFields" | "retentionFields" | "note" | "onChange" | "timeline"
>;

export type TaskTempFilesOptions = {
  paths: Pick<AppPaths, "crewmatesDir" | "worktreeTrashDir">;
  tasks: TasksReader;
  deleteInBackground: (dir: string) => void;
  now: () => number;
  /** Only an acknowledged answer clears a task on another computer. */
  removePlaced?: (record: TaskRetentionFields) => Promise<TempRemoval>;
  /**
   * The close's sweep of what the task left running, which ends programs
   * holding the folder before it goes (docs/leftover-programs.md); resolved when none began.
   */
  leftoversSettled?: (taskId: string) => Promise<void>;
};

/**
 * Removes each closed task's provisioned temporary folder at the close,
 * then retries a removal that could not finish. Live work does not hold
 * the folder: a successor reads evidence, not this temporary folder.
 * Open and active tasks, including a failure that can resume, are never
 * touched, because their records are not closed.
 */
export class TaskTempFiles {
  private readonly cleared = new Set<string>();
  private running: Promise<void> | undefined;
  private again = false;
  private lastPassAt = Number.NEGATIVE_INFINITY;
  /** Closed tasks a pass could not clear yet, tried again at the next. */
  private retry = new Set<string>();

  constructor(private readonly options: TaskTempFilesOptions) {}

  watch(): () => void {
    return this.options.tasks.onChange(({ taskIds }) => {
      const closedSince = taskIds.some((id) => {
        const record = this.options.tasks.get(id);
        return (
          record !== undefined &&
          TaskService.isClosed(record) &&
          (record.closedAt ?? 0) >= this.lastPassAt
        );
      });
      if (closedSince) void this.sweep();
    });
  }

  sweep(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          await Promise.resolve();
          this.again = false;
          await this.pass().catch((caught) => {
            console.warn("[tasks] the pass over closed tasks' temporary folders failed:", caught);
          });
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * The first pass reads every closed task; a later one only the closes
   * since the last pass and the tasks it could not clear, never the whole
   * record (INF-3032).
   */
  private async pass(): Promise<void> {
    const now = this.options.now();
    const since = this.lastPassAt;
    const tasks = this.options.tasks;
    const closed = tasks.listClosedRetentionFields(
      since === Number.NEGATIVE_INFINITY ? null : since,
      null,
    );
    const left = tasks.retentionFields([...this.retry]);
    // Only once read: a pass that failed before reads its closes again.
    this.lastPassAt = now;
    this.retry = new Set();
    const read = new Set<string>();
    for (const record of [...closed, ...left]) {
      if (read.has(record.id)) continue;
      read.add(record.id);
      if (!TaskService.isClosed(record) || record.closedAt === null) continue;
      const key = `${record.id}@${record.closedAt}`;
      if (this.cleared.has(key)) continue;
      this.retry.add(record.id);
      try {
        const result = await this.remove(record);
        if (result.status === "pending") {
          this.notePending(record.id, result.reason);
          continue;
        }
        if (result.status === "removed" && result.bytes > 0) this.noteRemoved(record, result.bytes);
        this.cleared.add(key);
        this.retry.delete(record.id);
      } catch (caught) {
        this.notePending(record.id, pendingReason(caught));
      }
    }
  }

  private async remove(record: TaskRetentionFields): Promise<TempRemoval> {
    await this.options.leftoversSettled?.(record.id);
    // The files its reports handed on stay: a steer after the close still
    // hands them, and they go with its other leftover files a week on, or
    // later while live work builds on it (`closedTaskFiles.ts`).
    if (record.deviceId) {
      if (!this.options.removePlaced)
        return Promise.resolve(pending("its computer is out of reach"));
      return this.options.removePlaced(record);
    }
    return removeOwnedTempFolder(
      join(this.options.paths.crewmatesDir, record.id),
      this.options.paths.worktreeTrashDir,
      record.id,
      this.options.deleteInBackground,
    );
  }

  private noteRemoved(record: TaskRetentionFields, bytes: number): void {
    const already = this.options.tasks
      .timeline(record.id)
      .some((event) => event.data?.tempRemoved === record.closedAt);
    if (already) return;
    this.options.tasks.note(record.id, `temporary files removed, ${fileSizeWords(bytes)}`, {
      news: false,
      data: { tempRemoved: record.closedAt, bytes },
    });
  }

  private notePending(taskId: string, reason: string): void {
    if (this.options.tasks.timeline(taskId).some((event) => event.data?.tempPending === reason))
      return;
    this.options.tasks.note(taskId, `temporary files kept: ${reason}`, {
      news: false,
      data: { tempPending: reason },
    });
  }
}

function pendingReason(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "";
  if (message.includes("out of reach")) return "its computer is out of reach";
  if (message.includes("needs an update")) return "its computer needs an update";
  if (message.includes("not closed") || message.includes("writers"))
    return "its writers have not stopped";
  return "safe removal is uncertain";
}
