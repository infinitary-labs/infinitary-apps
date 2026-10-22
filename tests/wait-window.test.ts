import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { waitWindow } from "./helpers/waitWindow";

// INF-857, the captain: "we should fix the tests instead and make them robust
// even during heavy load", and his choice: "Grade durations only on a quiet
// run, as journeys already do. Elsewhere a test waits for its event with no
// clock, and the job's own time limit stops a stuck one". A busy Mac freezes
// a test's processes for seconds at a time (INF-719 measured stalls of up to
// 11.5 s); these hold a test, and a wait inside it, to its work there.
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

/** A vitest run of its own over `tests/fixtures/frozen-work`, graded or not. */
async function frozenRun(grades: boolean): Promise<{ status: number | null; output: string }> {
  // Its own temp folder: a graded run ends with the frozen work's folder still there.
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratchDir("infinitary-frozen-tmp-") };
  delete env.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  if (grades) env.INFINITARY_PERF_BUDGETS = "1";
  else delete env.INFINITARY_PERF_BUDGETS;
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      join(__dirname, "fixtures", "frozen-work", "vitest.config.ts"),
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { status, output };
}

describe("a wait for a state, on a Mac that freezes the work", () => {
  it("lasts until the state arrives: expect.poll and vi.waitFor", async () => {
    const dir = scratchDir("infinitary-wait-window-");
    const polled = join(dir, "polled");
    const waited = join(dir, "waited");
    const polling = expect.poll(() => existsSync(polled)).toBe(true);
    const waiting = vi.waitFor(() => expect(existsSync(waited)).toBe(true));
    await Promise.all([frozenWriter(polled), frozenWriter(waited), polling, waiting]);
  });

  it("has no window on an ordinary run, and the test's budget on a graded one", () => {
    const test = { timeout: 10_000, startedAt: 1_000 };
    const ordinary = { grades: false, test, now: 4_000 };
    expect(waitWindow(undefined, ordinary)).toBe(2 ** 31 - 1);
    expect(waitWindow(100, ordinary)).toBe(2 ** 31 - 1);

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

describe("a test's time limit", () => {
  it("lets work the Mac froze past it finish on an ordinary run, and holds it on a graded one", async () => {
    const [ordinary, graded] = await Promise.all([frozenRun(false), frozenRun(true)]);
    expect(ordinary.output).toContain("1 passed");
    expect(ordinary.status).toBe(0);
    expect(graded.output).toContain("Test timed out in 500ms");
    expect(graded.status).toBe(1);
  }, 60_000);
});
