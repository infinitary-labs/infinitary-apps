import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  HEAVY_RUN_NEEDS,
  heavyRunWords,
  journeyRunNeeds,
  takeHeavyRunPlace,
} from "../scripts/heavy-run-place";
import { jobCores } from "../scripts/job-cores";
import { AXI_ADDRESS_ENV, AXI_KEY_ENV, AXI_VERSION_ENV } from "../src/core/axi/channel";
import { hostEnv } from "../src/core/hostEnv";
import { LOAD_COMMAND } from "../src/shared/load";
import type { ResourceObservation } from "../src/shared/resources";
import { E2E_MAX_WORKERS } from "./e2e/lanes";
import { MIC_PREFLIGHT } from "./e2e/micPreflight";
import { axiBin, computerLines, declared, repoRoot, start } from "./helpers/heavyRunLine";
import { withoutLoadLine } from "./helpers/noLoadLine";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-1621 piece 3 (INF-1664): a local heavy run - `pnpm test:phone` or a
 * local Playwright journey run - declares its needs in the load line of the
 * computer it runs on and holds them until it ends. INF-2137, the captain's
 * "completely remove fm-placer and any fallback logic now": where the shell
 * has no line the run starts at once, asking nothing else, and says so.
 * Fixture: the real task channel, command processes and native wrappers over
 * a disposable line, admitted by the ordinary-use Mac reading SCR-380 recorded.
 * Failure: a gate that skips the line, declares other needs, starts its tests
 * before admission, keeps its place after it ends, asks a line its shell
 * does not have, or waits for anything where its shell has no line fails
 * here. The order the line saw is the assertion. The phone gate's own case
 * needs a Mac, so it is `heavy-run-place-phone.test.ts`, on the Mac lane's list.
 */
// The wrappers ask again on the line's two-second cadence and the line looks
// for ended groups on it; the budget covers those boundaries and the channel's start.
vi.setConfig({ testTimeout: 25_000 });

// The ordinary-use Mac reading recorded by SCR-380 (src/core/placed/loadLine.integration.test.ts).
const reading: ResourceObservation = {
  epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
  sequence: 1,
  status: "sampled",
  sampleMs: 250,
  cpu: { logicalCpus: 10, idleFraction: 0.77 },
  memory: {
    totalBytes: 25_165_824 * 1024,
    freeBytes: 356_672 * 1024,
    purgeableBytes: 335_184 * 1024,
    fileBackedBytes: 6_852_624 * 1024,
  },
};
const module = pathToFileURL(join(repoRoot, "scripts", "heavy-run-place.ts")).href;
const computerLine = computerLines();

// INF-2165: exercise the actual config through Playwright discovery, without
// launching apps. The fixture below separately witnesses the resolved demand.
// The worker count is the config's own, so each listing loads the config alone:
// `--no-deps` leaves out the lanes a spec's lane depends on, and a filter that
// names no spec loads none. Listing one spec compiled every spec of those lanes
// and all they import, about a thousand files through a cold transform cache,
// work that grows with the suite and outgrew this file's budget on a loaded
// Linux runner.
const NO_SPEC = "no-spec-has-this-name";
it.each([
  { label: "local default", ci: "", args: [], workers: 2 },
  { label: "local override", ci: "", args: ["--workers=4"], workers: 4 },
  {
    label: "CI default",
    ci: "true",
    args: [],
    workers: Math.min(E2E_MAX_WORKERS, jobCores()),
  },
])("journey discovery keeps the $label worker count", async ({ ci, args, workers }) => {
  const run = start(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      NO_SPEC,
      "--no-deps",
      "--pass-with-no-tests",
      "--list",
      "--reporter=json",
      ...args,
    ],
    { ...hostEnv(), CI: ci },
  );
  expect(await run.exited).toBe(0);
  expect(JSON.parse(run.output()).config.workers).toBe(workers);
});

/**
 * A local Playwright run of the fixture config through the e2e global setup,
 * from a task shell: its held spec logs when it starts, then waits for the
 * release file.
 */
