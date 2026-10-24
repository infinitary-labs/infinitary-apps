import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRADES_BUDGETS } from "./helpers/budgets";
import { logTime, PHOTOS_LOG, PHOTOS_STREAM_LOG, photosOpened } from "./helpers/phonePhotos";
import { scratchDir } from "./helpers/scratchDirs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

// Real readings from PR #285's phone check (run 39805546269). Attempt 2's iPad talk part kept only this
// boot-time query, 5-xcrun.log, before its fifteen-minute timeout; the stream's own output was discarded.
const bootQuery =
  "getpwuid_r did not find a match for uid 501\nTimestamp               Ty Process[PID:TID]\n";
// Attempt 1's iPad talk part, 10-xcrun.log: the message the wait listens for.
const openedLine =
  "2026-10-22 15:45:02.828 Df assetsd[6394:d202] [com.apple.photos.backend:Syndication] Library services operation opened syndication photo library";
const failureLog = 'process == "Infinitary" OR process == "assetsd"';
const simulator = "0B146C23-C3F9-456C-9C6C-965ED6409C77";

function makeStream() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(() => {
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    }),
  });
  return child;
}

// The stream as log prints it: its uid warning on stderr, then its filter header on stdout.
function startStream() {
  const stream = makeStream();
  spawn.mockImplementation(() => {
    queueMicrotask(() => {
      stream.stderr.write("getpwuid_r did not find a match for uid 501\n");
      stream.stdout.write(`Filtering the log data using "${PHOTOS_LOG}"\n`);
      stream.stdout.write("Timestamp               Ty Process[PID:TID]\n");
    });
    return stream;
  });
  return stream;
}

afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});

describe("the phone gate's Photos readiness wait (INF-907)", () => {
  it("keeps the stream's output and the simulator's log since boot when Photos is not ready in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const evidence = scratchDir("phone-photos-timeout-");
    startStream();
    const booting = new Date();
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.includes("--info") ? "kept log" : bootQuery,
    );
    const waiting = photosOpened({
      device: simulator,
      booting,
      env: {},
      evidence,
      children: new Set<ChildProcess>(),
      run,
      failureLog,
    });
    const failed = expect(waiting).rejects.toThrow(
      `Photos had not opened its shared-with-you library ${GRADES_BUDGETS ? "fifteen" : "twenty"} minutes after boot`,
    );
    await vi.advanceTimersByTimeAsync((GRADES_BUDGETS ? 15 : 20) * 60_000);
    await failed;
    // Before the gate's cleanup can delete the simulator, the wait asked it for everything since boot.
    expect(run).toHaveBeenLastCalledWith("xcrun", [
      "simctl",
      "spawn",
      simulator,
      "log",
      "show",
      "--start",
      logTime(booting),
      "--style",
      "compact",
      "--info",
      "--predicate",
      failureLog,
    ]);
    const kept = readFileSync(join(evidence, PHOTOS_STREAM_LOG), "utf8");
    expect(kept).toContain("getpwuid_r did not find a match for uid 501");
    expect(kept).toContain(`Filtering the log data using "${PHOTOS_LOG}"`);
  });

  it("still fails the part with its own reason when the simulator's log cannot be kept", async () => {
    const evidence = scratchDir("phone-photos-closed-");
    const stream = startStream();
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("--info")) throw new Error("xcrun failed (1)");
      queueMicrotask(() => stream.emit("close", 1, null));
      return bootQuery;
    });
    await expect(
      photosOpened({
        device: simulator,
        booting: new Date(),
        env: {},
        evidence,
        children: new Set(),
        run,
        failureLog,
      }),
    ).rejects.toThrow(
      "The simulator's Photos log stopped before Photos opened its shared-with-you library",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts the part once Photos says so, keeping its stream and no failure log", async () => {
    const evidence = scratchDir("phone-photos-opened-");
    const stream = startStream();
    const run = vi.fn(async () => {
      queueMicrotask(() => stream.stdout.write(`${openedLine}\n`));
      return bootQuery;
    });
    await photosOpened({
      device: simulator,
      booting: new Date(),
      env: {},
      evidence,
      children: new Set(),
      run,
      failureLog,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stream.kill).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(evidence, PHOTOS_STREAM_LOG), "utf8")).toContain(openedLine);
  });
});
