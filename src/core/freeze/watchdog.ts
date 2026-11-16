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
 * How long arming waits for the watchdog to start and connect to the main
 * thread. A physical bound, not a judgment: armed before the app's code
 * loads, a watchdog thread starts in tens of milliseconds, and one that
 * cannot never holds the app's start longer than this.
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
 * packaged archive stands between the app and it. It connects an inspector
 * session to the main thread as it starts and says so through `armed`,
 * which the main thread waits on (`armWatchdog`). It watches only once the
 * recorder hands it its record (`{ record }`), then reads the main thread's
 * heartbeats, each carrying `process.threadCpuUsage()`, and on a missed one
 * asks the main thread once for its call path. The main thread answers
 * where it is running, reading its stack frames and nothing else: a
 * debugger pause, which this used, read every frame's scopes on the main
 * thread and added tens of milliseconds to the stall it named (INF-4535).
 * Once it has handed over a previous run's
 * unfinished stalls it says `{ recovered: true }`. The incident start is written before asking for names; completion adds the
 * processor time when the next heartbeat arrives, the main thread's garbage
 * collections that heartbeat says ran since the one before, and the
 * process's page faults and resident memory across the stall. Each line notes the newest
 * time the computer slept, seen as its wall clock running on past the
 * monotonic one, which stops in sleep. A gap the watchdog's
 * own timer also slept through is the whole computer pausing, such as
 * sleep, and is no freeze.
 */
const WATCHDOG_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { watchMs, lateMs, armed } = workerData;

function sayArmed(state) {
  Atomics.store(armed, 0, state);
  Atomics.notify(armed, 0);
}

let enabled = false;
const session = new inspector.Session();
try {
  session.connectToMainThread();
  enabled = true;
  sayArmed(1);
} catch {
  sayArmed(2);
}

// The call path, innermost first, read on the main thread where it is
// running when V8 next lets the inspector in. Node's getCallSites asks V8
// for the stack's frames alone: it reads no scope, formats no error and
// leaves the app's own stack settings untouched, so it names a stall held
// inside the app's own error formatting too. It reads the innermost 200
// frames, the most it gives, and leaves out this script's own.
function readCallPath() {
  const sites = process.getBuiltinModule("node:util").getCallSites(200);
  const own = sites.find((site) => site.functionName === "readCallPath")?.scriptId;
  const frames = [];
  for (const site of sites) {
    if (site.scriptId === own) continue;
    frames.push({
      name: site.functionName || "(anonymous)",
      file: String(site.scriptName || "").split("/").pop() || "(unknown)",
      line: site.lineNumber,
      column: site.columnNumber ?? site.column,
    });
  }
  return frames;
}
const READ_CALL_PATH = "(" + readCallPath.toString() + ")()\n//# sourceURL=infinitary-freeze-capture";

let record = null;
let lines = [];
let beatAt = performance.now();
let beatWall = Date.now();
let beatCpu = null;
let beatProbe = null;
let fastestProbe = null;
let windowState = null;
// The minute pass's step running and the steps whose work is unsettled, as
// the main thread last said (./passSteps.ts), and its pass record.
let stepMark = null;
let passLines = null;
let passWriting = Promise.resolve();
let tickAt = performance.now();
let tickWall = Date.now();
// The newest time the computer slept: the wall clock ran on while the
// monotonic one, which stops while the computer sleeps, did not.
let lastSleep = null;
// The process's page faults and resident memory at the last heartbeat, read
// here, since both are the whole process's, to see memory paged back in.
let beatMemory = null;
let stall = null;
let capturing = null;

const cpuOf = (usage) => usage.user + usage.system;

function memoryNow() {
  const usage = process.resourceUsage();
  return { major: usage.majorPageFault, minor: usage.minorPageFault, rss: process.memoryUsage.rss() };
}

