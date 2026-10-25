import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRADES_BUDGETS } from "./helpers/budgets";
import {
  logTime,
  PHOTOS_LOG,
  PHOTOS_STREAM_LOG,
  photosOpened,
  SCHEDULER_ANSWER_BUDGET_MS,
} from "./helpers/phonePhotos";
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

// Real readings for INF-1170. Run 40057881038's iPad rest part, 9-xcrun.log: Photos' own failure, error 46110.
const failedLine =
  "2026-10-24 04:56:15.624 E  assetsd[9726:1bee4] [com.apple.photos.backend:Syndication] Library services operation failed to open syndication library, error: Error Domain=com.apple.photos.error Code=46110 \"Library identifier is already persisted for this URL, existing 'FA103C12-44FE-46EE-B7F3-0F96B2D17780' vs. requested '(null)'\" UserInfo={NSDebugDescription=Library identifier is already persisted for this URL, existing 'FA103C12-44FE-46EE-B7F3-0F96B2D17780' vs. requested '(null)', NSURL=file:///Users/admin/Library/Developer/CoreSimulator/Devices/4B099639-55CB-49F4-A820-A0AA791E742B/data/Library/Photos/Libraries/Syndication.photoslibrary/}";
// Run 40085697806's iPhone rest part, 9-xcrun.log, the same failure later that day: here, Photos failing again.
const failedAgainLine =
  "2026-10-24 11:35:03.515 E  assetsd[10174:1e066] [com.apple.photos.backend:Syndication] Library services operation failed to open syndication library, error: Error Domain=com.apple.photos.error Code=46110 \"Library identifier is already persisted for this URL, existing '8BFE8443-427B-4F7B-A924-D79BC80CA580' vs. requested '(null)'\" UserInfo={NSDebugDescription=Library identifier is already persisted for this URL, existing '8BFE8443-427B-4F7B-A924-D79BC80CA580' vs. requested '(null)', NSURL=file:///Users/admin/Library/Developer/CoreSimulator/Devices/F75D828E-5D9B-441B-A1E9-D599346B30AA/data/Library/Photos/Libraries/Syndication.photoslibrary/}";
// A fresh iPhone 16 on the Mac mini that failed the same way: its Photos, restarted and asked by the Photos app.
const reopenedLine =
  "2026-10-25 00:09:28.591 Df assetsd[81504:2e9fc0f] [com.apple.photos.backend:Syndication] Library services operation opened syndication photo library";
// A fresh simulator on the Mac mini whose scheduler left Photos' call unanswered for eight minutes, until the
// scheduler was restarted; Photos opened its library a moment after the restarted scheduler took the call up.
const stalledAsk =
  "2026-10-24 23:50:58.022 Df assetsd[46952:2db7e68] [com.apple.photos.backend:Backend] Submitting task request for background migration with identifier com.apple.assetsd.migration.16777233.1434045712";
const stalledTaken =
  "2026-10-24 23:59:03.938 Df dasd[81019:2e1bb60] [com.apple.duetactivityscheduler:client] SUBMITTING: com.apple.assetsd.migration.16777233.1434045712:C1C4FD";
const stalledOpened =
  "2026-10-24 23:59:04.076 Df assetsd[46952:2db81fc] [com.apple.photos.backend:Syndication] Library services operation opened syndication photo library";
// The slowest healthy answer seen on the Mac mini: the scheduler took the call up after 16 seconds.
const slowAsk =
  "2026-10-25 00:11:30.969 Df assetsd[54710:2ec5bce] [com.apple.photos.backend:Backend] Submitting task request for background migration with identifier com.apple.assetsd.migration.16777233.1434270678";
const slowTaken =
  "2026-10-25 00:11:47.361 Df dasd[54560:2eca04b] [com.apple.duetactivityscheduler:client] SUBMITTING: com.apple.assetsd.migration.16777233.1434270678:844727";
const slowOpened =
  "2026-10-25 00:11:47.361 Df assetsd[54710:2eca0b6] [com.apple.photos.backend:Syndication] Library services operation opened syndication photo library";

