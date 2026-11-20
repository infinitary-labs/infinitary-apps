import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { waitCap } from "./helpers/budgets";
import { scratchDir } from "./helpers/scratchDirs";
import { waitWindow } from "./helpers/waitWindow";

// INF-857, the captain: "we should fix the tests instead and make them robust
// even during heavy load", and his choice: "Grade durations only on a quiet
// run, as journeys already do. Elsewhere a test waits for its event with no
// clock, and the job's own time limit stops a stuck one". A busy Mac freezes
// a test's processes for seconds at a time (INF-719 measured stalls of up to
// 11.5 s); these hold a test, and a wait inside it, to its work there.
// INF-1083, the captain's choice for unit tests: "Yes, as a third piece after
// these two: today a stuck unit test waits with no clock until GitHub's
// six-hour limit". So the limit and the wait count only the time the run got
// to run, and end by their wall cap (tests/helpers/budgets.ts).
vi.setConfig({ testTimeout: 10_000 });

const repoRoot = join(__dirname, "..");

/** A child that writes `file` once it runs, frozen the way a starved Mac freezes it, then let go. */
async function frozenWriter(file: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", `require("node:fs").writeFileSync(${JSON.stringify(file)}, "done")`],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  child.kill("SIGSTOP");
  // Longer than vitest's own one-second window for a wait.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  child.kill("SIGCONT");
}

/** How a run is frozen once its test is waiting: one long stop, or long stops with slivers of running between. */
type Freeze = { stopMs: number; runMs: number } | undefined;

/** A poll's own record, as it ended: the load time it counted, and when each attempt came after it started. */
type Poll = { countedMs: number; attemptsMs: number[] };

/**
 * The test's result, its file's - where a failed hook is reported - how long
 * the frozen work took, and the poll's own record when the test has a poll.
 */
type Outcome = {
  status: string;
  error: string;
  fileStatus: string;
  fileError: string;
  waitedMs: number;
  poll: Poll | undefined;
};

/**
 * A vitest run of its own over `tests/fixtures/frozen-work`, under `config`
 * there, graded or not, as its own process group, which this test freezes
 * the way a starved Mac freezes a unit run: vitest, its worker and the
 * writer the worker started. Its clock reads the disk this test gives it
 * (`diskPressure.ts`), which stands still unless `diskStalled`, when the run's
 * work waits on its disk throughout.
 */
async function frozenRun(
  title: string,
  budget: number,
  freeze: Freeze,
  { graded = false, config = "vitest.config.ts", diskStalled = false } = {},
): Promise<Outcome> {
  const signals = scratchDir("infinitary-frozen-work-");
  const report = join(signals, "report.json");
  // Its own temp folder: a graded run ends with the frozen work's folder still there.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: scratchDir("infinitary-frozen-tmp-"),
    INFINITARY_FROZEN_WORK_SIGNALS: signals,
    INFINITARY_FROZEN_WORK_BUDGET: String(budget),
  };
  delete env.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  if (graded) env.INFINITARY_PERF_BUDGETS = "1";
  else delete env.INFINITARY_PERF_BUDGETS;
  if (diskStalled) env.INFINITARY_FROZEN_WORK_DISK_STALLED = "1";
  else delete env.INFINITARY_FROZEN_WORK_DISK_STALLED;
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      join(__dirname, "fixtures", "frozen-work", config),
      "-t",
      title,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const group = child.pid;
  if (!group) throw new Error("The vitest run did not start");
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-group, name);
    } catch {}
  };
  // The harness's own bound, so a broken clock under test cannot hold the suite.
  const watchdog = setTimeout(() => signal("SIGKILL"), 120_000);
  const marked = (name: string) => existsSync(join(signals, name));
  let schedule = freeze;
  let waitingAt = 0;
  let doneAt = 0;
  let frozen = false;
  let phaseEnds = 0;
  const watcher = setInterval(() => {
    const now = performance.now();
    if (!waitingAt && marked("waiting")) waitingAt = now;
    if (waitingAt && !doneAt && marked("done")) doneAt = now;
    if (!schedule || !waitingAt) return;
    if (frozen && (now >= phaseEnds || doneAt)) {
      signal("SIGCONT");
      frozen = false;
      phaseEnds = now + schedule.runMs;
      // One long stop, then the run goes on unfrozen.
      if (schedule.runMs === Number.POSITIVE_INFINITY) schedule = undefined;
    } else if (!frozen && !doneAt && now >= phaseEnds) {
      signal("SIGSTOP");
      frozen = true;
      phaseEnds = now + schedule.stopMs;
    }
  }, 5);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  }).finally(() => {
    clearInterval(watcher);
    clearTimeout(watchdog);
    signal("SIGCONT");
  });
  type Report = {
    testResults: {
      status: string;
      message: string;
      assertionResults: { title: string; status: string; failureMessages: string[] }[];
    }[];
  };
  const file = existsSync(report)
    ? (JSON.parse(readFileSync(report, "utf8")) as Report).testResults.find((tested) =>
        tested.assertionResults.some((test) => test.title === title),
      )
    : undefined;
  const result = file?.assertionResults.find((test) => test.title === title);
  if (!file || !result || !waitingAt || !doneAt)
    throw new Error(`The run did not finish its test:\n${output}`);
  const poll = join(signals, "poll.json");
  return {
    status: result.status,
    error: result.failureMessages.join("\n"),
    fileStatus: file.status,
    fileError: file.message,
    waitedMs: doneAt - waitingAt,
    poll: existsSync(poll) ? (JSON.parse(readFileSync(poll, "utf8")) as Poll) : undefined,
  };
}