// What the main thread's heartbeats said about the windows and its speed
// just before a stall, and the speed in the heartbeat that ended it.
function noteContext(line, target) {
  if (target.window) line.window = target.window;
  if (target.step) line.step = target.step;
  if (lastSleep) line.sleep = { ...lastSleep };
  if (target.gc) line.gc = { ...target.gc };
  if (target.memoryBefore && target.memoryAfter) {
    line.paging = {
      majorFaults: Math.max(0, target.memoryAfter.major - target.memoryBefore.major),
      minorFaults: Math.max(0, target.memoryAfter.minor - target.memoryBefore.minor),
      rssBeforeBytes: target.memoryBefore.rss,
      rssAfterBytes: target.memoryAfter.rss,
    };
  }
  if (target.probeBefore !== undefined && fastestProbe !== null) {
    line.speed = { beforeNs: target.probeBefore, fastestNs: fastestProbe };
    if (target.probeAfter !== undefined) line.speed.afterNs = target.probeAfter;
  }
}

// Replace an incident's snapshot atomically: a crash keeps either its start
// or its final facts, never half a JSON line. Legacy lines retain their shape.
function persist(line) {
  const index = line.incidentId ? lines.findIndex((text) => {
    try { return JSON.parse(text).incidentId === line.incidentId; } catch { return false; }
  }) : -1;
  if (index < 0) lines.push(JSON.stringify(line));
  else lines[index] = JSON.stringify(line);
  lines = lines.slice(-record.maxLines);
  try {
    fs.writeFileSync(record.path + ".next", lines.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(record.path + ".next", record.path);
  } catch {}
}

// The pass record is written off this thread's timer, in turn, so a large
// file never holds the watch long enough to look like the computer slept.
function writePass(pass) {
  const line = { at: pass.at, steps: pass.steps };
  if (record.build) line.build = record.build;
  passWriting = passWriting.then(async () => {
    if (passLines === null) {
      try {
        passLines = (await fs.promises.readFile(record.passPath, "utf8")).split("\n").filter(Boolean);
      } catch {
        passLines = [];
      }
    }
    passLines.push(JSON.stringify(line));
    passLines = passLines.slice(-record.passMaxLines);
    try {
      await fs.promises.writeFile(record.passPath + ".next", passLines.join("\n") + "\n", { mode: 0o600 });
      await fs.promises.rename(record.passPath + ".next", record.passPath);
    } catch {}
  });
}

function write(done) {
  if (done.written) return;
  done.written = true;
  clearTimeout(done.timer);
  if (capturing === done) capturing = null;
  const wallMs = Math.max(0, Math.round(done.endedAt - done.startedAt));
  const cpuMs = Math.max(0, Math.round((cpuOf(done.cpuAfter) - cpuOf(done.cpuBefore)) / 1000));
  const uncertain = cpuMs * 2 < wallMs ? "waited" : done.late ? "late" : undefined;
  const line = { incidentId: done.incidentId, status: "completed", at: done.at,
    completedAt: done.completedAt, wallMs, cpuMs, frames: done.frames || [] };
  if (record.build) line.build = record.build;
  if (done.captureRequestedAt !== undefined) line.captureRequestedAt = new Date(done.captureRequestedAt).toISOString();
  if (done.capturedAt !== undefined) line.capturedAt = new Date(done.capturedAt).toISOString();
  if (uncertain) line.uncertain = uncertain;
  noteContext(line, done);
  persist(line);
  parentPort.postMessage(line);
}

function persistStarted(target) {
  const line = { incidentId: target.incidentId, status: "started", at: target.at };
  if (record.build) line.build = record.build;
  if (target.captureRequestedAt !== undefined) line.captureRequestedAt = new Date(target.captureRequestedAt).toISOString();
  if (target.capturedAt !== undefined) line.capturedAt = new Date(target.capturedAt).toISOString();
  noteContext(line, target);
  persist(line);
}

function capture(target) {
  if (capturing || !enabled) return;
  capturing = target;
  target.captureRequestedAt = Date.now();
  persistStarted(target);
  session.post("Runtime.evaluate", { expression: READ_CALL_PATH, returnByValue: true, silent: true }, (error, answer) => {
    // An answer after the line was written without names is not this one's.
    if (capturing !== target) return;
    capturing = null;
    const frames = !error && answer && !answer.exceptionDetails && answer.result ? answer.result.value : undefined;
    if (!Array.isArray(frames)) {
      if (target.endedAt !== undefined) write(target);
      return;
    }
    target.capturedAt = Date.now();
    target.frames = frames;
    if (target.endedAt === undefined) persistStarted(target);
    if (target.endedAt !== undefined) {
      target.late = true;
      write(target);
    }
  });
}

parentPort.on("message", (message) => {
  if (message.record) {
    record = message.record;
    try {
      lines = fs.readFileSync(record.path, "utf8").split("\n").filter(Boolean);
    } catch {}
    // A previous process never reported recovery. The observation is now,
    // not an invented stall end, duration, CPU reading or call path.
    for (const text of [...lines]) {
      let line;
      try { line = JSON.parse(text); } catch { continue; }
      if (line.status !== "started" || typeof line.incidentId !== "string") continue;
      const interrupted = { ...line, status: "interrupted", interruptedAt: new Date().toISOString() };
      persist(interrupted);
      parentPort.postMessage(interrupted);
    }
    parentPort.postMessage({ recovered: true });
    return;
  }
  // A step mark or a finished pass is not a heartbeat.
  if (message.steps) {
    stepMark = message.steps;
    return;
  }
  if (message.pass) {
    if (record && record.passPath) writePass(message.pass);
    return;
  }
  const now = performance.now();
  if (message.window) windowState = message.window;
  const probe = typeof message.probeNs === "number" ? Math.round(message.probeNs) : null;
  if (probe !== null && (fastestProbe === null || probe < fastestProbe)) fastestProbe = probe;
  if (stall) {
    const done = stall;
    stall = null;
    done.endedAt = now;
    done.cpuAfter = message.cpu;
    // The collections the main thread ran since its heartbeat before the stall.
    if (message.gc) done.gc = message.gc;
    done.memoryAfter = memoryNow();
    if (probe !== null) done.probeAfter = probe;
    done.completedAt = new Date().toISOString();
    if (done.frames || capturing !== done) write(done);
    else done.timer = setTimeout(() => write(done), lateMs);
  }
  beatAt = now;
  beatWall = Date.now();
  beatCpu = message.cpu;
  beatProbe = probe;
  beatMemory = memoryNow();
});

setInterval(() => {
  const now = performance.now();
  const wall = Date.now();
  const slept = record !== null && now - tickAt >= record.thresholdMs;
  const asleepMs = wall - tickWall - (now - tickAt);
  if (record !== null && asleepMs >= record.thresholdMs) {
    lastSleep = { wokeAt: new Date(wall).toISOString(), sleptMs: Math.round(asleepMs) };
  }
  tickAt = now;
  tickWall = wall;
  if (!record) return;
  if (slept) {
    if (!stall) beatAt = now;
    return;
  }
  if (stall || beatCpu === null || now - beatAt < record.thresholdMs) return;
  stall = { incidentId: randomUUID(), at: new Date(beatWall).toISOString(), startedAt: beatAt, cpuBefore: beatCpu };
  if (windowState) stall.window = windowState;
  if (beatProbe !== null) stall.probeBefore = beatProbe;
  if (beatMemory) stall.memoryBefore = beatMemory;
  if (stepMark && (stepMark.running || stepMark.unsettled.length)) {
    stall.step = {};
    if (stepMark.running) stall.step.running = stepMark.running;
    if (stepMark.unsettled.length) stall.step.unsettled = [...stepMark.unsettled];
  }
  // This write must precede the inspector request: native waits may never
  // answer it, and the whole process may end before another heartbeat.
  persistStarted(stall);
  capture(stall);
}, watchMs);
`;

/** The watchdog the main entry armed, until a recorder takes it. */
let armed: Worker | undefined;

/**
 * Starts the watchdog. `wait` waits until it has connected to the main
 * thread; otherwise it connects while the main thread goes on.
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
 * app's own code loads (src/main/index.ts), so the recorder that takes it
 * names a stall from its first moment. Reading a call path reads no
 * script, so the code loaded after arming costs it nothing. It watches
 * nothing until the recorder starts.
 */
export function armWatchdog(): void {
  armed ??= startWatchdog(true);
}

/**
 * The watchdog for a recorder that starts now: the one armed before the
 * app's code loaded, handed over once, or, where nothing armed one, such as
 * a core run in plain Node, one started here that connects while the
 * recorder already watches.
 */
export function takeWatchdog(): Worker | undefined {
  const worker = armed ?? startWatchdog(false);
  armed = undefined;
  return worker;
}
