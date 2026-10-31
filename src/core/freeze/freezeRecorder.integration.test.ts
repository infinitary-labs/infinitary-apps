import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  FREEZE_THRESHOLD_MS,
  type FreezeLine,
  FreezeRecorder,
  freezeLineSchema,
  HEARTBEAT_MS,
  RECORD_MAX_LINES,
} from "./freezeRecorder";

// INF-2066, INF-2061's approved plan: "A test holds the main thread in a
// named function and finds that function in the record." It reads the
// record's lines and their order, never a wall-clock budget.

// Each case holds the main thread 800 ms on the real clock; its fastest
// measured run is 1.1 s (docs/test-cohorts.md, "Budgets").
vi.setConfig({ testTimeout: 10_000 });

let recorder: FreezeRecorder | undefined;
afterEach(() => {
  recorder?.stop();
  recorder = undefined;
});

/**
 * Starts a recorder on a scratch record. `stall` holds the main thread and
 * answers the line recorded for it: the first one that began no earlier than
 * the heartbeat before the stall, so a stall the test runner itself caused
 * while starting is not taken for it.
 */
async function startRecorder(
  recordPath: string,
): Promise<{ stall: (hold: () => void) => Promise<FreezeLine> }> {
  const lines: FreezeLine[] = [];
  const waiters: (() => void)[] = [];
  recorder = new FreezeRecorder({
    recordPath,
    onFreeze: (line) => {
      lines.push(line);
      for (const wake of waiters.splice(0)) wake();
    },
  });
  recorder.start();
  // The watchdog needs a heartbeat or two before it can tell a missed one.
  await new Promise((done) => setTimeout(done, FREEZE_THRESHOLD_MS * 3));
  return {
    stall: async (hold) => {
      const since = Date.now() - HEARTBEAT_MS * 2;
      hold();
      for (;;) {
        const line = lines.find((each) => Date.parse(each.at) >= since);
        if (line) return line;
        await new Promise<void>((done) => waiters.push(done));
      }
    },
  };
}

function readRecord(recordPath: string): FreezeLine[] {
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => freezeLineSchema.parse(JSON.parse(text)));
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

describe("the freeze recorder", () => {
  it("records a main thread stall with the function that held it, innermost first", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-busy-"), "freezes.jsonl");
    const { stall } = await startRecorder(recordPath);
    const seen = await stall(() => renderOpenMessages(FREEZE_THRESHOLD_MS * 8));

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
    expect(readRecord(recordPath)).toContainEqual(seen);
  });

  it("marks a wait's names as uncertain by its low processor time", async () => {
    const recordPath = join(scratchDir("infinitary-freeze-wait-"), "freezes.jsonl");
    const { stall } = await startRecorder(recordPath);
    // A synchronous wait outside JavaScript, as on another program.
    const seen = await stall(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FREEZE_THRESHOLD_MS * 8);
    });

    expect(seen.uncertain).toBe("waited");
    expect(seen.cpuMs * 2).toBeLessThan(seen.wallMs);
    expect(readRecord(recordPath)).toContainEqual(seen);
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
    const { stall } = await startRecorder(recordPath);
    const seen = await stall(() => renderOpenMessages(FREEZE_THRESHOLD_MS * 8));

    const record = readRecord(recordPath);
    expect(record).toHaveLength(RECORD_MAX_LINES);
    expect(record).toContainEqual(seen);
    expect(record).not.toContainEqual(old[0]);
    expect(record).toContainEqual(old.at(-1));
  });
});
