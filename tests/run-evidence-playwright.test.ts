import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MIC_PREFLIGHT } from "./e2e/micPreflight";
import { RUNS_DIR, runName } from "./e2e/runEvidence";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * Per-run e2e evidence (tests/e2e/runEvidence.ts, docs/testing.md "Per-run
 * e2e evidence"), through real Playwright runs of a fixture config that uses
 * the suite's own global setup, its microphone check off (the fixture specs
 * open no microphone): a run that starts while another is going
 * keeps its evidence in its own directory and leaves the first one's alone,
 * and a build of the working copy is refused while a run of it is going. The
 * assertions are an order - what the first run had written before the second
 * started - never a wall-clock window.
 */
// Two Playwright runner boots with cold transform caches: sized to the case on
// slow cores (2.4 s fastest of three), which the hosted Linux check resembles.
vi.setConfig({ testTimeout: 15_000 });
const repoRoot = join(__dirname, "..");
const fixtures = join(__dirname, "fixtures", "run-evidence");
const playwrightCli = join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const playwrightConfig = join(fixtures, "playwright.config.ts");
const runs = join(fixtures, "test-results", "runs");

const running = new Set<ChildProcess>();
afterAll(() => {
  for (const child of running) child.kill("SIGKILL");
  // Where the fixture runs kept their evidence (their working copy).
  rmSync(join(fixtures, "test-results"), { recursive: true, force: true });
});

type Run = { text: () => string; exited: Promise<number | null> };

function node(args: string[], cwd: string, env: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  running.add(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      running.delete(child);
      resolve(code);
    });
  });
  return { text: () => output, exited };
}

function playwright(spec: string, env: NodeJS.ProcessEnv): Run {
  return node([playwrightCli, "test", "--config", playwrightConfig, spec], repoRoot, env);
}

/** `pnpm build`'s first step, in the fixture runs' working copy. */
function buildGuard(env: NodeJS.ProcessEnv): Run {
  return node([join(repoRoot, "scripts", "refuse-build-during-e2e.ts")], fixtures, env);
}

/** A fresh fixture working copy, and what its held spec reads and writes. */
function fixtureRuns() {
  rmSync(join(fixtures, "test-results"), { recursive: true, force: true });
  const log = join(scratchDir("infinitary-evidence-log-"), "started.log");
  writeFileSync(log, "");
  const release = join(scratchDir("infinitary-evidence-release-"), "go");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: scratchDir("infinitary-evidence-tmp-"),
    INFINITARY_FIXTURE_LOG: log,
    INFINITARY_FIXTURE_RELEASE: release,
    // Their specs open no microphone. In a virtual Mac the global setup's
    // check would boot Electron first, for up to 20 s, past the wait for the
    // held spec on a slow guest (INF-726).
    [MIC_PREFLIGHT]: "0",
  };
  // This suite's run owns its own temp root; the fixture runs open theirs.
  delete env.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  delete env.INFINITARY_E2E_RUN;
  delete env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE;
  const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { env, release, lines };
}

/** The directory a run printed as its evidence, under the repository. */
function evidenceOf(run: Run): string {
  const printed = /This run's evidence: (.+)\/\n/.exec(run.text())?.[1];
  if (!printed) throw new Error(`no evidence line in:\n${run.text()}`);
  return join(repoRoot, printed);
}

/** The one test's evidence file in a run directory: `<test dir>/evidence.txt`. */
function evidenceFile(runDirectory: string): string {
  const test = readdirSync(runDirectory).find((name) =>
    existsSync(join(runDirectory, name, "evidence.txt")),
  );
  if (!test)
    throw new Error(`no evidence in ${runDirectory}: ${readdirSync(runDirectory).join(", ")}`);
  return join(runDirectory, test, "evidence.txt");
}

describe("each Playwright run's evidence", () => {
  it("lives in its own directory, untouched by a run of the same working copy that starts later", async () => {
    const { env, release, lines } = fixtureRuns();

    const held = playwright("held.spec.ts", env);
    // The spec writes to a file, not the output, so this one is read until it has.
    await vi.waitFor(() => expect(lines()).toEqual(["held"]), { timeout: 12_000, interval: 50 });
    const heldDir = evidenceOf(held);
    expect(readFileSync(evidenceFile(heldDir), "utf8")).toBe("held");

    // A later run starts, writes and finishes while the first is still going.
    const quick = playwright("quick.spec.ts", env);
    expect(await quick.exited).toBe(0);
    const quickDir = evidenceOf(quick);
    expect(quickDir).not.toBe(heldDir);
    expect(readFileSync(evidenceFile(quickDir), "utf8")).toBe("quick");
    expect(readFileSync(evidenceFile(heldDir), "utf8")).toBe("held");

    writeFileSync(release, "");
    expect(await held.exited).toBe(0);
    for (const dir of [heldDir, quickDir]) {
      const result = JSON.parse(readFileSync(join(dir, "e2e-results.json"), "utf8")) as {
        stats: { expected: number; unexpected: number };
      };
      expect(result.stats).toMatchObject({ expected: 1, unexpected: 0 });
    }
    expect(readdirSync(runs).sort()).toEqual(
      [heldDir, quickDir].map((dir) => dir.slice(runs.length + 1)).sort(),
    );
  });
});

describe("a build of a working copy", () => {
  it("is refused while an e2e run of it is going, and goes ahead once the run has finished", async () => {
    const { env, release, lines } = fixtureRuns();
    const held = playwright("held.spec.ts", env);
    await vi.waitFor(() => expect(lines()).toEqual(["held"]), { timeout: 12_000, interval: 50 });
    const heldRun = relative(fixtures, evidenceOf(held));

    const refused = buildGuard(env);
    expect(await refused.exited).toBe(1);
    expect(refused.text()).toContain(`still going (${heldRun}/`);

    writeFileSync(release, "");
    expect(await held.exited).toBe(0);
    // A finished run whose pid now belongs to a later process (this one) is not going.
    const beforeThisProcess = new Date(Date.now() - process.uptime() * 1000 - 60_000);
    mkdirSync(join(fixtures, RUNS_DIR, runName(beforeThisProcess, process.pid)));
    const built = buildGuard(env);
    expect(await built.exited).toBe(0);
    expect(built.text()).toBe("");
  });
});
