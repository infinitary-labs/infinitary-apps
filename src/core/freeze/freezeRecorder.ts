import { Worker } from "node:worker_threads";
import { settingFrom } from "@shared/envSettings";
import { forgeOf } from "@shared/forge";
import { z } from "zod";
import type { TypedWake } from "../orchestrator/wakes";
import { isAlphaVersion } from "../update/semver";

/**
 * The freeze recorder (docs/freeze-recorder.md; INF-2061's plan, built as
 * INF-2066). A watchdog thread beside the app's main thread notices when the
 * main thread misses its heartbeat, asks V8 once for the JavaScript call path
 * the main thread is running, and writes one line per stall to a bounded
 * local record: when, how long between heartbeats, how much of that the main
 * thread's own processor time was, and the function names. It records no
 * arguments, values or text.
 */

/** The main thread's heartbeat to the watchdog. */
export const HEARTBEAT_MS = 50;
/** A main thread silent this long is frozen: INF-2061's plan, under every freeze it found. */
export const FREEZE_THRESHOLD_MS = 100;
/** How often the watchdog looks at the heartbeat. */
const WATCH_MS = 20;
/** The record keeps the newest lines; older ones drop, so it never grows past this. */
export const RECORD_MAX_LINES = 500;
/** How long the watchdog waits for a call path after the stall ended before writing the line without one. */
const LATE_NAMES_MS = 1_000;

const frameSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});

/**
 * One recorded stall. `frames` is the call path, innermost first. `uncertain`
 * says the names may not be where the time went: `waited`, the main thread
 * spent under half the stall on its own processor, so it was waiting on
 * something outside JavaScript and the pause landed after; `late`, the names
 * were read only after the stall had ended, from code that ran later.
 */
export const freezeLineSchema = z.object({
  at: z.string(),
  wallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative(),
  frames: z.array(frameSchema),
  uncertain: z.enum(["waited", "late"]).optional(),
});
export type FreezeLine = z.infer<typeof freezeLineSchema>;

/**
 * Whether this build runs the recorder: an alpha build, and nothing else
 * (the captain's answer on INF-2061, "activate it only in alpha builds"). A
 * run that sets INFINITARY_FREEZE_RECORDER=1 turns it on too, for an
 * end-to-end journey that reads the record of an unpackaged build.
 */
