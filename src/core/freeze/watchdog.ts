import { Worker } from "node:worker_threads";
import { settingFrom } from "@shared/envSettings";
import { isAlphaVersion } from "../update/semver";

/**
 * The freeze recorder's watchdog (docs/freeze-recorder.md), kept apart from
 * the record's shape and the first mate's wake so the app's main entry can
 * arm it before the app's own code loads: this module loads nothing a
 * script of any size comes from.
 */

/** How often the watchdog looks at the heartbeat. */
const WATCH_MS = 20;
/** How long the watchdog waits for a call path after the stall ended before writing the line without one. */
const LATE_NAMES_MS = 1_000;
/**
 * How long arming waits for the watchdog's debugger. A physical bound, not a
 * judgment: armed before the app's code loads, a watchdog thread starts and
 * enables its debugger in tens of milliseconds, and one that cannot never
 * holds the app's start longer than this; its recorder then records without
 * names until the debugger is on.
 */
const ARMING_WAIT_MS = 2_000;

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

/**
 * The watchdog, run as a worker thread from source so no build step or
 * packaged archive stands between the app and it. It enables the
 * inspector's debugger on the main thread as it starts and says so through
 * `armed`, which the main thread waits on (`armWatchdog`). It watches only
 * once the recorder hands it its record (`{ record }`), then reads the main
 * thread's heartbeats, each carrying `process.threadCpuUsage()`, and on a
 * missed one pauses the main thread once for its call frames and resumes it.
 * Enabled only after the stall, a wait's pause landed in code that ran after
 * the wait (INF-2061's lab). The line is written when the stall ends, when
 * the next heartbeat brings the processor time it took. A gap the watchdog's
 * own timer also slept through is the whole computer pausing, such as
 * sleep, and is no freeze.
 */
const WATCHDOG_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const { watchMs, lateMs, armed } = workerData;

function sayArmed(state) {
  Atomics.store(armed, 0, state);
  Atomics.notify(armed, 0);
}

let enabled = false;
const scripts = new Map();
const session = new inspector.Session();
try {
  session.connectToMainThread();
  session.on("Debugger.scriptParsed", (message) => {
    if (message.params.url) scripts.set(message.params.scriptId, message.params.url);
  });
  session.post("Debugger.enable", (error) => {
    enabled = !error;
    sayArmed(error ? 2 : 1);
  });
} catch {
  sayArmed(2);
}

let record = null;
let lines = 0;
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
    fs.appendFileSync(record.path, JSON.stringify(line) + "\n");
    lines += 1;
    if (lines > record.maxLines) {
      const kept = fs.readFileSync(record.path, "utf8").split("\n").filter(Boolean).slice(-record.maxLines);
      fs.writeFileSync(record.path, kept.join("\n") + "\n");
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

parentPort.on("message", (message) => {
  if (message.record) {
    record = message.record;
    try {
      lines = fs.readFileSync(record.path, "utf8").split("\n").filter(Boolean).length;
    } catch {}
    return;
  }
  const now = Date.now();
  if (stall) {
    const done = stall;
    stall = null;
    done.endedAt = now;
    done.cpuAfter = message.cpu;
    if (done.frames || capturing !== done) write(done);
    else done.timer = setTimeout(() => write(done), lateMs);
  }
  beatAt = now;
  beatCpu = message.cpu;
});

setInterval(() => {
  const now = Date.now();
  const slept = record !== null && now - tickAt >= record.thresholdMs;
  tickAt = now;
  if (!record) return;
  if (slept) {
    if (!stall) beatAt = now;
    return;
  }
  if (stall || beatCpu === null || now - beatAt < record.thresholdMs) return;
  stall = { startedAt: beatAt, cpuBefore: beatCpu };
  capture(stall);
}, watchMs);
`;

/** The watchdog the main entry armed, until a recorder takes it. */
let armed: Worker | undefined;

/**
 * Starts the watchdog. `wait` waits until its debugger is on, which the
 * main thread answers while it waits; otherwise the debugger comes on while
 * the main thread goes on.
 */
function startWatchdog(wait: boolean): Worker | undefined {
  const state = new Int32Array(new SharedArrayBuffer(4));
  let worker: Worker;
  try {
    worker = new Worker(WATCHDOG_SOURCE, {
      eval: true,
      workerData: { watchMs: WATCH_MS, lateMs: LATE_NAMES_MS, armed: state },
    });
  } catch {
    return undefined;
  }
  worker.unref();
  // A watchdog that fails before a recorder takes it is not handed over.
  worker.on("error", () => {
    if (armed === worker) armed = undefined;
  });
  if (wait) Atomics.wait(state, 0, 0, ARMING_WAIT_MS);
  return worker;
}

/**
 * Arms the watchdog for the recorder this process will start, before the
 * app's own code loads (src/main/index.ts). Enabling the debugger reads
 * every script the main thread has loaded so far at once - in the app's
 * main process, 33 MB of source in 2,880 scripts, 386 to 638 ms of the
 * main thread's own processor time (INF-2071) - and each script loaded
 * after it as that script loads. Armed first, it reads almost nothing at
 * once, and the recorder that takes it names a stall from its first moment.
 * It watches nothing until the recorder starts.
 */
export function armWatchdog(): void {
  armed ??= startWatchdog(true);
}

/**
 * The watchdog for a recorder that starts now: the one armed before the
 * app's code loaded, handed over once, or, where nothing armed one, such as
 * a core run in plain Node, one started here whose debugger comes on while
 * the recorder already watches, so the cost of enabling it is recorded as
 * a stall rather than hidden before the record starts.
 */
export function takeWatchdog(): Worker | undefined {
  const worker = armed ?? startWatchdog(false);
  armed = undefined;
  return worker;
}
