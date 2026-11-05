import {
  closeSync,
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
import type { WorkOrderResponse } from "@shared/work";
import { errorText } from "../personal/errorText";
import type { WorkDevices } from "./workDevices";

/**
 * This Mac's copy of one task's conversation record held on a computer that
 * runs work (docs/helper.md, "The record's copy"): brought up to that
 * computer's from where each file's copy ends, one copy at a time, with live
 * copies during a turn coalesced to at most one start per second, and a
 * file that computer wrote again shorter copied whole.
 */

/** Live copies share at most one start per second; a turn's end always flushes. */
const LIVE_COPY_MS = 1_000;

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
  /** A Claude call there is announced and its result has not arrived. */
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

  /** Coalesced copies outside the event lane, repeated while a call's transcript can still grow. */
  duringTurn(): void {
    if (!this.options.following() || !this.options.devices.inReach(this.options.deviceId)) return;
    this.pending = true;
    if (this.timer !== undefined || this.live) return;
    const delay = Math.min(
      LIVE_COPY_MS,
      Math.max(0, this.copiedAt + LIVE_COPY_MS - this.options.now()),
    );
    this.timer = (this.options.schedule ?? scheduleCopy)(delay, () => {
      this.timer = undefined;
      this.live = this.copy()
        .catch(() => undefined) // copy() records the failure; reconnect and turn end still retry.
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
      let more = true;
      while (more) {
        const answer = (await devices.ask(deviceId, "inf:session:copy", [
          {
            task,
            from: copiedFiles(recordDir),
            ...(refresh ? { refresh: true } : {}),
          },
        ])) as WorkOrderResponse<"inf:session:copy">;
        for (const file of answer.files) writeAt(recordDir, file);
        refresh = false;
        more = answer.more && answer.files.length > 0;
      }
    });
    this.copying = run.catch((caught: unknown) =>
      this.options.log(`could not copy ${task}'s record home: ${errorText(caught)}`),
    );
    return run;
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
      try {
        let more = true;
        while (more) {
          const from = [
            ...copiedFiles(recordDir).filter((file) => !wanted.has(file.name)),
            ...[...wanted]
              .filter(([name]) => !whole.has(name))
              .map(([name, offset]) => ({ name, offset })),
          ];
          const answer = (await devices.ask(deviceId, "inf:session:copy", [
            { task, from },
          ])) as WorkOrderResponse<"inf:session:copy">;
          for (const file of answer.files) {
            if (!wanted.has(file.name)) {
              writeAt(recordDir, file);
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
            whole.add(file.name);
          }
          more = answer.more && answer.files.length > 0;
        }
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
}

/** Every file of this Mac's copy, by its path under the record's folder, with where it ends. */
function copiedFiles(dir: string): { name: string; offset: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[];
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) return [];
      return [{ name: relative(dir, join(dir, name)).split(sep).join("/"), offset: stat.size }];
    } catch {
      return [];
    }
  });
}

/** One copied stretch of a file, written at its offset; the file ends where the stretch does. */
function writeAt(
  dir: string,
  file: { name: string; size: number; offset: number; data: string },
): void {
  const path = join(dir, ...file.name.split("/"));
  if (relative(dir, path).startsWith("..")) return;
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
}