/** How much the clock slows on this computer now: the load per processor, above 1. */
const slowdown = () => Math.max(1, (loadavg()[0] ?? 0) / availableParallelism());

describe("a wait for a state, on a Mac that freezes the work", () => {
  it("lasts until the state arrives: expect.poll and vi.waitFor", async () => {
    const dir = scratchDir("infinitary-wait-window-");
    const polled = join(dir, "polled");
    const waited = join(dir, "waited");
    const polling = expect.poll(() => existsSync(polled)).toBe(true);
    const waiting = vi.waitFor(() => expect(existsSync(waited)).toBe(true));
    await Promise.all([frozenWriter(polled), frozenWriter(waited), polling, waiting]);
  });

  it("keeps a window it names, and otherwise its test's budget, on either run", () => {
    const test = { timeout: 10_000, startedAt: 1_000 };
    const ordinary = { grades: false, test, now: 4_000 };
    // The whole budget, less the moment the wait takes to report its mismatch:
    // the clock may have counted less than the wall time that passed.
    expect(waitWindow(undefined, ordinary)).toBe(9_500);
    expect(waitWindow(100, ordinary)).toBe(100);

    const graded = { grades: true, test, now: 4_000 };
    // The rest of the budget, less the moment the wait takes to report its mismatch.
    expect(waitWindow(undefined, graded)).toBe(6_500);
    // A window its author named stays.
    expect(waitWindow(100, graded)).toBe(100);
    // Outside a test, and once the budget is spent, vitest's own second.
    expect(waitWindow(undefined, { ...graded, test: undefined })).toBe(1_000);
    expect(waitWindow(undefined, { ...graded, now: 11_000 })).toBe(1_000);
  });
});