function journeyRun(shellEnv: NodeJS.ProcessEnv, args: string[] = []) {
  const fixtures = join(__dirname, "fixtures", "run-evidence");
  const log = join(scratchDir("infinitary-heavy-journey-"), "started.log");
  writeFileSync(log, "");
  const release = join(scratchDir("infinitary-heavy-release-"), "go");
  const env: NodeJS.ProcessEnv = {
    ...shellEnv,
    TMPDIR: scratchDir("infinitary-heavy-tmp-"),
    INFINITARY_FIXTURE_LOG: log,
    INFINITARY_FIXTURE_RELEASE: release,
    // Its specs open no microphone (tests/run-evidence-playwright.test.ts).
    [MIC_PREFLIGHT]: "0",
  };
  delete env.INFINITARY_UNIT_TEMP_ROOT_OWNED;
  delete env.INFINITARY_E2E_RUN;
  delete env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE;
  const cli = join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
  const run = start(
    process.execPath,
    [cli, "test", "--config", join(fixtures, "playwright.config.ts"), "held.spec.ts", ...args],
    env,
  );
  return {
    ...run,
    started: () => readFileSync(log, "utf8"),
    release: () => writeFileSync(release, "go"),
    /** Only this run's own evidence: another file's fixture runs may still be writing theirs. */
    dispose: () => {
      run.child.kill("SIGKILL");
      const printed = /This run's evidence: (.+)\/\n/.exec(run.output())?.[1];
      if (printed) rmSync(join(repoRoot, printed), { recursive: true, force: true });
    },
  };
}

describe("a local heavy run in this computer's load line", () => {
  // INF-2165 approved piece 2: default two workers and an explicit count each
  // declare N processors and 1.5 GiB per worker plus 0.5 GiB before work starts.
  it.each([
    { label: "default two", args: [], workers: 2, memoryMib: 3584 },
    { label: "explicit four", args: ["--workers=4"], workers: 4, memoryMib: 6656 },
  ])(
    "a $label worker journey run holds its resolved declaration until it ends",
    async ({ args, workers, memoryMib }) => {
      const { line, shell, runs, groupExists } = await computerLine();
      const run = journeyRun(shell("journeys"), args);
      const needs = journeyRunNeeds(workers);
      expect(needs).toEqual({ processors: workers, memoryMib });
      const demand = { cpu: workers, memoryBytes: memoryMib * 1024 ** 2 };
      try {
        // No reading yet: the line keeps the run waiting, and its global setup every test.
        await expect.poll(runs).toEqual([{ taskId: "journeys", state: "waiting", demand }]);
        expect(run.started()).toBe("");
        line.observe(reading, null);
        await expect.poll(run.started).toBe("held\n");
        // INF-1700: dash ended the hold at admission. A stale snapshot could pass
        // until the line checked the group, so witness that real check while the
        // journey is still waiting for its release file, even on an idle host.
        groupExists.mockClear();
        await expect
          .poll(() => runs().length === 0 || groupExists.mock.calls.length > 0)
          .toBe(true);
        expect(runs()).toEqual([{ taskId: "journeys", state: "running", demand }]);
        expect(groupExists.mock.results.every(({ value }) => value === true)).toBe(true);
        run.release();
        expect(await run.exited).toBe(0);
        await expect.poll(runs).toEqual([]);
        expect(run.output()).toContain(heavyRunWords.asking("journeys", needs));
        expect(run.output()).toContain(heavyRunWords.admitted("journeys", needs));
        expect(run.output()).not.toContain(heavyRunWords.noLine);
      } finally {
        run.dispose();
      }
    },
  );

  // INF-1700: the dash watcher must keep the input pipe and terminate the
  // waiting process group when its gate dies, before admission can happen.
  it("a local heavy gate stopped while waiting gives its place back without admission", async () => {
    const { shell, runs } = await computerLine();
    const gate = start(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { takeHeavyRunPlace } from ${JSON.stringify(module)};
await takeHeavyRunPlace("journeys");
setInterval(() => {}, 60000);
`,
      ],
      shell("journeys"),
    );
    try {
      await expect
        .poll(runs)
        .toEqual([{ taskId: "journeys", state: "waiting", demand: declared("journeys") }]);
      gate.child.kill("SIGKILL");
      await gate.exited;
      await expect.poll(runs).toEqual([]);
      expect(gate.output()).not.toContain(heavyRunWords.admitted("journeys"));
    } finally {
      gate.child.kill("SIGKILL");
    }
  });

  it("a run that dies while it holds its place gives the place back", async () => {
    const { line, shell, runs } = await computerLine();
    line.observe(reading, null);
    const run = start(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { takeHeavyRunPlace } from ${JSON.stringify(module)};
await takeHeavyRunPlace("journeys", { log: (line) => console.log(line) });
setInterval(() => {}, 60000);
`,
      ],
      shell("journeys"),
    );
    try {
      await expect.poll(run.output).toContain(heavyRunWords.admitted("journeys"));
      expect(runs()).toEqual([
        { taskId: "journeys", state: "running", demand: declared("journeys") },
      ]);
      run.child.kill("SIGKILL");
      await run.exited;
      await expect.poll(runs).toEqual([]);
    } finally {
      run.child.kill("SIGKILL");
    }
  });

  it("a gate inside a run that declared its needs rides that run's hold, and fails when the run declared less", async () => {
    const { line, shell, runs } = await computerLine();
    line.observe(reading, null);
    const program = `
import { takeHeavyRunPlace } from ${JSON.stringify(module)};
const quiet = { log: () => {} };
const journeys = await takeHeavyRunPlace("journeys", quiet);
const phone = await takeHeavyRunPlace("phone", quiet).then(() => "admitted", (error) => error.message);
console.log(JSON.stringify({ journeys: "admitted", phone }));
process.stdin.resume();
process.stdin.once("end", () => journeys.close());
`;
    const { processors, memoryMib } = HEAVY_RUN_NEEDS.journeys;
    // The person declared the journeys' needs for the whole run.
    const outer = start(
      join(axiBin, LOAD_COMMAND),
      [
        "run",
        "--processors",
        `${processors}`,
        "--memory-mib",
        `${memoryMib}`,
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        program,
      ],
      shell("outer"),
    );
    try {
      await expect.poll(outer.output).toContain('"phone"');
      const answer = JSON.parse(outer.output().trim().split("\n").at(-1) as string);
      expect(answer.journeys).toBe("admitted");
      expect(answer.phone).toContain("outer run declared less");
      // The gate inside added no place of its own.
      expect(runs()).toEqual([{ taskId: "outer", state: "running", demand: declared("journeys") }]);
      outer.child.stdin.end();
      expect(await outer.exited).toBe(0);
      await expect.poll(runs).toEqual([]);
    } finally {
      outer.child.kill("SIGKILL");
    }
  });
});

