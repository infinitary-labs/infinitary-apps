import {
  closeSync,
  type Dirent,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { speaksRecordRefresh } from "@shared/contractFeatures";
import { SESSION_COPY_FROM_MAX, type WorkOrderResponse } from "@shared/work";
import { dueIn, rewriteOutsideData, textFilesUnder } from "../integrations";
import { errorText } from "../personal/errorText";
import { SHARED_STAGING, STAGED_FOLDER } from "../session/stagingFolders";
import { claudeCallsBetween } from "../storage/sessionReader";
import type { WorkDevices } from "./workDevices";

/**
 * This Mac's copy of one task's conversation record held on a computer that
 * runs work (docs/helper.md, "The record's copy"): brought up to that
 * computer's from where each file's copy ends, one copy at a time, with live
 * copies during a turn coalesced to at most one start per second, and a
 * file that computer wrote again shorter copied whole. A copy that fails
 * stops the live copies until a copy that is not live brings the record
 * home, and a copy too large for one order forgets the staged skills that
 * computer no longer holds (INF-4240).
 */

/** Live copies share at most one start per second; a turn's end always flushes. */
const LIVE_COPY_MS = 1_000;

/** A file of this Mac's copy, with where it ends and the staged skills it belongs to, if any. */
type HeldFile = { name: string; offset: number; set: string | undefined };

function scheduleCopy(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export type RecordCopyOptions = {
  readonly task: string;
  readonly deviceId: string;
  readonly devices: WorkDevices;
  readonly now: () => number;
  /** One-shot copy delay; answers its own cancel. Tests drive it with the same clock as now. */
  readonly schedule?: (ms: number, run: () => void) => () => void;
  readonly log: (line: string) => void;
  /** The conversation is held here and not closed, so live copies may go on. */
  readonly following: () => boolean;
  /**
   * A Claude call there is announced and its result has not arrived, or it
   * ended and this Mac's copy holds the call but not yet its result.
   */
  readonly callOpen: () => boolean;
};

export class RecordCopy {
  /** The record's copy, one at a time. */
  private copying: Promise<void> = Promise.resolve();
  /** A trailing live copy, coalesced while a copy is scheduled or in flight. */
  private timer: (() => void) | undefined;
  private live: Promise<void> | undefined;
  private pending = false;
  private copiedAt = Number.NEGATIVE_INFINITY;
  /** How far each file of the copy was read for its calls, by its path. */
  private readonly callsReadTo = new Map<string, number>();
  /** The Claude calls the copy holds, and those whose results it holds. */
  private readonly calls = new Set<string>();
  private readonly results = new Set<string>();
  /**
   * What this Mac's copy holds of each session's staged skills, by the
   * session's folder under `staged`: walked once when the folder is first
   * seen, then kept up to date from what each copy writes, since only the
   * copy writes there. A copy then walks the record's own files and lists
   * `staged` once, never every skill file in it (INF-4224: staged skills were
   * 97% of what each walk read, and dozens of walks in one turn stalled the app).
   */
  private staged: { dir: string; folders: Map<string, Map<string, number>> } | undefined;
  /**
   * The last copy failed: live copies wait until a copy that is not live - a
   * turn's end, a reconnect or the session's release - brings the record
   * home, so a copy that computer refused is not asked again every second
   * while a call's result is missing here (INF-4240).
   */
  private failed = false;

  /** `dir` is where this Mac keeps the copy: its open session's record folder. */
  constructor(
    private readonly options: RecordCopyOptions,
    public dir: string,
  ) {}

  /** Claude may announce a call before its refreshable transcript has reached disk. */
  growing(): boolean {
    return (
      this.options.callOpen() &&
      speaksRecordRefresh(this.options.devices.version(this.options.deviceId)?.contract ?? "")
    );
  }

  /**
   * This Mac's copy holds one of these Claude calls but not yet its result.
   * The client reports a call's end as it streams the result, and can write
   * that result to its transcript afterwards, even after its next request
   * has started, so a finished call can lack its result here until a later
   * copy. The copy is read once for the whole set, however many calls a
   * turn has ended (INF-3705).
   */
  awaitsAnyResult(callIds: ReadonlySet<string>): boolean {
    if (callIds.size === 0) return false;
    this.readCalls();
    for (const id of callIds) if (this.calls.has(id) && !this.results.has(id)) return true;
    return false;
  }

  /**
   * Reads the calls and results the copy took in since the last read, from
   * the record's own transcripts at the top of its folder, never the skills
   * a session staged beside them.
   */
  private readCalls(): void {
    for (const { path, offset } of transcripts(this.dir)) {
      const read = this.callsReadTo.get(path) ?? 0;
      // A file copied whole again shorter is read again from its start.
      const from = offset < read ? 0 : read;
      if (offset === from) continue;
      const found = claudeCallsBetween(path, from, offset);
      for (const id of found.calls) this.calls.add(id);
      for (const id of found.results) this.results.add(id);
      this.callsReadTo.set(path, from + found.bytes);
    }
  }

  /** Coalesced copies outside the event lane, repeated while a call's transcript can still grow. */
  duringTurn(): void {
    if (
      this.failed ||
      !this.options.following() ||
      !this.options.devices.inReach(this.options.deviceId)
    )
      return;
    this.pending = true;
    if (this.timer !== undefined || this.live) return;
    const delay = Math.min(
      LIVE_COPY_MS,
      Math.max(0, this.copiedAt + LIVE_COPY_MS - this.options.now()),
    );
    this.timer = (this.options.schedule ?? scheduleCopy)(delay, () => {
      this.timer = undefined;
      this.live = this.copy()
        .catch(() => undefined) // copy() records the failure; turn end, reconnect and release retry.
        .finally(() => {
          this.live = undefined;
          if (this.pending || this.growing()) this.duringTurn();
        });
    });
  }

  cancelLive(): void {
    this.timer?.();
    this.timer = undefined;
    this.pending = false;
  }

  /**
   * Brings this Mac's copy of the conversation's record up to the
   * computer's, from where each file's copy ends; a file the computer
   * rewrote shorter is rewritten from where it differs.
   */
  copy(): Promise<void> {
    this.cancelLive();
    const { task, deviceId, devices } = this.options;
    const recordDir = this.dir;
    const run = this.copying.then(async () => {
      this.copiedAt = this.options.now();
      let refresh = speaksRecordRefresh(devices.version(deviceId)?.contract ?? "");
      const naming = new CopyNames();
      try {
        let more = true;
        while (more) {
          const answer = (await devices.ask(deviceId, "inf:session:copy", [
            {
              task,
              from: naming.from(this.held(recordDir)),
              ...(refresh ? { refresh: true } : {}),
            },
          ])) as WorkOrderResponse<"inf:session:copy">;
          for (const file of answer.files) this.write(recordDir, file);
          naming.took(answer);
          refresh = false;
          more = answer.more && answer.files.length > 0;
        }
      } catch (caught) {
        this.failed = true;
        throw caught;
      }
      this.failed = false;
      this.forget(recordDir, naming.gone());
    });
    this.copying = run.catch((caught: unknown) =>
      this.options.log(`could not copy ${task}'s record home: ${errorText(caught)}`),
    );
    return run;
  }

  /**
   * Replaces the words from outside due under `rule` in this copy: each file
   * that computer replaced (`changed`), and any file of this copy that still
   * holds some, from a pass a drop cut short, is copied whole; one that
   * computer no longer holds is replaced here. Answers whether any file was
   * due here, and whether a drop cut the copy short.
   */
  async replaceDue(
    changed: readonly string[],
    rule: Parameters<typeof dueIn>[1],
    legacy: Parameters<typeof dueIn>[2],
  ): Promise<{ any: boolean; short: boolean }> {
    const names = new Set(changed);
    const recordDir = this.dir;
    for (const file of textFilesUnder(recordDir))
      if (await dueIn(file, rule, legacy, undefined))
        names.add(relative(recordDir, file).split(sep).join("/"));
    if (names.size === 0) return { any: false, short: false };
    const copied = await this.copyWhole([...names]);
    for (const name of copied.absent)
      rewriteOutsideData(join(recordDir, ...name.split("/")), rule, legacy);
    return { any: true, short: copied.short.length > 0 };
  }

  /**
   * These files of the record, copied whole after that computer wrote them
   * again shorter: each is written beside this Mac's copy and put in its
   * place once whole, so the copy never mixes old and new words, while the
   * rest of the record is copied on as usual. Answers the files that
   * computer does not hold, and those a drop cut short.
   */
  copyWhole(names: readonly string[]): Promise<{ absent: string[]; short: string[] }> {
    const { task, deviceId, devices } = this.options;
    const recordDir = this.dir;
    const staging = `${recordDir}.whole`;
    const wanted = new Map(names.map((name) => [name, 0]));
    const whole = new Set<string>();
    const seen = new Set<string>();
    const run = this.copying.then(async () => {
      rmSync(staging, { recursive: true, force: true });
      const naming = new CopyNames();
      try {
        let more = true;
        while (more) {
          const from = naming.from(
            this.held(recordDir).filter((file) => !wanted.has(file.name)),
            [...wanted]
              .filter(([name]) => !whole.has(name))
              .map(([name, offset]) => ({ name, offset })),
          );
          const answer = (await devices.ask(deviceId, "inf:session:copy", [
            { task, from },
          ])) as WorkOrderResponse<"inf:session:copy">;
          for (const file of answer.files) {
            if (!wanted.has(file.name)) {
              this.write(recordDir, file);
              continue;
            }
            if (whole.has(file.name)) continue;
            seen.add(file.name);
            writeAt(staging, file);
            const end = file.offset + Buffer.byteLength(file.data, "base64");
            wanted.set(file.name, end);
            if (end < file.size) continue;
            const target = join(recordDir, ...file.name.split("/"));
            mkdirSync(dirname(target), { recursive: true });
            renameSync(join(staging, ...file.name.split("/")), target);
            this.wrote(recordDir, file.name, end);
            whole.add(file.name);
          }
          naming.took(answer);
          more = answer.more && answer.files.length > 0;
        }
        this.forget(recordDir, naming.gone());
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      return {
        absent: names.filter((name) => !seen.has(name)),
        short: names.filter((name) => seen.has(name) && !whole.has(name)),
      };
    });
    this.copying = run.then(
      () => undefined,
      (caught: unknown) =>
        this.options.log(`could not copy ${task}'s record home whole: ${errorText(caught)}`),
    );
    return run;
  }

  /**
   * Every file of this Mac's copy, by its path under the record's folder,
   * with where it ends: the record's own files walked, and the staged skills
   * from what the copy already knows it holds of each session's folder.
   */
  private held(dir: string): HeldFile[] {
    if (this.staged?.dir !== dir) this.staged = { dir, folders: new Map() };
    const known = this.staged.folders;
    const stagedDir = join(dir, STAGED_FOLDER);
    let present: Dirent[];
    try {
      present = readdirSync(stagedDir, { withFileTypes: true });
    } catch {
      present = [];
    }
    const names = new Set(present.map((entry) => entry.name));
    // A session's folder removed here is forgotten; one first seen is walked once.
    for (const name of [...known.keys()]) if (!names.has(name)) known.delete(name);
    for (const entry of present) {
      if (known.has(entry.name)) continue;
      const prefix = `${STAGED_FOLDER}/${entry.name}`;
      const path = join(stagedDir, entry.name);
      known.set(
        entry.name,
        new Map(
          entry.isDirectory()
            ? copiedFiles(path).map((file) => [`${prefix}/${file.name}`, file.offset])
            : fileEnd(path).map((offset) => [prefix, offset]),
        ),
      );
    }
    return [
      ...copiedFiles(dir, STAGED_FOLDER).map((file) => ({ ...file, set: stagedSet(file.name) })),
      ...[...known].flatMap(([folder, files]) =>
        [...files].map(([name, offset]) => ({ name, offset, set: `${STAGED_FOLDER}/${folder}` })),
      ),
    ];
  }

  /** These staged skills, which that computer no longer holds, leave this Mac's copy. */
  private forget(dir: string, sets: readonly string[]): void {
    for (const set of sets) {
      rmSync(join(dir, ...set.split("/")), { recursive: true, force: true });
      const [top, folder] = set.split("/");
      if (top === STAGED_FOLDER && folder && this.staged?.dir === dir)
        this.staged.folders.delete(folder);
    }
  }

  private write(
    dir: string,
    file: { name: string; size: number; offset: number; data: string },
  ): void {
    if (writeAt(dir, file))
      this.wrote(dir, file.name, file.offset + Buffer.byteLength(file.data, "base64"));
  }

  private wrote(dir: string, name: string, end: number): void {
    const [top, folder] = name.split("/");
    if (top !== STAGED_FOLDER || !folder || this.staged?.dir !== dir) return;
    const files = this.staged.folders.get(folder);
    if (files) files.set(name, end);
    else this.staged.folders.set(folder, new Map([[name, end]]));
  }
}

/**
 * What one copy names in `from`, order by order. While every file of this
 * Mac's copy fits in one order, it names them all. Past that, it names the
 * record's own files and only the staged skills that came back in this copy,
 * so that computer sends whole each session's skills it still holds; once
 * such a copy runs to its end, the staged skills that never came back are
 * the ones that computer removed (INF-4240: a home's copy kept every earlier
 * session's skills and passed the most one order may name).
 */
class CopyNames {
  private past = false;
  private complete = false;
  /** The staged skills this Mac's copy held at the last order. */
  private sets = new Set<string>();
  /** The staged skills that came back in this copy. */
  private readonly back = new Set<string>();

  from(
    held: readonly HeldFile[],
    also: readonly { name: string; offset: number }[] = [],
  ): { name: string; offset: number }[] {
    this.past ||= held.length + also.length > SESSION_COPY_FROM_MAX;
    this.sets = new Set(held.flatMap((file) => (file.set === undefined ? [] : [file.set])));
    const named = this.past
      ? held.filter((file) => file.set === undefined || this.back.has(file.set))
      : held;
    return [...named.map(({ name, offset }) => ({ name, offset })), ...also];
  }

  took(answer: WorkOrderResponse<"inf:session:copy">): void {
    for (const file of answer.files) {
      const set = stagedSet(file.name);
      if (set !== undefined) this.back.add(set);
    }
    this.complete = !answer.more;
  }

  /**
   * The staged skills this Mac's copy holds and that computer no longer
   * does: known only from a copy past the limit that ran to its end.
   */
  gone(): string[] {
    if (!this.past || !this.complete) return [];
    return [...this.sets].filter((set) => !this.back.has(set));
  }
}

/**
 * The staged skills a file of the record belongs to, by their folder's path
 * there: one session's under `staged`, or what earlier versions staged at
 * the record's top. None for the record's own files.
 */
function stagedSet(name: string): string | undefined {
  const [top = "", folder] = name.split("/");
  if (top === STAGED_FOLDER) return folder ? `${STAGED_FOLDER}/${folder}` : undefined;
  return SHARED_STAGING.includes(top) ? top : undefined;
}

function transcripts(dir: string): { path: string; offset: number }[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];
    const path = join(dir, entry.name);
    try {
      return [{ path, offset: statSync(path).size }];
    } catch {
      return [];
    }
  });
}