describe("a test's time limit and its waits, on the load clock", () => {
  it("count only the time the run gets, and end by their wall cap", async () => {
    const slowedBefore = slowdown();
    const [frozenWriter, gradedWriter, quietMissing, starvedMissing, diskMissing] =
      await Promise.all([
        // A writer frozen 7 s past its 5 s budget: the test's and the wait's clocks stop with it.
        frozenRun("a frozen writer's file", 5_000, {
          stopMs: 7_000,
          runMs: Number.POSITIVE_INFINITY,
        }),
        // The same freeze on a graded run fails at the budget: graded runs keep the wall clock.
        frozenRun(
          "a frozen writer's file",
          5_000,
          { stopMs: 7_000, runMs: Number.POSITIVE_INFINITY },
          { graded: true },
        ),
        // A file that never comes fails at about its budget when nothing freezes the run.
        frozenRun("a missing file", 2_000, undefined),
        // Under a run frozen all but 20 ms in every 3 s, the poll's 1.5 s window
        // would take over a minute to count, so its wall cap of 30 s ends it.
        frozenRun("a missing file", 2_000, { stopMs: 3_000, runMs: 20 }),
        // A run that keeps running while its work waits on its disk throughout:
        // its load clock counts none of that wait, so the wall cap of 30 s ends it.
        frozenRun("a missing file", 2_000, undefined, { diskStalled: true }),
      ]);
    const slowed = Math.max(slowedBefore, slowdown());
    console.log(
      JSON.stringify({
        frozenWriter,
        gradedWriter,
        quietMissing,
        starvedMissing,
        diskMissing,
        slowed,
      }),
    );

    expect(frozenWriter.status).toBe("passed");
    expect(frozenWriter.waitedMs).toBeGreaterThan(7_000);

    expect(gradedWriter.status).toBe("failed");

    // The poll's window is the budget less half a second to report its own mismatch.
    const window = 2_000 - 500;
    expect(quietMissing.status).toBe("failed");
    expect(quietMissing.error).toContain("expected false to be true");
    expect(quietMissing.waitedMs).toBeGreaterThanOrEqual(window - 50);
    expect(quietMissing.waitedMs).toBeLessThan(window * slowed + 3_000);
    // Its load clock counted the window: the load clock, not the wall cap, ended it.
    expect(quietMissing.poll?.countedMs).toBeGreaterThanOrEqual(window);

    // The poll's own mismatch, not the test's limit, ended the test, once its
    // wall cap had passed and while its load clock had not yet counted its
    // window: the wall cap ended it. Each claim is an order of events or the
    // run's own work, never a wall-clock window, since the run reports its
    // failure only in its 20 ms slivers, and a busy runner gives it less of
    // each one (INF-857: "make them robust even during heavy load").
    expect(starvedMissing.status).toBe("failed");
    expect(starvedMissing.error).toContain("expected false to be true");
    expect(starvedMissing.waitedMs).toBeGreaterThanOrEqual(waitCap(window));
    expect(starvedMissing.poll?.countedMs).toBeLessThan(window);
    // The cap ended it as soon as the run next ran: past the cap, an attempt in
    // that sliver and the last one vitest makes once its window is over. A
    // late cap adds an attempt for each sliver the run runs before it fires.
    const pastCap = (run: Outcome) => run.poll?.attemptsMs.filter((at) => at >= waitCap(window));
    expect(pastCap(starvedMissing)?.length).toBeGreaterThanOrEqual(1);
    expect(pastCap(starvedMissing)?.length).toBeLessThanOrEqual(2);

    // The same wait on a disk that never frees: the wall cap, not its budget,
    // ended it, since its load clock had not counted its window.
    expect(diskMissing.status).toBe("failed");
    expect(diskMissing.error).toContain("expected false to be true");
    expect(diskMissing.waitedMs).toBeGreaterThanOrEqual(waitCap(window));
    expect(diskMissing.poll?.countedMs).toBeLessThan(window);
    // And on time: a run polling throughout makes an attempt every 50 ms, so a
    // cap that fired late would leave more than these two past it.
    expect(pastCap(diskMissing)?.length).toBeGreaterThanOrEqual(1);
    expect(pastCap(diskMissing)?.length).toBeLessThanOrEqual(2);
    // Five runs side by side, each with a deliberate freeze or stall; the longest waits out its 30 s cap.
  }, 90_000);
});

describe("a setup file's hook, on the load clock", () => {
  // statementCheck.ts and scratchDirCleanup.ts register their hooks before
  // waitWindow.ts starts the clock, in every project of vitest.config.ts; on a
  // loaded runner the cleanup's hook timed out at the wall clock's 10 s once
  // every test of its file had passed.
  it("counts only the time the run gets, though it was registered before the clock started", async () => {
    // A hook doing a second of work, frozen 7 s past its 5 s limit.
    const frozenHook = await frozenRun(
      "a file whose setup file's hook is frozen",
      5_000,
      {
        stopMs: 7_000,
        runMs: Number.POSITIVE_INFINITY,
      },
      { config: "setupHook.config.ts" },
    );

    expect(frozenHook.waitedMs).toBeGreaterThan(7_000);
    expect(frozenHook.status).toBe("passed");
    expect(frozenHook.fileError).toBe("");
    expect(frozenHook.fileStatus).toBe("passed");
  }, 60_000);
});
