import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The run-level temp guard (tests/helpers/runTempRoot.ts), driven through a
 * real vitest run of its own: a run's scratch lives in one private TMPDIR,
 * what a test forgot fails the run by name, and nothing reaches the shared
 * temp directory either way.
 */
const repoRoot = join(__dirname, "..");
const config = join(__dirname, "fixtures", "temp-leak", "vitest.config.ts");

function runFixture(sharedTmp: string, env: Record<string, string> = {}, fixtureConfig = config) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, TMPDIR: sharedTmp };
  // This suite's own run owns its root; the fixture run must open its own.
  delete childEnv.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", fixtureConfig],
    { cwd: repoRoot, env: childEnv, encoding: "utf8", timeout: 90_000 },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
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
