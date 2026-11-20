import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEPT_RUNS,
  liveRuns,
  type ProcessStart,
  RUNS_DIR,
  runDir,
  runName,
  tidyRunEvidence,
} from "./e2e/runEvidence";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * Where a Playwright run keeps its evidence (docs/testing.md, "Per-run e2e
 * evidence"). Real overlapping runs are driven in
 * tests/run-evidence-playwright.test.ts.
 */

// Above any pid macOS (99998) or Linux (2^22) hands out, so no process owns it.
const GONE = 9_999_999;
// A runner still going: its process started just before it named its run.
const RUNNER = 4242;
const RUNNING = `20260930T120000Z-${RUNNER}`;
// A finished run's pid the system has since handed to a later process.
const REUSED = 4343;
const REUSED_RUN = `20260929T120000Z-${REUSED}`;
const processes = new Map([
  [RUNNER, Date.parse("2026-09-30T11:59:59.400Z")],
  [REUSED, Date.parse("2026-09-30T08:00:00Z")],
]);
// What the system says of each pid, in place of asking it (`ps`); the real
// answer is read in tests/run-evidence-playwright.test.ts.
const started: ProcessStart = (pid) => processes.get(pid);

describe("a Playwright run's evidence directory", () => {
  it("is named for when the runner started and its pid, and shared with its workers", () => {
    const at = new Date("2026-09-30T19:49:00.123Z");
    expect(runName(at, 4242)).toBe("20260930T194900Z-4242");

    const env: NodeJS.ProcessEnv = {};
    const dir = runDir(env, at);
    expect(dir).toBe(join(RUNS_DIR, runName(at, process.pid)));
    // The runner loading its config again keeps it.
    expect(runDir(env, new Date())).toBe(dir);
    // A worker inherits it: the runner's pid, not its own.
    expect(runDir({ INFINITARY_E2E_RUN: "20260930T194900Z-4242", TEST_WORKER_INDEX: "3" })).toBe(
      join(RUNS_DIR, "20260930T194900Z-4242"),
    );
  });

  it("is never one a runner inherited from another process, which Playwright would clear", () => {
    const env: NodeJS.ProcessEnv = { INFINITARY_E2E_RUN: "20260930T194900Z-4242" };
    const at = new Date("2026-10-01T08:00:00Z");

    expect(runDir(env, at)).toBe(join(RUNS_DIR, runName(at, process.pid)));
  });

  function workingCopy(runs: string[], loose: string[] = []): string {
    const root = scratchDir("infinitary-evidence-");
    for (const run of runs) mkdirSync(join(root, RUNS_DIR, run, "a-test"), { recursive: true });
    for (const name of loose) {
      mkdirSync(join(root, "test-results", name), { recursive: true });
      writeFileSync(join(root, "test-results", name, "picture.png"), "");
    }
    return root;
  }

  it("keeps the newest finished runs and every live one, and removes the rest", () => {
    const finished = Array.from(
      { length: KEPT_RUNS + 3 },
      (_, n) => `202609${String(n + 10).padStart(2, "0")}T000000Z-${GONE}`,
    );
    const live = RUNNING;
    const own = join(RUNS_DIR, `20261001T000000Z-${process.pid}`);
    const root = workingCopy([...finished, live]);

    tidyRunEvidence(root, own, started);

    expect(readdirSync(join(root, RUNS_DIR)).sort()).toEqual(
      [...finished.slice(-KEPT_RUNS), live, own.slice(RUNS_DIR.length + 1)].sort(),
    );
  });

  it("leaves everything outside the runs alone, whether or not another run is going", () => {
    const own = join(RUNS_DIR, `20261001T000000Z-${process.pid}`);
    // Alone (a finished run and one whose pid was reused), and beside a live run.
    for (const others of [[`20260930T000000Z-${GONE}`, REUSED_RUN], [RUNNING]]) {
      const root = workingCopy(others, ["custom-api"]);
      tidyRunEvidence(root, own, started);
      expect(existsSync(join(root, "test-results", "custom-api", "picture.png"))).toBe(true);
    }
  });

  it("reads a run as going only while its runner is, never through a pid the system reused", () => {
    const root = workingCopy([`20260928T120000Z-${GONE}`, REUSED_RUN, RUNNING]);
    mkdirSync(join(root, RUNS_DIR, "notes"));

    expect(liveRuns(root, started)).toEqual([RUNNING]);
    // A runner whose process started later than the run it names is not that run's.
    expect(
      liveRuns(root, (pid) => (pid === RUNNER ? Date.parse("2026-09-30T12:00:03Z") : undefined)),
    ).toEqual([]);
    // A working copy no run has started in has none.
    expect(liveRuns(scratchDir("infinitary-evidence-"), started)).toEqual([]);
  });
});
