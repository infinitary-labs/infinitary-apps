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

type Outcome = { status: string; error: string; waitedMs: number };

/**
 * A vitest run of its own over `tests/fixtures/frozen-work`, graded or not,
 * as its own process group, which this test freezes the way a starved Mac
 * freezes a unit run: vitest, its worker and the writer the worker started.
 */
async function frozenRun(
  title: string,
  budget: number,
  freeze: Freeze,
  graded = false,
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
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      join(__dirname, "fixtures", "frozen-work", "vitest.config.ts"),
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
      assertionResults: { title: string; status: string; failureMessages: string[] }[];
    }[];
  };
  const result = existsSync(report)
    ? (JSON.parse(readFileSync(report, "utf8")) as Report).testResults
        .flatMap((file) => file.assertionResults)
        .find((test) => test.title === title)
    : undefined;
  if (!result || !waitingAt || !doneAt)
    throw new Error(`The run did not finish its test:\n${output}`);
  return {
    status: result.status,
    error: result.failureMessages.join("\n"),
    waitedMs: doneAt - waitingAt,
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
    const [frozenWriter, gradedWriter, quietMissing, starvedMissing] = await Promise.all([
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
        true,
      ),
      // A file that never comes fails at about its budget when nothing freezes the run.
      frozenRun("a missing file", 2_000, undefined),
      // Under a run frozen all but 20 ms in every 3 s, the poll's 1.5 s window
      // would take over a minute to count, so its wall cap of 30 s ends it.
      frozenRun("a missing file", 2_000, { stopMs: 3_000, runMs: 20 }),
    ]);
    const slowed = Math.max(slowedBefore, slowdown());
    console.log(
      JSON.stringify({ frozenWriter, gradedWriter, quietMissing, starvedMissing, slowed }),
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

    expect(starvedMissing.status).toBe("failed");
    expect(starvedMissing.error).toContain("expected false to be true");
    expect(starvedMissing.waitedMs).toBeGreaterThanOrEqual(waitCap(window));
    expect(starvedMissing.waitedMs).toBeLessThan(waitCap(window) + 3 * 3_000);
    // Four runs side by side, each with a deliberate freeze; the longest waits out its 30 s cap.
  }, 90_000);
});
