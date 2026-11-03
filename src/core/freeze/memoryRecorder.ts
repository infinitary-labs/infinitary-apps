import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getHeapStatistics } from "node:v8";
import { type SourceIdentity, sourceIdentitySchema } from "@shared/selfSource";
import { z } from "zod";

/**
 * The freeze recorder's memory reading (docs/freeze-recorder.md, "The memory
 * reading"; INF-2392's plan). Every `MEMORY_READING_MS` the main thread reads
 * its own memory, split between what the JavaScript heap holds and what lies
 * outside it, and appends one line to a bounded local record. INF-2392 found
 * the main process holding 9 GB, most of it native and cold, and could not
 * tell from outside the app which kind it was; a line here tells the two
 * apart in the affected process itself.
 */

/**
 * How often the main thread reads its memory. The growth INF-2392 measured
 * was about 80 to 190 MB an hour, so a reading every five minutes shows its
 * slope within the hour while costing the main thread nothing it feels.
 */
export const MEMORY_READING_MS = 5 * 60_000;
/** The record keeps the newest week of readings; older ones drop, so it never grows past this. */
export const MEMORY_RECORD_MAX_LINES = (7 * 24 * 60 * 60_000) / MEMORY_READING_MS;

/**
 * One reading, every figure in bytes. `footprintBytes` is the process's
 * physical footprint as the system counts it, compressed and swapped memory
 * included (macOS's `phys_footprint`, what Activity Monitor shows); it is
 * absent where the host cannot read it, never zero. `rssBytes` is resident
 * memory only, which leaves out what the system compressed or swapped. The
 * JavaScript heap is `heapTotalBytes` (`heapUsedBytes` of it live);
 * `externalBytes` is native memory JavaScript objects still hold, such as
 * buffers, `arrayBuffersBytes` the part of that in array buffers. What lies
 * outside both is native memory no JavaScript object holds.
 */
export const memoryLineSchema = z.object({
  at: z.string(),
  pid: z.number().int(),
  uptimeS: z.number().int().nonnegative(),
  build: sourceIdentitySchema.optional(),
  footprintBytes: z.number().int().nonnegative().optional(),
  rssBytes: z.number().int().nonnegative(),
  heapTotalBytes: z.number().int().nonnegative(),
  heapUsedBytes: z.number().int().nonnegative(),
  externalBytes: z.number().int().nonnegative(),
  arrayBuffersBytes: z.number().int().nonnegative(),
  mallocedBytes: z.number().int().nonnegative(),
});
export type MemoryLine = z.infer<typeof memoryLineSchema>;

/** A reading's split: the JavaScript heap, native memory JavaScript holds, and native memory nothing in JavaScript holds. */
export type MemorySplit = {
  javascriptBytes: number;
  heldNativeBytes: number;
  /** Unknown, never zero, when the reading has no footprint. */
  unheldNativeBytes: number | null;
};

export function memorySplit(line: MemoryLine): MemorySplit {
  return {
    javascriptBytes: line.heapTotalBytes,
    heldNativeBytes: line.externalBytes,
    unheldNativeBytes:
      line.footprintBytes === undefined
        ? null
        : Math.max(0, line.footprintBytes - line.heapTotalBytes - line.externalBytes),
  };
}

/** The reading the main thread takes of itself now. */
export async function readMemory(options: {
  now: () => Date;
  footprint?: () => Promise<number | null>;
  build?: SourceIdentity;
}): Promise<MemoryLine> {
  let footprint: number | null = null;
  try {
    footprint = (await options.footprint?.()) ?? null;
  } catch {
    footprint = null;
  }
  const usage = process.memoryUsage();
  const heap = getHeapStatistics();
  const whole = (bytes: number) => Math.max(0, Math.round(bytes));
  return {
    at: options.now().toISOString(),
    pid: process.pid,
    uptimeS: Math.floor(process.uptime()),
    ...(options.build ? { build: options.build } : {}),
    ...(footprint !== null && Number.isFinite(footprint) && footprint > 0
      ? { footprintBytes: whole(footprint) }
      : {}),
    rssBytes: whole(usage.rss),
    heapTotalBytes: whole(usage.heapTotal),
    heapUsedBytes: whole(usage.heapUsed),
    externalBytes: whole(usage.external),
    arrayBuffersBytes: whole(usage.arrayBuffers),
    mallocedBytes: whole(heap.malloced_memory),
  };
}

/**
 * Takes a reading at start and every `MEMORY_READING_MS` after, appending
 * each to the record and keeping its newest `MEMORY_RECORD_MAX_LINES`. A
 * failed read or write loses that reading and never the app.
 */
export class MemoryRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lines = -1;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      recordPath: string;
      build?: SourceIdentity;
      footprint?: () => Promise<number | null>;
      now?: () => Date;
      maxLines?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.read(), MEMORY_READING_MS);
    this.timer.unref();
    void this.read();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Take one reading now and append it; resolves once it is written. */
  read(): Promise<void> {
    const next = this.writing.then(async () => {
      try {
        const line = await readMemory({
          now: this.options.now ?? (() => new Date()),
          ...(this.options.footprint ? { footprint: this.options.footprint } : {}),
          ...(this.options.build ? { build: this.options.build } : {}),
        });
        await this.append(line);
      } catch {
        // A reading that cannot be taken or written is lost; the next one still runs.
      }
    });
    this.writing = next;
    return next;
  }

  private async append(line: MemoryLine): Promise<void> {
    const path = this.options.recordPath;
    const max = this.options.maxLines ?? MEMORY_RECORD_MAX_LINES;
    if (this.lines < 0) this.lines = existing(path).length;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
    this.lines += 1;
    // Trimmed once a tenth over, so the whole file is rewritten rarely.
    if (this.lines > max + Math.ceil(max / 10)) {
      const kept = existing(path).slice(-max);
      await writeFile(path, kept.map((each) => `${each}\n`).join(""), "utf8");
      this.lines = kept.length;
    }
  }
}

function existing(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((each) => each.trim() !== "");
}

/** The record's readings, oldest first; a torn or foreign line is skipped. */
export function readMemoryRecord(path: string): MemoryLine[] {
  return existing(path).flatMap((each) => {
    try {
      const parsed = memoryLineSchema.safeParse(JSON.parse(each));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}
