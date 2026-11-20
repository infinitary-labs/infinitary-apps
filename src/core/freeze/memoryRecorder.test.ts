import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { MemoryRecorder, memorySplit, readMemoryRecord } from "./memoryRecorder";

// INF-2392: the main process held 9 GB, 6.6 GB of it native and cold, and an
// outside reading could not tell retained native objects from buffers
// JavaScript still references. The plan's first step: a periodic reading in
// the alpha freeze recorder that splits native from JavaScript memory.

describe("the freeze recorder's memory reading", () => {
  it("records the process's own memory, split between the JavaScript heap and native memory", async () => {
    const recordPath = join(scratchDir("infinitary-memory-reading-"), "memory.jsonl");
    // A buffer JavaScript still holds is native memory it references.
    const held = Buffer.alloc(32 * 1024 * 1024, 1);
    const recorder = new MemoryRecorder({
      recordPath,
      // The system's footprint counts the heap and the native memory
      // JavaScript holds whether or not their pages are resident, so the
      // stand-in is those two plus 64 MiB that nothing in JavaScript holds.
      // Resident memory is no stand-in: a worker that has run many files
      // can hold more heap and external memory than is resident, once the
      // system compressed pages or never touched them.
      footprint: async () => {
        const { heapTotal, external } = process.memoryUsage();
        return heapTotal + external + 64 * 1024 * 1024;
      },
      build: {
        computer: "disposable test process",
        version: "0.6.2-alpha.80",
        commit: null,
        mutable: false,
      },
    });
    await recorder.read();
    const [line] = readMemoryRecord(recordPath);
    expect(line).toMatchObject({ pid: process.pid, build: { version: "0.6.2-alpha.80" } });
    expect(line?.externalBytes).toBeGreaterThanOrEqual(held.byteLength);
    expect(line?.arrayBuffersBytes).toBeGreaterThanOrEqual(held.byteLength);
    expect(line?.heapUsedBytes).toBeLessThanOrEqual(line?.heapTotalBytes ?? 0);
    const split = memorySplit(line ?? expect.unreachable());
    expect(split.javascriptBytes).toBe(line?.heapTotalBytes);
    expect(split.heldNativeBytes).toBe(line?.externalBytes);
    expect(split.unheldNativeBytes).toBe(
      (line?.footprintBytes ?? 0) - (line?.heapTotalBytes ?? 0) - (line?.externalBytes ?? 0),
    );
    held.fill(0);
  });

  it("says the footprint is unknown, never zero, when the host cannot read it", async () => {
    const recordPath = join(scratchDir("infinitary-memory-unknown-"), "memory.jsonl");
    await new MemoryRecorder({ recordPath, footprint: async () => null }).read();
    await new MemoryRecorder({
      recordPath,
      footprint: () => Promise.reject(new Error("unreadable")),
    }).read();
    const lines = readMemoryRecord(recordPath);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.footprintBytes).toBeUndefined();
      expect(line.rssBytes).toBeGreaterThan(0);
      expect(memorySplit(line).unheldNativeBytes).toBeNull();
    }
  });

  it("keeps only the newest readings, so the record never grows past its bound", async () => {
    const recordPath = join(scratchDir("infinitary-memory-bound-"), "memory.jsonl");
    let minute = 0;
    const recorder = new MemoryRecorder({
      recordPath,
      maxLines: 10,
      now: () => new Date(Date.UTC(2026, 10, 3, 12, minute++)),
    });
    for (let i = 0; i < 40; i++) await recorder.read();
    const lines = readMemoryRecord(recordPath);
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines.at(-1)?.at).toBe(new Date(Date.UTC(2026, 10, 3, 12, 39)).toISOString());
    // Oldest first, with no torn lines.
    expect(readFileSync(recordPath, "utf8").trim().split("\n")).toHaveLength(lines.length);
  });
});
