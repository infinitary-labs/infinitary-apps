import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CrewPlaceKind } from "../scripts/crew-place";
import {
  HEAVY_RUN_NEEDS,
  heavyRunWords,
  journeyRunNeeds,
  takeHeavyRunPlace,
} from "../scripts/heavy-run-place";
import { jobCores } from "../scripts/job-cores";
import { AXI_ADDRESS_ENV, AXI_KEY_ENV, AXI_VERSION_ENV, AxiChannel } from "../src/core/axi/channel";
import { hostEnv } from "../src/core/hostEnv";
import { LoadLine, loadGroupExists } from "../src/core/placed/loadLine";
import { forkChildProcess } from "../src/core/sql/forkChildProcess";
import { LOAD_COMMAND } from "../src/shared/load";
import type { ResourceObservation } from "../src/shared/resources";
import { E2E_MAX_WORKERS } from "./e2e/lanes";
import { MIC_PREFLIGHT } from "./e2e/micPreflight";
import { bundleAxiProcess } from "./helpers/axiProcessBundle";
import { withoutLoadLine } from "./helpers/noLoadLine";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-1621 piece 3 (INF-1664): a local heavy run - `pnpm test:phone` or a
 * local Playwright journey run - declares its needs in the load line of the
 * computer it runs on and holds them until it ends. The captain's "Add the
 * fallback, no alpha needed": where the shell has no line the run asks the
 * Mac mini's crew place service as before, and says which path it took.
 * Fixture: the real task channel, command processes and native wrappers over
 * a disposable line, admitted by the ordinary-use Mac reading SCR-380 recorded;
 * a stand-in crew place service on a scratch socket for the fallback.
 * Failure: a gate that skips the line, declares other needs, starts its tests
 * before admission, keeps its place after it ends, or asks a line its shell
 * does not have fails here. The order the line saw is the assertion.
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
const repoRoot = resolve(__dirname, "..");
const bin = join(repoRoot, "resources", "axi-bin");
const module = pathToFileURL(join(repoRoot, "scripts", "heavy-run-place.ts")).href;
let entry: string;
const closing: (() => void)[] = [];
beforeAll(async () => {
  entry = await bundleAxiProcess();
}, 60_000);
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** What a kind's declaration holds in the line. */
const declared = (kind: CrewPlaceKind) => ({
  cpu: HEAVY_RUN_NEEDS[kind].processors,
  memoryBytes: HEAVY_RUN_NEEDS[kind].memoryMib * 1024 ** 2,
});

/** A computer's line and its task channel, as the app opens them. */
async function computerLine() {
  const dir = scratchDir("infinitary-heavy-run-");
  const groupExists = vi.fn(loadGroupExists);
  const line = new LoadLine({ stateFile: join(dir, "load.json"), groupExists });
  const channel = await AxiChannel.open({
    spawner: forkChildProcess(entry),
    binDir: bin,
    version: "9.9.9-test",
    keysDir: join(dir, "keys"),
  });
  closing.push(
    () => channel.close(),
    () => line.dispose(),
  );
  /** A local task shell: the task's commands first on its PATH, out of CI. */
  const shell = (task: string, load = true): NodeJS.ProcessEnv => {
    const granted = channel.grant(task, load ? { load: line.forTask(task) } : {});
    const env = withoutLoadLine(hostEnv(granted.env));
    env.PATH = [...granted.path, env.PATH].join(delimiter);
    delete env.CI;
    return env;
  };
  const runs = () =>
    line.snapshot().runs.map(({ taskId, state, demand }) => ({ taskId, state, demand }));
  return { line, shell, runs, groupExists };
}

/**
 * A stand-in crew place service (DOP-112's socket contract) that grants each
 * request, on a socket path short enough for macOS.
 */
async function crewPlaces() {
  const path = join(scratchDir("crew-"), "s.sock");
  const asked: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    createInterface({ input: socket }).once("line", (line) => {
      asked.push(JSON.parse(line));
      socket.write(`${JSON.stringify({ state: "granted", place: "mini-crew1" })}\n`);
    });
  });
  closing.push(() => server.close());
  await new Promise<void>((done) => server.listen(path, done));
  return { path, asked };
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, detached = false) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });
  const exited = new Promise<number | null>((done) => child.once("close", done));
  return { child, output: () => output, exited };
}

