import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { waitCap } from "./helpers/budgets";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The load clock (INF-1083, the captain's choice "a deadline counts only the
 * time the test gets to run, capped at 20 times its budget"), through the real
 * Playwright runner and its patched deadlines: tests/fixtures/load-clock. Each
 * run is its own process group, which this test freezes the way the load
 * controller (scripts/starve-check.py) freezes a journey: runner, worker and
 * the writer the worker started, all at once.
 */
// Five runs side by side, four with a deliberate freeze; the longest waits out its 20 s cap (25 s measured).
vi.setConfig({ testTimeout: 60_000 });
const repoRoot = join(__dirname, "..");
const playwrightCli = join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const config = join(__dirname, "fixtures", "load-clock", "playwright.config.ts");

/** How a run is frozen once its test is waiting: one long stop, or long stops with slivers of running between. */
type Freeze = { stopMs: number; runMs: number } | undefined;

type Outcome = {
  status: string;
  error: string;
  waitedMs: number;
  duration: number;
  bodyDuration: number;
};

async function run(
  title: string,
  budget: number,
  freeze: Freeze,
  graded = false,
): Promise<Outcome> {
  const signals = scratchDir("infinitary-load-clock-");
  const child = spawn(process.execPath, [playwrightCli, "test", "--config", config, "-g", title], {
    cwd: repoRoot,
    env: {
      ...process.env,
      INFINITARY_LOAD_CLOCK_SIGNALS: signals,
      INFINITARY_LOAD_CLOCK_OUTPUT: join(signals, "results"),
      INFINITARY_LOAD_CLOCK_BUDGET: String(budget),
      INFINITARY_PERF_BUDGETS: graded ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const group = child.pid;
  if (!group) throw new Error("The Playwright run did not start");
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
  type Suite = {
    suites?: Suite[];
    specs?: { tests: { results: Result[] }[] }[];
  };
  type Result = { status: string; duration: number; errors?: { message?: string }[] };
  const results = (suite: Suite): Result[] => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((test) => test.results)),
    ...(suite.suites ?? []).flatMap(results),
  ];
  const [result] = results(JSON.parse(output) as Suite);
  if (!result || !waitingAt || !doneAt)
    throw new Error(`The run did not finish its test:\n${output}`);
  return {
    status: result.status,
    error: (result.errors ?? []).map((error) => error.message ?? "").join("\n"),
    waitedMs: doneAt - waitingAt,
    duration: result.duration,
    bodyDuration: Number(readFileSync(join(signals, "body-duration"), "utf8")),
  };
}

/** How much the clock slows on this computer now: the load per processor, above 1. */
const slowdown = () => Math.max(1, (loadavg()[0] ?? 0) / availableParallelism());

it("counts only the time a journey gets to run, and ends every wait by its wall cap", async () => {
  const slowedBefore = slowdown();
  const [frozenWriter, frozenAfterHook, gradedWriter, quietMissing, starvedMissing] =
    await Promise.all([
      // A writer frozen 7 s past its 5 s budget: the poll's clock stops with it.
      run("a frozen writer's file", 5_000, { stopMs: 7_000, runMs: Number.POSITIVE_INFINITY }),
      // The report includes wall time spent in the separate after-hooks timeout slot too.
      run("a frozen after hook's file", 5_000, { stopMs: 7_000, runMs: Number.POSITIVE_INFINITY }),
      // The same freeze on a graded run fails at the budget: graded runs keep the wall clock.
      run(
        "a frozen writer's file",
        5_000,
        { stopMs: 7_000, runMs: Number.POSITIVE_INFINITY },
        true,
      ),
      // A file that never comes fails at about its budget when nothing freezes the run.
      run("a missing file", 2_000, undefined),
      // Under a runner frozen all but 20 ms in every 3 s, its 1 s budget would take
      // over 40 s to count, so the wall cap of 20 s ends it.
      run("a missing file", 1_000, { stopMs: 3_000, runMs: 20 }),
    ]);
  const slowed = Math.max(slowedBefore, slowdown());
  console.log(
    JSON.stringify({
      frozenWriter,
      frozenAfterHook,
      gradedWriter,
      quietMissing,
      starvedMissing,
      slowed,
    }),
  );

  expect(frozenWriter.status).toBe("passed");
  expect(frozenWriter.waitedMs).toBeGreaterThan(7_000);
  // INF-1258: reports and PR Mac placement need wall time, including the freeze,
  // even though the timeout budget correctly excludes it.
  expect(frozenWriter.duration).toBeGreaterThanOrEqual(7_000);
  expect(frozenWriter.bodyDuration).toBeGreaterThanOrEqual(7_000);

  expect(frozenAfterHook.status).toBe("passed");
  expect(frozenAfterHook.waitedMs).toBeGreaterThan(7_000);
  expect(frozenAfterHook.duration).toBeGreaterThanOrEqual(7_000);

  expect(gradedWriter.status).toBe("failed");
  expect(gradedWriter.error).toContain("Timeout 5000ms exceeded");
  expect(gradedWriter.duration).toBeGreaterThanOrEqual(7_000);

  expect(quietMissing.status).toBe("failed");
  expect(quietMissing.error).toContain("Timeout 2000ms exceeded");
  // The poll stops one 50 ms interval early rather than overrun, and this test reads its markers every 5 ms.
  expect(quietMissing.waitedMs).toBeGreaterThanOrEqual(2_000 - 50 - 5);
  expect(quietMissing.waitedMs).toBeLessThan(2_000 * slowed + 3_000);

  expect(starvedMissing.status).toBe("failed");
  expect(starvedMissing.error).toContain("Timeout 1000ms exceeded");
  expect(starvedMissing.waitedMs).toBeGreaterThanOrEqual(waitCap(1_000));
  expect(starvedMissing.waitedMs).toBeLessThan(waitCap(1_000) + 3 * 3_000);
});