const restartPhotos = [
  "simctl",
  "spawn",
  simulator,
  "launchctl",
  "kickstart",
  "-k",
  "user/foreground/com.apple.assetsd",
];
const restartScheduler = [
  "simctl",
  "spawn",
  simulator,
  "launchctl",
  "kickstart",
  "-k",
  "user/foreground/com.apple.dasd",
];
const launchPhotos = ["simctl", "launch", simulator, "com.apple.mobileslideshow"];
const quitPhotos = ["simctl", "terminate", simulator, "com.apple.mobileslideshow"];

const waitWith = (evidence: string, run: (command: string, args: string[]) => Promise<string>) =>
  photosOpened({
    device: simulator,
    booting: new Date(),
    env: {},
    evidence,
    children: new Set<ChildProcess>(),
    run,
    failureLog,
  });

const commands = (run: { mock: { calls: unknown[][] } }) =>
  run.mock.calls.map((call) => call[1] as string[]);

describe("the phone gate's Photos readiness wait tells a failed or stalled Photos from a slow one (INF-1170)", () => {
  it("restarts Photos once when it fails to open the library, then starts the part once it has", async () => {
    const evidence = scratchDir("phone-photos-failed-");
    const stream = startStream();
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("log")) queueMicrotask(() => stream.stdout.write(`${failedLine}\n`));
      if (args.includes("launch")) queueMicrotask(() => stream.stdout.write(`${reopenedLine}\n`));
      return args.includes("log") ? bootQuery : "";
    });
    await waitWith(evidence, run);
    // Photos restarted, the Photos app asked for its libraries, and quit before the part's own app starts.
    expect(commands(run).slice(1)).toEqual([restartPhotos, launchPhotos, quitPhotos]);
    expect(readFileSync(join(evidence, PHOTOS_STREAM_LOG), "utf8")).toContain(failedLine);
  });

  it("ends the part at once when Photos fails again after the gate restarted it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 24, 4, 56, 20));
    const evidence = scratchDir("phone-photos-failed-again-");
    const stream = startStream();
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("--info")) return "kept log";
      if (args.includes("log")) queueMicrotask(() => stream.stdout.write(`${failedLine}\n`));
      if (args.includes("launch"))
        queueMicrotask(() => stream.stdout.write(`${failedAgainLine}\n`));
      return args.includes("log") ? bootQuery : "";
    });
    await expect(waitWith(evidence, run)).rejects.toThrow(
      "Photos failed to open its shared-with-you library again after the gate restarted it",
    );
    // It kept the simulator's log since boot and restarted Photos only the once.
    expect(commands(run).filter((args) => args.includes("--info"))).toHaveLength(1);
    expect(commands(run).filter((args) => args.includes("kickstart"))).toEqual([restartPhotos]);
    expect(commands(run).at(-1)).toEqual(quitPhotos);
  });

  it("restarts the scheduler when it leaves Photos' call unanswered past its budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const evidence = scratchDir("phone-photos-stalled-");
    const stream = startStream();
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("log")) queueMicrotask(() => stream.stdout.write(`${stalledAsk}\n`));
      if (args.includes("kickstart"))
        queueMicrotask(() => stream.stdout.write(`${stalledTaken}\n${stalledOpened}\n`));
      return args.includes("log") ? bootQuery : "";
    });
    const waiting = waitWith(evidence, run);
    await vi.advanceTimersByTimeAsync(SCHEDULER_ANSWER_BUDGET_MS);
    await waiting;
    expect(commands(run).slice(1)).toEqual([restartScheduler]);
  });

  it("waits out a call the scheduler answers within its budget, restarting nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const evidence = scratchDir("phone-photos-slow-");
    const stream = startStream();
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("log")) queueMicrotask(() => stream.stdout.write(`${slowAsk}\n`));
      return bootQuery;
    });
    const waiting = waitWith(evidence, run);
    await vi.advanceTimersByTimeAsync(16_392);
    stream.stdout.write(`${slowTaken}\n`);
    await vi.advanceTimersByTimeAsync(SCHEDULER_ANSWER_BUDGET_MS);
    stream.stdout.write(`${slowOpened}\n`);
    await waiting;
    expect(commands(run)).toHaveLength(1);
  });
});