/**
 * Every file under `dir`, by its path there, with where it ends; a folder
 * at its top named `skip` is left out.
 */
function copiedFiles(dir: string, skip?: string): { name: string; offset: number }[] {
  const files: { name: string; offset: number }[] = [];
  const walk = (folder: string, prefix: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!(prefix === "" && entry.name === skip)) walk(path, name);
        continue;
      }
      for (const offset of fileEnd(path)) files.push({ name, offset });
    }
  };
  walk(dir, "");
  return files;
}

function fileEnd(path: string): number[] {
  try {
    const stat = statSync(path);
    return stat.isFile() ? [stat.size] : [];
  } catch {
    return [];
  }
}

function writeAt(
  dir: string,
  file: { name: string; size: number; offset: number; data: string },
): boolean {
  const path = join(dir, ...file.name.split("/"));
  if (relative(dir, path).startsWith("..")) return false;
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(file.data, "base64");
  const fd = openSync(path, "a+");
  closeSync(fd);
  const handle = openSync(path, "r+");
  try {
    let written = 0;
    while (written < bytes.length)
      written += writeSync(handle, bytes, written, bytes.length - written, file.offset + written);
    const end = file.offset + bytes.length;
    if (end >= file.size) ftruncateSync(handle, end);
  } finally {
    closeSync(handle);
  }
  return true;
}
