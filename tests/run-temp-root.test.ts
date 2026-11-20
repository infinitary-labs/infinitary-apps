import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { findFolderHolders } from "../src/core/placed/folderHolders";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The run-level temp guard (tests/helpers/runTempRoot.ts), driven through a
 * real vitest run of its own: a run's scratch lives in one private TMPDIR,
 * what a test forgot fails the run by name, and nothing reaches the shared
 * temp directory either way.
 */
const repoRoot = join(__dirname, "..");
const config = join(__dirname, "fixtures", "temp-leak", "vitest.config.ts");

function runFixture(
  sharedTmp: string,
  env: Record<string, string> = {},
  fixtureConfig = config,
  runner = "vitest",
) {
  const childEnv = hostEnv({ ...env, TMPDIR: sharedTmp });
  // This suite's own run owns its root; the fixture run must open its own.
  delete childEnv.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  const result = spawnSync(
    process.execPath,
    runner === "vitest"
      ? [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", fixtureConfig]
      : [
          join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
          "test",
          "--config",
          fixtureConfig,
        ],
    { cwd: repoRoot, env: childEnv, encoding: "utf8", timeout: 90_000 },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

async function startHolder(folder: string) {
  const child = spawn(
    process.execPath,
    ["-e", "process.send('ready'); setInterval(() => {}, 1000)"],
    {
      cwd: folder,
      env: hostEnv(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await once(child, "message");
  child.disconnect();
  return child;
}

function fixturePids(file: string): number[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(Number) : [];
}

function stopFixturePids(file: string): void {
  for (const pid of fixturePids(file)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already ended. */
    }
  }
}

describe("the run's private temp root", () => {
  it("passes a run whose scratch directories were all removed, and leaves the shared temp dir as it found it", () => {
    const shared = scratchDir("infinitary-shared-tmp-");

    const run = runFixture(shared);

    expect(run.output).toContain("1 passed");
    expect(run.status).toBe(0);
    expect(readdirSync(shared)).toEqual([]);
  }, 120_000);

  it("fails a run that left a directory behind, naming it, and still removes it", () => {
    const shared = scratchDir("infinitary-shared-tmp-");

    const run = runFixture(shared, { INFINITARY_FIXTURE_LEAK: "infinitary-fixture-stray-" });

    expect(run.status).toBe(1);
    expect(run.output).toContain("The unit run left 1 temp entry behind.");
    expect(run.output).toMatch(/ {2}infinitary-fixture-stray-\w{6}\n/);
    expect(run.output).not.toContain("infinitary-fixture-scratch-");
    expect(readdirSync(shared)).toEqual([]);
  }, 120_000);

  // Approved cleanup plan: a run ends its leftover programs and fails by name,
  // including detached children holding paths scratch cleanup already removed.
  it.each(["file", "cwd", "kill", "socket", "multiple"])(
    "ends a %s leftover, fails by pid and name, and removes the run root",
    (mode) => {
      const shared = scratchDir("infinitary-program-run-");
      const pidFile = join(shared, "leftover.pid");
      try {
        const run = runFixture(shared, {
          INFINITARY_FIXTURE_PROGRAM: mode,
          INFINITARY_FIXTURE_PID: pidFile,
        });
        const pids = fixturePids(pidFile);
        expect(pids).toHaveLength(mode === "multiple" ? 2 : 1);
        expect(run.status, run.output).toBe(1);
        expect(run.output).toContain(`The unit run left ${pids.length} program(s) behind.`);
        for (const pid of pids) {
          expect(run.output).toMatch(
            new RegExp(`  \\S.* \\(pid ${pid}\\): ${mode === "kill" ? "killed" : "ended"}`),
          );
          expect(() => process.kill(pid, 0)).toThrow();
        }
        expect(readdirSync(shared)).toEqual(["leftover.pid"]);
      } finally {
        // A broken cleanup must not make this regression leave a real daemon.
        stopFixturePids(pidFile);
      }
    },
    120_000,
  );

  it.each(["clean", "multiple"])(
    "applies end-and-fail to a %s Playwright run too",
    (mode) => {
      const shared = scratchDir("infinitary-journey-run-");
      const pidFile = join(shared, "journey.pid");
      try {
        const run = runFixture(
          shared,
          {
            INFINITARY_FIXTURE_PROGRAM: mode === "clean" ? "" : mode,
            INFINITARY_FIXTURE_PID: pidFile,
            INFINITARY_FIXTURE_OUTPUT: join(shared, "output"),
            INFINITARY_E2E_MIC_PREFLIGHT: "0",
          },
          join(__dirname, "fixtures", "temp-leak", "playwright.config.ts"),
          "playwright",
        );
        expect(run.status, run.output).toBe(mode === "clean" ? 0 : 1);
        if (mode === "multiple") {
          const pids = fixturePids(pidFile);
          expect(pids).toHaveLength(2);
          expect(run.output).toContain("The e2e run left 2 program(s) behind.");
          for (const pid of pids) {
            expect(run.output).toContain(`(pid ${pid}): ended`);
            expect(() => process.kill(pid, 0)).toThrow();
          }
        }
        expect(existsSync(join(shared, "infinitary-runs"))).toBe(false);
      } finally {
        stopFixturePids(pidFile);
      }
    },
    120_000,
  );

  it.each(["clean", "multiple"])(
    "closes Vitest's own Chromium without hiding a %s daemon case",
    (mode) => {
      const shared = scratchDir("infinitary-browser-run-");
      const pidFile = join(shared, "unowned.pid");
      try {
        const run = runFixture(
          shared,
          {
            INFINITARY_FIXTURE_PROGRAM: mode === "clean" ? "" : mode,
            INFINITARY_FIXTURE_PID: pidFile,
          },
          join(__dirname, "fixtures", "temp-leak", "vitest.browser.config.ts"),
        );
        expect(run.status, run.output).toBe(mode === "clean" ? 0 : 1);
        if (mode === "multiple") {
          const pids = fixturePids(pidFile);
          expect(pids).toHaveLength(2);
          expect(run.output).toContain("The unit run left 2 program(s) behind.");
          for (const pid of pids) {
            expect(run.output).toContain(`(pid ${pid}): ended`);
            expect(() => process.kill(pid, 0)).toThrow();
          }
        }
        expect(existsSync(join(shared, "infinitary-runs"))).toBe(false);
      } finally {
        stopFixturePids(pidFile);
      }
    },
    120_000,
  );

  it("leaves a non-provider program in a browser profile folder to that folder's owner", () => {
    const shared = scratchDir("infinitary-browser-owner-");
    const pidFile = join(shared, "browser.pid");
    try {
      const run = runFixture(shared, {
        INFINITARY_FIXTURE_PROGRAM: "browser",
        INFINITARY_FIXTURE_PID: pidFile,
      });
      expect(run.status, run.output).toBe(0);
      const [pid] = fixturePids(pidFile);
      expect(pid).toBeDefined();
      expect(process.kill(Number(pid), 0)).toBe(true);
    } finally {
      stopFixturePids(pidFile);
    }
  }, 120_000);

  it("keeps production descendant protection but lets a finished runner find its own child", async () => {
    const folder = scratchDir("infinitary-run-child-");
    const child = await startHolder(folder);
    try {
      expect(await findFolderHolders([folder])).toEqual({ status: "checked", holders: [] });
      const reading = await findFolderHolders([folder], { protectDescendants: false });
      expect(reading.status).toBe("checked");
      if (reading.status === "checked")
        expect(reading.holders.map((h) => h.pid)).toEqual([child.pid]);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }, 120_000);

  it("ends an abandoned run's holder before sweeping, but leaves a live run's holder alone", async () => {
    const shared = scratchDir("infinitary-abandoned-program-");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const abandoned = join(shared, "infinitary-runs", `unit-${exited.pid}-KILLED`);
    const live = join(shared, "infinitary-runs", `unit-${process.pid}-LIVE00`);
    mkdirSync(abandoned, { recursive: true });
    mkdirSync(live, { recursive: true });
    const leftover = await startHolder(abandoned);
    const running = await startHolder(live);
    const ended = once(leftover, "exit");
    const runningEnded = once(running, "exit");
    try {
      const run = runFixture(shared);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(`(pid ${leftover.pid}): ended`);
      expect(run.output).not.toContain(`(pid ${running.pid})`);
      expect(process.kill(Number(running.pid), 0)).toBe(true);
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      leftover.kill("SIGKILL");
      running.kill("SIGKILL");
      await Promise.all([ended, runningEnded]);
    }
  }, 120_000);

  it("sweeps a root a killed run left, and never one whose run is still going", () => {
    const shared = scratchDir("infinitary-shared-tmp-");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const killedUnit = join(shared, "infinitary-runs", `unit-${exited.pid}-KILLED`);
    const killedE2e = join(shared, "infinitary-runs", `e2e-${exited.pid}-KILLED`);
    const live = join(shared, "infinitary-runs", `e2e-${process.pid}-LIVE00`);
    mkdirSync(join(killedUnit, "infinitary-crew-abcdef"), { recursive: true });
    mkdirSync(join(killedE2e, "infinitary-home-abcdef"), { recursive: true });
    mkdirSync(live, { recursive: true });

    const run = runFixture(shared);

    expect(run.status).toBe(0);
    expect(existsSync(killedUnit)).toBe(false);
    expect(existsSync(killedE2e)).toBe(false);
    expect(readdirSync(join(shared, "infinitary-runs"))).toEqual([`e2e-${process.pid}-LIVE00`]);
  }, 120_000);
});

describe("shared-code process-state guard", () => {
  const sharedConfig = join(__dirname, "fixtures", "shared-code", "vitest.config.ts");
  it("reuses the module cache across two files without leaking process state", () => {
    const run = runFixture(scratchDir("infinitary-shared-code-"), {}, sharedConfig);
    expect(run.status).toBe(0);
    expect(run.output).toContain("2 passed");
  }, 120_000);

  it.each(["env", "clock", "teardown"])(
    "refuses a %s leak instead of silently restoring it",
    (leak) => {
      const run = runFixture(
        scratchDir("infinitary-shared-code-"),
        { INFINITARY_FIXTURE_STATE_LEAK: leak },
        sharedConfig,
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("AssertionError");
      if (leak !== "clock") expect(run.output).toContain("INFINITARY_LEAK_SENTINEL");
    },
    120_000,
  );
});
