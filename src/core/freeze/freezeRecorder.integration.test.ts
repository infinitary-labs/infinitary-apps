import { spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFreezes } from "../../../tests/helpers/freezeRecord";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import {
  FREEZE_THRESHOLD_MS,
  type FreezeIncident,
  type FreezeLine,
  FreezeRecorder,
  RECORD_MAX_LINES,
  type WindowState,
} from "./freezeRecorder";
import { FreezeTally, type VersionSummary } from "./freezeTally";
import { readMemoryRecord } from "./memoryRecorder";
import { armWatchdog } from "./watchdog";

// INF-2066, INF-2061's approved plan: "A test holds the main thread in a
// named function and finds that function in the record." It reads the
// record's lines and their order, never a wall-clock budget. It reads the
// record through `readFreezes`, as every reader does: beside the line a case
// looks for, the record can hold the start of a later stall still underway,
// such as one a busy runner causes while the case reads it (INF-2205).

// Each case holds the main thread 800 ms on the real clock; its fastest
// measured run is 1.1 s, and 1.4 s for the case that first loads 30 MB of
// source (docs/test-cohorts.md, "Budgets").
vi.setConfig({ testTimeout: 10_000 });

let recorder: FreezeRecorder | undefined;
afterEach(() => {
  recorder?.stop();
  recorder = undefined;
});

/**
 * Starts a recorder on a scratch record, on a watchdog armed first, as the
 * app's entry arms it (src/main/index.ts): arming returns once the watchdog's
 * debugger is on, so the recorder names a stall from its first heartbeat.
 * Left unarmed, the recorder starts its own watchdog, whose debugger comes on
 * only after the watchdog thread has started; on a busy computer that came
 * after the stall had begun, which was then recorded with no names (INF-2515).
 * `arm: false` leaves the arming to the test, for one that arms before it
 * loads code. `hold` then holds the main thread at once, and the answer is the
 * line recorded for it: the first completed one. The recorder beats as it
 * starts and the watchdog records nothing before that beat, so with no turn
 * of the event loop between the beat and the hold, the first stall it records
 * is the one the hold makes, however late a busy runner runs the test. Given
 * a turn there, a busy runner could leave the last beat well before the hold,
 * or stall the main thread itself, and a case could wait for the line of a
 * stall that never came.
 */
async function recordStall(
  recordPath: string,
  hold: () => void,
  { arm = true, windowState }: { arm?: boolean; windowState?: () => WindowState } = {},
): Promise<FreezeLine> {
  const lines: FreezeLine[] = [];
  const waiters: (() => void)[] = [];
  if (arm) armWatchdog();
  recorder = new FreezeRecorder({
    recordPath,
    build: {
      computer: "disposable recorder process",
      version: "test",
      commit: null,
      mutable: true,
    },
    ...(windowState ? { windowState } : {}),
    onFreeze: (line) => {
      if ("wallMs" in line) lines.push(line);
      for (const wake of waiters.splice(0)) wake();
    },
  });
  recorder.start();
  hold();
  for (;;) {
    const [line] = lines;
    if (line) return line;
    await new Promise<void>((done) => waiters.push(done));
  }
}

/** Busy work on the main thread, the way a long synchronous database walk is. */
function walkEveryRow(ms: number): number {
  const until = Date.now() + ms;
  let sum = 0;
  while (Date.now() < until) sum += Math.sqrt(sum + 1);
  return sum;
}

function renderOpenMessages(ms: number): number {
  return walkEveryRow(ms);
}

/** The code `loadAppSizedCode` loaded, kept loaded as the app's modules stay. */
let appCode: unknown[] = [];
afterEach(() => {
  appCode = [];
});

/**
 * Loads as much source as the app's main process holds - 30 MB in 2,000
 * scripts, beside its 33 MB in 2,880 (INF-2071) - each a script of its own
 * named functions. Enabling the debugger after this reads all of it at once.
 */
function loadAppSizedCode(): void {
  for (let script = 0; script < 2_000; script += 1) {
    let source = "";
    for (let each = 0; source.length < 15_000; each += 1) {
      source += `function part${script}_${each}(a, b) { let sum = 0; for (let k = 0; k < a; k += 1) sum += (k * ${each}) % (b + 1); return sum; }\n`;
    }
    appCode.push(runInThisContext(`(() => { ${source} return part${script}_0; })()`));
  }
}