export function isFreezeRecorderEnabled(build: {
  packaged: boolean;
  version: string;
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (settingFrom(build.env, "FREEZE_RECORDER") === "1") return true;
  return build.packaged && isAlphaVersion(build.version);
}

/** Infinitary's own source, where a fix for a freeze goes. */
export const INFINITARY_SOURCE = {
  host: "github.com",
  owner: "infinitary-labs",
  name: "infinitary",
};

/**
 * The captain's project that is Infinitary's own source, by where it lives,
 * or undefined: the first mate offers a fix task only when there is one
 * (the captain's answer on INF-2061).
 */
export function infinitaryProject<T extends { id: string; name: string; origin: string | null }>(
  projects: readonly T[],
): T | undefined {
  return projects.find((project) => {
    const where = forgeOf(project.origin);
    return (
      where.host === INFINITARY_SOURCE.host &&
      where.owner?.toLowerCase() === INFINITARY_SOURCE.owner &&
      where.name?.toLowerCase() === INFINITARY_SOURCE.name
    );
  });
}

/**
 * The first mate's wake about one recorded freeze, once per call path: the
 * same freeze recurring is not new information.
 */
export function freezeWake(line: FreezeLine, project: { id: string; name: string }): TypedWake {
  const path = line.frames
    .slice(0, 3)
    .map((frame) => `${frame.name}@${frame.file}:${frame.line}`)
    .join("<");
  return {
    facts: {
      kind: "freeze-recorded",
      project: { id: project.id, name: project.name },
      at: line.at,
      wallMs: line.wallMs,
      cpuMs: line.cpuMs,
      frames: line.frames,
      ...(line.uncertain ? { uncertain: line.uncertain } : {}),
    },
    once: `freeze-recorded:${path || "unnamed"}`,
  };
}

/**
 * The watchdog, run as a worker thread from source so no build step or
 * packaged archive stands between the app and it. It reads the main thread's
 * heartbeats, each carrying `process.threadCpuUsage()`. It keeps the
 * inspector's debugger on the main thread enabled from the start, and on a
 * missed heartbeat pauses the main thread once for its call frames and
 * resumes it. Enabled only after the stall, a wait's pause landed in code
 * that ran after the wait (INF-2061's lab); enabled ahead it costs the main
 * thread about 10 microseconds per script it compiles, and nothing on code
 * already running (docs/freeze-recorder.md). The line is written when the stall ends, when the
 * next heartbeat brings the processor time it took. A gap the watchdog's own
 * timer also slept through is the whole computer pausing, such as sleep, and
 * is no freeze.
 */
const WATCHDOG_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const { recordPath, thresholdMs, watchMs, maxLines, lateMs } = workerData;

const session = new inspector.Session();
session.connectToMainThread();
let enabled = false;
const scripts = new Map();
session.on("Debugger.scriptParsed", (message) => {
  if (message.params.url) scripts.set(message.params.scriptId, message.params.url);
});
session.post("Debugger.enable", (error) => {
  enabled = !error;
});

let lines = 0;
try {
  lines = fs.readFileSync(recordPath, "utf8").split("\n").filter(Boolean).length;
} catch {}

let beatAt = Date.now();
let beatCpu = null;
let tickAt = Date.now();
let stall = null;
let capturing = null;

const cpuOf = (usage) => usage.user + usage.system;

function write(done) {
  if (done.written) return;
  done.written = true;
  clearTimeout(done.timer);
  if (capturing === done) capturing = null;
  const wallMs = Math.max(0, Math.round(done.endedAt - done.startedAt));
  const cpuMs = Math.max(0, Math.round((cpuOf(done.cpuAfter) - cpuOf(done.cpuBefore)) / 1000));
  const uncertain = cpuMs * 2 < wallMs ? "waited" : done.late ? "late" : undefined;
  const line = { at: new Date(done.startedAt).toISOString(), wallMs, cpuMs, frames: done.frames || [] };
  if (uncertain) line.uncertain = uncertain;
  try {
    fs.appendFileSync(recordPath, JSON.stringify(line) + "\n");
    lines += 1;
    if (lines > maxLines) {
      const kept = fs.readFileSync(recordPath, "utf8").split("\n").filter(Boolean).slice(-maxLines);
      fs.writeFileSync(recordPath, kept.join("\n") + "\n");
      lines = kept.length;
    }
  } catch {}
  parentPort.postMessage(line);
}

session.on("Debugger.paused", (message) => {
  const target = capturing;
  capturing = null;
  const frames = message.params.callFrames.map((frame) => ({
    name: frame.functionName || "(anonymous)",
    file: (frame.url || scripts.get(frame.location.scriptId) || "").split("/").pop() || "(unknown)",
    line: frame.location.lineNumber + 1,
    column: frame.location.columnNumber + 1,
  }));
  session.post("Debugger.resume");
  if (!target) return;
  target.frames = frames;
  if (target.endedAt !== undefined) {
    target.late = true;
    write(target);
  }
});

function capture(target) {
  if (capturing || !enabled) return;
  capturing = target;
  session.post("Debugger.pause");
}

parentPort.on("message", (beat) => {
  const now = Date.now();
  if (stall) {
    const done = stall;
    stall = null;
    done.endedAt = now;
    done.cpuAfter = beat.cpu;
    if (done.frames || capturing !== done) write(done);
    else done.timer = setTimeout(() => write(done), lateMs);
  }
  beatAt = now;
  beatCpu = beat.cpu;
});

setInterval(() => {
  const now = Date.now();
  const slept = now - tickAt >= thresholdMs;
  tickAt = now;
  if (slept) {
    if (!stall) beatAt = now;
    return;
  }
  if (stall || beatCpu === null || now - beatAt < thresholdMs) return;
  stall = { startedAt: beatAt, cpuBefore: beatCpu };
  capture(stall);
}, watchMs);
`;

/**
 * The recorder's main-thread half: it starts the watchdog, beats every
 * `HEARTBEAT_MS` with the main thread's own processor time, and hands each
 * recorded line to `onFreeze`. A watchdog that fails stops the recorder and
 * never the app.
 */
export class FreezeRecorder {
  private worker: Worker | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      recordPath: string;
      onFreeze: (line: FreezeLine) => void;
      thresholdMs?: number;
    },
  ) {}

  start(): void {
    if (this.worker) return;
    let worker: Worker;
    try {
      worker = new Worker(WATCHDOG_SOURCE, {
        eval: true,
        workerData: {
          recordPath: this.options.recordPath,
          thresholdMs: this.options.thresholdMs ?? FREEZE_THRESHOLD_MS,
          watchMs: WATCH_MS,
          maxLines: RECORD_MAX_LINES,
          lateMs: LATE_NAMES_MS,
        },
      });
    } catch {
      return;
    }
    this.worker = worker;
    worker.on("message", (message: unknown) => {
      const line = freezeLineSchema.safeParse(message);
      if (line.success) this.options.onFreeze(line.data);
    });
    worker.on("error", () => this.stop());
    worker.unref();
    const beat = () => worker.postMessage({ cpu: process.threadCpuUsage() });
    beat();
    this.beat = setInterval(beat, HEARTBEAT_MS);
    this.beat.unref();
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}