// INF-2165: exercise the actual config through Playwright discovery, without
// launching apps. The fixture below separately witnesses the resolved demand.
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
      "tests/e2e/cap-gate.spec.ts",
      "--list",
      "--reporter=json",
      ...args,
    ],
    { ...hostEnv(), CI: ci },
  );
  expect(await run.exited).toBe(0);
  expect(JSON.parse(run.output()).config.workers).toBe(workers);
});

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
      const fixtures = join(__dirname, "fixtures", "run-evidence");
      const log = join(scratchDir("infinitary-heavy-journey-"), "started.log");
      writeFileSync(log, "");
      const release = join(scratchDir("infinitary-heavy-release-"), "go");
      const env: NodeJS.ProcessEnv = {
        ...shell("journeys"),
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
      const needs = journeyRunNeeds(workers);
      expect(needs).toEqual({ processors: workers, memoryMib });
      const demand = { cpu: workers, memoryBytes: memoryMib * 1024 ** 2 };
      try {
        // No reading yet: the line keeps the run waiting, and its global setup every test.
        await expect.poll(runs).toEqual([{ taskId: "journeys", state: "waiting", demand }]);
        expect(readFileSync(log, "utf8")).toBe("");
        line.observe(reading, null);
        await expect.poll(() => readFileSync(log, "utf8")).toBe("held\n");
        // INF-1700: dash ended the hold at admission. A stale snapshot could pass
        // until the line checked the group, so witness that real check while the
        // journey is still waiting for its release file, even on an idle host.
        groupExists.mockClear();
        await expect
          .poll(() => runs().length === 0 || groupExists.mock.calls.length > 0)
          .toBe(true);
        expect(runs()).toEqual([{ taskId: "journeys", state: "running", demand }]);
        expect(groupExists.mock.results.every(({ value }) => value === true)).toBe(true);
        writeFileSync(release, "go");
        expect(await run.exited).toBe(0);
        await expect.poll(runs).toEqual([]);
        expect(run.output()).toContain(heavyRunWords.asking("journeys", needs));
        expect(run.output()).toContain(heavyRunWords.admitted("journeys", needs));
        expect(run.output()).not.toContain(heavyRunWords.noLine);
      } finally {
        run.child.kill("SIGKILL");
        // Only this run's own evidence: another file's fixture runs may still be writing theirs.
        const printed = /This run's evidence: (.+)\/\n/.exec(run.output())?.[1];
        if (printed) rmSync(join(repoRoot, printed), { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "a local phone gate asks with its declared needs before it builds anything, and leaves the line when stopped while it waits",
    async () => {
      const { shell, runs } = await computerLine();
      const evidence = scratchDir("infinitary-heavy-phone-evidence-");
      // A shell's job: the gate leads a process group of its own.
      const gate = start(
        process.execPath,
        ["scripts/test-phone.ts", "--both", "--evidence", evidence],
        { ...shell("phone"), INFINITARY_CHECKS: "local" },
        true,
      );
      const group = -(gate.child.pid as number);
      try {
        await expect
          .poll(runs)
          .toEqual([{ taskId: "phone", state: "waiting", demand: declared("phone") }]);
        // The whole group stops with no chance to close its place, as when the app quits.
        process.kill(group, "SIGKILL");
        await gate.exited;
        await expect.poll(runs).toEqual([]);
        expect(gate.output()).toContain(heavyRunWords.asking("phone"));
        expect(gate.output()).not.toContain("xcodebuild");
      } finally {
        try {
          process.kill(group, "SIGKILL");
        } catch {}
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
await takeHeavyRunPlace("journeys", "journeys");
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
await takeHeavyRunPlace("journeys", "journeys", { log: (line) => console.log(line) });
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
const journeys = await takeHeavyRunPlace("journeys", "journeys", quiet);
const phone = await takeHeavyRunPlace("phone", "test:phone", quiet).then(() => "admitted", (error) => error.message);
console.log(JSON.stringify({ journeys: "admitted", phone }));
process.stdin.resume();
process.stdin.once("end", () => journeys.close());
`;
    const { processors, memoryMib } = HEAVY_RUN_NEEDS.journeys;
    // The person declared the journeys' needs for the whole run.
    const outer = start(
      join(bin, LOAD_COMMAND),
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
  it("asks the Mac mini's crew place service and says so", async () => {
    const { shell } = await computerLine();
    const service = await crewPlaces();
    const commandOnly = { ...withoutLoadLine(hostEnv()) };
    commandOnly.PATH = [bin, commandOnly.PATH].join(delimiter);
    for (const name of [AXI_ADDRESS_ENV, AXI_KEY_ENV, AXI_VERSION_ENV]) delete commandOnly[name];
    const shells: Record<string, NodeJS.ProcessEnv> = {
      "no load command": withoutLoadLine(hostEnv()),
      "the command with no task channel": commandOnly,
      "a task the app gives no line": shell("plain", false),
    };
    for (const [label, env] of Object.entries(shells)) {
      delete env.CI;
      const told: string[] = [];
      const place = await takeHeavyRunPlace("journeys", label, {
        env: { ...env, INFINITARY_CREW_PLACE_SOCKET: service.path },
        log: (line) => told.push(line),
      });
      place.close();
      expect(told[0]).toBe(heavyRunWords.noLine);
    }
    expect(service.asked.map(({ kind, label }) => [kind, label])).toEqual(
      Object.keys(shells).map((label) => ["journeys", label]),
    );
  });

  // INF-1823: the placement line already owns the borrowed VM's share.
  it.each(["phone", "journeys"] as const)(
    "%s rides a borrowed place without asking either line",
    async (kind) => {
      const { shell, runs } = await computerLine();
      const service = await crewPlaces();
      const told: string[] = [];
      const place = await takeHeavyRunPlace(kind, "borrowed run", {
        env: {
          ...shell(kind),
          CI: "",
          BORROWED_PLACE: "mini-vm2",
          INFINITARY_CREW_PLACE_SOCKET: service.path,
        },
        log: (line) => told.push(line),
      });
      place.close();
      expect(told).toEqual([heavyRunWords.borrowed("mini-vm2")]);
      expect(runs()).toEqual([]);
      expect(service.asked).toEqual([]);
    },
  );

  it("asks neither the line nor the crew place service in CI", async () => {
    const { shell, runs } = await computerLine();
    const service = await crewPlaces();
    const told: string[] = [];
    const place = await takeHeavyRunPlace("phone", "test:phone", {
      env: { ...shell("phone"), CI: "true", INFINITARY_CREW_PLACE_SOCKET: service.path },
      log: (line) => told.push(line),
    });
    place.close();
    expect(told).toEqual([]);
    expect(runs()).toEqual([]);
    expect(service.asked).toEqual([]);
  });
});