describe("the freeze recorder", () => {
  // INF-3896's piece 4, the captain's pick: "Record whether the window was
  // hidden and how fast the main thread ran, at each pause."
  it("notes whether the window was shown and how fast the main thread ran at a pause", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-context-"), "freezes.jsonl");
    const seen = await recordStall(recordPath, () => walkEveryRow(FREEZE_THRESHOLD_MS * 4), {
      windowState: () => "hidden",
    });

    expect(seen.window).toBe("hidden");
    const speed = seen.speed;
    expect(speed?.beforeNs).toBeGreaterThan(0);
    expect(speed?.afterNs).toBeGreaterThan(0);
    expect(speed?.fastestNs).toBeGreaterThan(0);
    expect(speed?.fastestNs).toBeLessThanOrEqual(speed?.beforeNs ?? 0);
    expect(speed?.fastestNs).toBeLessThanOrEqual(speed?.afterNs ?? 0);
    const [written] = readFreezes(recordPath).filter((line) => line.incidentId === seen.incidentId);
    expect(written).toMatchObject({ window: "hidden", speed });
  });

  it("records a main thread stall with the function that held it, innermost first", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-busy-"), "freezes.jsonl");
    const seen = await recordStall(recordPath, () => renderOpenMessages(FREEZE_THRESHOLD_MS * 8));

    const names = seen.frames.map((frame) => frame.name);
    expect(names).toContain("walkEveryRow");
    expect(names.indexOf("walkEveryRow")).toBeLessThan(names.indexOf("renderOpenMessages"));
    expect(seen.frames[names.indexOf("walkEveryRow")]?.file).toBe(
      "freezeRecorder.integration.test.ts",
    );
    expect(seen.wallMs).toBeGreaterThanOrEqual(FREEZE_THRESHOLD_MS);
    // Busy work is the main thread's own processor time. How much of the
    // wall time it fills depends on the computer's load: a shared runner
    // that preempts the busy loop can leave it under half, marked waited.
    expect(seen.cpuMs).toBeGreaterThan(0);
    expect(seen.status).toBe("completed");
    expect(seen.incidentId).toBeTruthy();
    expect(seen.completedAt).toBeTruthy();
    expect(Date.parse(seen.captureRequestedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(seen.at));
    expect(Date.parse(seen.capturedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(seen.captureRequestedAt ?? ""),
    );
    expect(readFreezes(recordPath)).toContainEqual(seen);
  });

  it("names a stall as the recorder starts, armed before the app's own code loaded", async () => {
    // INF-2071: the app's entry arms the watchdog before the app's code
    // loads, and the core starts the recorder on it later. Its debugger is
    // on by then, so a stall from the recorder's first heartbeat is named.
    // Enabled only as the recorder started, it read all that code then and
    // left the stall that began with it unnamed.
    armWatchdog();
    loadAppSizedCode();
    const recordPath = join(scratchDir("infinitary-freeze-armed-"), "freezes.jsonl");
    const seen = await recordStall(recordPath, () => renderOpenMessages(FREEZE_THRESHOLD_MS * 8), {
      arm: false,
    });

    const names = seen.frames.map((frame) => frame.name);
    expect(names).toContain("walkEveryRow");
    expect(names.indexOf("walkEveryRow")).toBeLessThan(names.indexOf("renderOpenMessages"));
    expect(readFreezes(recordPath)).toContainEqual(seen);
  });

  // INF-2262: native CPU work can defer the inspector to subsequent short JS.
  // The observed location is retained without claiming where V8 must pause.
  it("retains capture timing through high-CPU native work followed by short JavaScript", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-native-"), "freezes.jsonl");
    let result = 0;
    const seen = await recordStall(recordPath, () => {
      const derived = pbkdf2Sync("disposable input", "disposable salt", 2_000_000, 32, "sha256");
      result = derived.readUInt8(0);
    });
    expect(result).toBeGreaterThanOrEqual(0);
    expect(seen.cpuMs).toBeGreaterThan(0);
    expect(Date.parse(seen.captureRequestedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(seen.at));
    expect(Date.parse(seen.capturedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(seen.captureRequestedAt ?? ""),
    );
    expect(seen.build).toEqual({
      computer: "disposable recorder process",
      version: "test",
      commit: null,
      mutable: true,
    });
    expect(readFreezes(recordPath)).toContainEqual(seen);
    console.log("Native work capture (location, not cause):", JSON.stringify(seen));
  });

  it("marks a wait's names as uncertain by its low processor time", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-wait-"), "freezes.jsonl");
    // A synchronous wait outside JavaScript, as on another program.
    const seen = await recordStall(recordPath, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FREEZE_THRESHOLD_MS * 8);
    });

    expect(seen.uncertain).toBe("waited");
    expect(seen.cpuMs * 2).toBeLessThan(seen.wallMs);
    expect(readFreezes(recordPath)).toContainEqual(seen);
  });

  it("completes the same incident whose start was visible before recovery (INF-2205)", async () => {
    const dir = scratchDir("infinitary-freeze-start-");
    const recordPath = join(dir, "freezes.jsonl");
    const release = new Int32Array(new SharedArrayBuffer(4));
    const observer = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      // It reads the record every millisecond, not on file events: on a Mac a
      // directory's watch delivers events only once it is live, which can be
      // after the watchdog wrote the start, and the start was never seen.
      const reading = setInterval(() => {
        if (!fs.existsSync(workerData.path)) return;
        const start = fs.readFileSync(workerData.path, "utf8").split("\\n").filter(Boolean)
          .map(JSON.parse).find(line => line.status === "started");
        if (!start) return;
        clearInterval(reading);
        parentPort.postMessage(start);
        Atomics.store(workerData.release, 0, 1);
        Atomics.notify(workerData.release, 0);
      });
      parentPort.postMessage("ready");
    `,
      { eval: true, workerData: { path: recordPath, release } },
    );
    try {
      // The observer reads before the recorder starts, so the hold follows
      // the recorder's first heartbeat with nothing between them.
      await once(observer, "message");
      const observed = once(observer, "message");
      const completed = await recordStall(recordPath, () => Atomics.wait(release, 0, 0, 3000));
      const [start] = await observed;
      expect(start).toEqual({
        incidentId: completed.incidentId,
        at: completed.at,
        status: "started",
        build: completed.build,
        ...(start.captureRequestedAt ? { captureRequestedAt: completed.captureRequestedAt } : {}),
        ...(start.capturedAt ? { capturedAt: completed.capturedAt } : {}),
        // The start has the speed before the stall; only the completion has the after.
        speed: { beforeNs: completed.speed?.beforeNs, fastestNs: start.speed?.fastestNs },
      });
      expect(readFreezes(recordPath)).toContainEqual(completed);
      console.info("Start observed before recovery:", JSON.stringify(start));
      console.info("Same incident completed:", JSON.stringify(completed));
    } finally {
      await observer.terminate();
    }
  });

  it("retains start before a native wait replies, then interruption after process death (INF-2205)", async () => {
    // Real recorder in a disposable Node process: no personal app or data.
    // Reuses the synchronous-wait fixture above, but never releases the wait.
    // The process enters the wait as soon as its recorder starts, so the
    // watchdog gets one heartbeat and records one stall, which never ends.
    // Given time to beat first, the process could stall before the wait, as
    // a busy runner makes it, and that stall could be the started line the
    // case reads, end before the kill and leave nothing to interrupt
    // (INF-2974).
    const dir = scratchDir("infinitary-freeze-interrupted-");
    const ENDED = "0.0.1-alpha.1";
    const recordPath = join(dir, "freezes.jsonl");
    const root = resolve(__dirname, "../../..");
    await build({
      configFile: false,
      logLevel: "silent",
      root,
      resolve: { alias: { "@shared": resolve(root, "src/shared") } },
      ssr: { noExternal: true, target: "node" },
      build: {
        ssr: resolve(__dirname, "freezeRecorder.ts"),
        outDir: dir,
        emptyOutDir: false,
        minify: false,
        target: "node24",
        rollupOptions: { output: { format: "es", entryFileNames: "recorder.mjs" } },
      },
    });
    const entry = join(dir, "wait.mjs");
    writeFileSync(
      entry,
      `import { FreezeRecorder } from "./recorder.mjs";
      const recorder = new FreezeRecorder({
        recordPath: process.argv[2],
        build: { computer: "disposable recorder process", version: "${ENDED}", commit: null, mutable: true },
        onFreeze() {},
      });
      recorder.start();
      console.log("waiting");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    );
    const child = spawn(process.execPath, [entry, recordPath], {
      env: hostEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ended = once(child, "exit");
    try {
      await once(child.stdout, "data");
      // It reads the record every millisecond, not on file events: on a Mac a
      // directory's watch delivers events only once it is live, which can be
      // after the watchdog wrote the start, and the start was never seen.
      const started = await new Promise<FreezeIncident>((done) => {
        const reading = setInterval(() => {
          if (!existsSync(recordPath)) return;
          const found = readFreezes(recordPath).find((line) => line.status === "started");
          if (found) {
            clearInterval(reading);
            done(found);
          }
        }, 1);
      });
      expect(started).not.toHaveProperty("wallMs");
      expect(started).not.toHaveProperty("cpuMs");
      expect(started).not.toHaveProperty("frames");
      console.info("Before native wait replies:", JSON.stringify(started));
      child.kill("SIGKILL");
      await ended;
      // The next version's first start recovers the stall, then summarizes
      // the version that had it, counting it (INF-3044).
      let interrupted: FreezeIncident | undefined;
      const summaries = await new Promise<VersionSummary[]>((done) => {
        recorder = new FreezeRecorder({
          recordPath,
          onFreeze: (line) => {
            interrupted ??= line;
          },
          tally: new FreezeTally(join(dir, "freeze-tally.json"), `${ENDED}-next`),
          onVersionsEnded: done,
        });
        recorder.start();
      });
      if (!interrupted) throw new Error("no stall was recovered before the summary");
      expect(summaries).toMatchObject([
        { version: ENDED, interrupted: 1, stalls: 0, example: { incidentId: started.incidentId } },
      ]);
      expect(interrupted).toMatchObject({ ...started, status: "interrupted" });
      expect(interrupted).toHaveProperty("interruptedAt");
      expect(interrupted).not.toHaveProperty("completedAt");
      expect(interrupted).not.toHaveProperty("wallMs");
      expect(interrupted).not.toHaveProperty("cpuMs");
      const kept = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(kept).toContainEqual(interrupted);
      expect(kept.filter((line) => line.incidentId === started.incidentId)).toEqual([interrupted]);
      console.info("After isolated process restart:", JSON.stringify(interrupted));
    } finally {
      child.kill("SIGKILL");
      await ended;
    }
  });

  it("keeps the newest lines and drops the oldest once the record is full", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-full-"), "freezes.jsonl");
    const old: FreezeLine[] = Array.from({ length: RECORD_MAX_LINES }, (_, index) => ({
      at: new Date(Date.UTC(2026, 9, 31, 0, 0, index)).toISOString(),
      wallMs: 1_020,
      cpuMs: 990,
      frames: [{ name: "taskIdsWithRef", file: "index.js", line: 4021, column: 17 }],
    }));
    writeFileSync(recordPath, `${old.map((each) => JSON.stringify(each)).join("\n")}\n`);
    const seen = await recordStall(recordPath, () => renderOpenMessages(FREEZE_THRESHOLD_MS * 8));

    const record = readFreezes(recordPath);
    expect(record).toHaveLength(RECORD_MAX_LINES);
    expect(record).toContainEqual(seen);
    expect(record).not.toContainEqual(old[0]);
    expect(record).toContainEqual(old.at(-1));
  });
});

// INF-2392's plan, step 1: the alpha recorder also reads the main process's
// memory, split between native and JavaScript, from the moment it starts.
describe("the recorder's memory reading", () => {
  it("starts with the recorder and takes a reading at once", async () => {
    const recordPath = join(scratchDir("infinitary-memory-start-"), "memory.jsonl");
    const footprint = vi.fn(async () => 1024 * 1024 * 1024);
    recorder = new FreezeRecorder({
      recordPath: join(scratchDir("infinitary-memory-freeze-"), "freezes.jsonl"),
      onFreeze: () => {},
      memory: { recordPath, footprint },
    });
    recorder.start();
    await expect.poll(() => readMemoryRecord(recordPath)).toHaveLength(1);
    expect(readMemoryRecord(recordPath)[0]).toMatchObject({
      pid: process.pid,
      footprintBytes: 1024 * 1024 * 1024,
    });
    expect(footprint).toHaveBeenCalledOnce();
  });
});