describe("a local heavy run whose shell has no load line", () => {
  it("starts at once and says so, asking no line, for each way a shell has none", async () => {
    const { shell, runs } = await computerLine();
    const commandOnly = { ...withoutLoadLine(hostEnv()) };
    commandOnly.PATH = [axiBin, commandOnly.PATH].join(delimiter);
    for (const name of [AXI_ADDRESS_ENV, AXI_KEY_ENV, AXI_VERSION_ENV]) delete commandOnly[name];
    const shells: Record<string, NodeJS.ProcessEnv> = {
      "no load command": withoutLoadLine(hostEnv()),
      "the command with no task channel": commandOnly,
      "a task the app gives no line": shell("plain", false),
    };
    for (const env of Object.values(shells)) {
      delete env.CI;
      for (const kind of ["phone", "journeys"] as const) {
        const told: string[] = [];
        const place = await takeHeavyRunPlace(kind, { env, log: (line) => told.push(line) });
        place.close();
        expect(told).toEqual([heavyRunWords.noLine]);
      }
    }
    expect(runs()).toEqual([]);
  });

  it("a local journey run from a task the app gives no line starts its tests at once", async () => {
    const { shell, runs } = await computerLine();
    const run = journeyRun(shell("plain", false));
    try {
      // The line never sees the run, and nothing else holds it back.
      await expect.poll(run.started).toBe("held\n");
      expect(runs()).toEqual([]);
      run.release();
      expect(await run.exited).toBe(0);
      expect(run.output()).toContain(heavyRunWords.noLine);
      expect(run.output()).not.toContain(heavyRunWords.asking("journeys"));
    } finally {
      run.dispose();
    }
  });

  // INF-1823: the placement line already owns the borrowed VM's share.
  it.each(["phone", "journeys"] as const)(
    "%s rides a borrowed place without asking the line",
    async (kind) => {
      const { shell, runs } = await computerLine();
      const told: string[] = [];
      const place = await takeHeavyRunPlace(kind, {
        env: { ...shell(kind), CI: "", BORROWED_PLACE: "mini-vm2" },
        log: (line) => told.push(line),
      });
      place.close();
      expect(told).toEqual([heavyRunWords.borrowed("mini-vm2")]);
      expect(runs()).toEqual([]);
    },
  );

  it("asks no line in CI", async () => {
    const { shell, runs } = await computerLine();
    const told: string[] = [];
    const place = await takeHeavyRunPlace("phone", {
      env: { ...shell("phone"), CI: "true" },
      log: (line) => told.push(line),
    });
    place.close();
    expect(told).toEqual([]);
    expect(runs()).toEqual([]);
  });
});
