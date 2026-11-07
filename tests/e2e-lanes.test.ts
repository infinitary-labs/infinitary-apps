import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { expect, it } from "vitest";
import { laneFiles } from "../scripts/journey-groups.ts";
import { E2E_PROJECTS } from "./e2e/lanes";
import { MAC_ONLY_TAG } from "./e2e/tags";
import { scratchDir } from "./helpers/scratchDirs";

type Suite = {
  title?: string;
  specs?: { file: string; line: number; title: string; tests: { projectName: string }[] }[];
  suites?: Suite[];
};

// `playwright --list` loads every spec and all it imports through a cold transform cache, so its
// work grows with the suite: Linux fastest 35.7 s in an integration shard (docs/test-cohorts.md).
it("collects every spec once, isolates app boundaries and serializes voice, paint budgets and load-sensitive journeys", () => {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--list", "--reporter=json"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ),
  ) as { suites: Suite[] };
  const collected: { key: string; file: string; lane: string }[] = [];
  function visit(suite: Suite, ancestors: string[] = []) {
    const path = [...ancestors, suite.title ?? ""];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests)
        collected.push({
          key: `${path.join("/")}:${spec.file}:${spec.line}:${spec.title}`,
          file: spec.file,
          lane: test.projectName,
        });
    }
    for (const child of suite.suites ?? []) visit(child, path);
  }
  report.suites.forEach((suite) => {
    visit(suite);
  });
  expect(collected.length).toBeGreaterThan(0);
  expect(new Set(collected.map((test) => test.key)).size).toBe(collected.length);
  expect([...new Set(collected.map((test) => test.file))].sort()).toEqual(
    [
      ...readdirSync("tests/e2e").filter((file) => file.endsWith(".spec.ts")),
      ...readdirSync("tests/renderer")
        .filter((file) => file.endsWith(".spec.ts"))
        .map((file) => `../renderer/${file}`),
    ].sort(),
  );
  const serialFiles = [
    // Voice: the dictation key and the microphone.
    "phase1-shell.spec.ts",
    "phase6-voice.spec.ts",
    "first-launch.spec.ts",
    "mic-access.spec.ts",
    // Paint budgets, graded on a quiet host.
    "rail-panels.spec.ts",
    "now-panel.spec.ts",
    // A demo recording, at real speed.
    "card-demo.spec.ts",
    // Under the parallel lanes' load, adding a Mac by its address outlasts its wait.
    "devices.spec.ts",
    "devices-links.spec.ts",
    "devices-command.spec.ts",
    "devices-address.spec.ts",
    "devices-ssh.spec.ts",
    // INF-1129 controls CPU input, but live memory remains; no parallel-lane qualification yet.
    "automatic-placement.spec.ts",
    // INF-741: a tile's summary lets go when its window loses focus, which another
    // window can take on Linux's shared screen.
    "task-board.spec.ts",
    // Its packaged launch ignores the per-test connection-port override.
    "integrations-google.spec.ts",
  ];
  const applicationFiles = [
    // INF-1258: the captain asked to move the reviewed recent journeys into parallel.
    "copilot-sign-in.spec.ts",
    "crew-board-delta.spec.ts",
    "integrations-inbox.spec.ts",
    "macos-privacy.spec.ts",
    "move-task.spec.ts",
    "panel-header-alignment.spec.ts",
    "program-grouping.spec.ts",
    "program-run.spec.ts",
    "project-focus.spec.ts",
    "record-pointer.spec.ts",
    "reply-progress.spec.ts",
    "row-press-card-appears.spec.ts",
    "self-merge-note.spec.ts",
    "task-browser-form-reload.spec.ts",
    "task-browser-sign-ins.spec.ts",
    "task-browser-user-agent.spec.ts",
    "waiting-crewmate.spec.ts",
    "phase0-guardrails.spec.ts",
    "card-containment.spec.ts",
    "card-effect-gate.spec.ts",
    "card-scripts.spec.ts",
    "sharing.spec.ts",
    "preferences.spec.ts",
    "quota-live-sensor.spec.ts",
    "personal-panels-hardening.spec.ts",
    "settle-effects.spec.ts",
    "rigor-reviewed.spec.ts",
    "phase2-crewmate.spec.ts",
    "run-work.spec.ts",
    "task-browser-booking.spec.ts",
    // The task browser's journey, split in four, keeps its lane.
    "task-browser.spec.ts",
    "task-browser-handoff.spec.ts",
    "task-browser-saved-sign-ins.spec.ts",
    "task-browser-view.spec.ts",
    // INF-741: reviewed and run under the parallel lanes' load.
    "phase4-cards.spec.ts",
    "personal-panels.spec.ts",
    "phase7-shellops.spec.ts",
  ];
  for (const file of [...serialFiles, ...applicationFiles]) {
    const tests = collected.filter((test) => test.file === file);
    expect(tests.length, file).toBeGreaterThan(0);
    expect(
      tests.every((test) => test.lane === (serialFiles.includes(file) ? "desktop" : "application")),
      file,
    ).toBe(true);
  }
  // INF-2987: the journey groups split each lane's files as Playwright assigns them.
  const filesIn = (lanes: string[]) =>
    [
      ...new Set(
        collected
          .filter((test) => lanes.includes(test.lane))
          .map((test) => posix.join("tests/e2e", test.file)),
      ),
    ].toSorted();
  expect(laneFiles("parallel")).toEqual(filesIn(["styles", "renderer", "application"]));
  expect(laneFiles("desktop")).toEqual(filesIn(["desktop"]));
  const desktop = E2E_PROJECTS.find((project) => project.name === "desktop");
  expect(desktop?.workers).toBe(1);
  for (const name of ["styles", "renderer", "application"]) {
    expect(E2E_PROJECTS.find((project) => project.name === name)?.teardown).toBe("desktop");
  }
}, 180_000);

// Real runner boots: ~1s per invocation; the rejection matrix gets a 60s budget.
it("refuses local full runs before setup and points to on-demand CI", () => {
  for (const args of [
    [],
    ["--project=desktop"],
    ["--grep", "journey"],
    ["--last-failed"],
    ["--grep", "phase0-guardrails.spec.ts"],
    ["tests/e2e/.*.spec.ts"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", ...args],
      { encoding: "utf8", env: { ...process.env, CI: "" } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Full end-to-end runs are CI-only");
    expect(result.stderr).toContain("gh workflow run verify.yml --ref <branch>");
    expect(result.stdout).not.toContain("This run's evidence:");
  }
}, 60_000);

// The real lanes over fixture specs, with app fixtures removed: a full run never
// stops at its first failure, and desktop still runs after the parallel lanes fail.
it("reports every failure and still runs later tests and the desktop lane", () => {
  const dir = scratchDir("infinitary-lane-failures-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const testModule = join(process.cwd(), "node_modules/@playwright/test/index.mjs");
  const spec = (name: string, body: string) =>
    writeFileSync(
      join(dir, name),
      `import { test, expect } from ${JSON.stringify(testModule)};\n${body}`,
    );
  // Named after application suites, so the real lanes place them.
  spec(
    "run-work.spec.ts",
    `test('fails early', () => expect(1).toBe(2));
    test('passes after a failure in its file', () => expect(2 + 2).toBe(4));`,
  );
  spec(
    "task-browser-booking.spec.ts",
    `test('passes first', () => expect(2 + 2).toBe(4));
    test('fails later', () => expect(1).toBe(2));`,
  );
  spec("view.spec.ts", `test('passes beside the failures', () => expect(2 + 2).toBe(4));`);
  // In no reviewed list, so it defaults to desktop.
  spec("native-focus.spec.ts", `test('runs on desktop', () => expect(2 + 2).toBe(4));`);
  const results = join(dir, "results.json");
  const config = join(dir, "playwright.config.ts");
  mkdirSync(join(dir, "output"));
  writeFileSync(
    config,
    `import config from ${JSON.stringify(join(process.cwd(), "playwright.config.ts"))};
    import { E2E_PROJECTS } from ${JSON.stringify(join(process.cwd(), "tests/e2e/lanes.ts"))};
    export default { ...config, testDir: ${JSON.stringify(dir)}, globalSetup: undefined,
      tsconfig: ${JSON.stringify(join(process.cwd(), "tsconfig.node.json"))},
      // styles reads tests/renderer beside the config; the lanes under test are the rest.
      projects: E2E_PROJECTS.filter((project) => project.name !== 'styles'),
      reporter: [['json', { outputFile: ${JSON.stringify(results)} }]],
      outputDir: ${JSON.stringify(join(dir, "output"))} };`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const run = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--config", config],
    { encoding: "utf8", env },
  );
  expect(run.status, run.stdout + run.stderr).toBe(1);
  type Result = { status: string; startTime: string; duration: number };
  type RunSuite = {
    specs?: { title: string; tests: { projectName: string; results: Result[] }[] }[];
    suites?: RunSuite[];
  };
  const ran: {
    title: string;
    lane: string;
    status: string;
    start: number;
    end: number;
  }[] = [];
  const visit = (suite: RunSuite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests)
        for (const result of test.results) {
          const start = Date.parse(result.startTime);
          ran.push({
            title: spec.title,
            lane: test.projectName,
            status: result.status,
            start,
            end: start + result.duration,
          });
        }
    for (const child of suite.suites ?? []) visit(child);
  };
  const report = JSON.parse(readFileSync(results, "utf8")) as { suites: RunSuite[] };
  for (const suite of report.suites) visit(suite);
  const status = Object.fromEntries(ran.map((test) => [test.title, `${test.lane} ${test.status}`]));
  expect(status).toEqual({
    "fails early": "application failed",
    "passes after a failure in its file": "application passed",
    "passes first": "application passed",
    "fails later": "application failed",
    "passes beside the failures": "application passed",
    "runs on desktop": "desktop passed",
  });
  const desktop = ran.find((test) => test.lane === "desktop");
  const lastApplication = Math.max(
    ...ran.filter((test) => test.lane === "application").map((test) => test.end),
  );
  expect(desktop?.start).toBeGreaterThanOrEqual(lastApplication);
}, 60_000);

// INF-2480 and INF-2641's mac-filter: main's Mac lane runs only the tests tagged
// MAC_ONLY_TAG. The command line's --grep skips the desktop lane, the others'
// teardown, which ran every untagged journey too; the config's tag reaches
// every lane, and desktop still runs after the parallel lanes.
it("keeps every lane, the desktop teardown included, to the tag a run names", () => {
  const dir = scratchDir("infinitary-lane-tag-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const testModule = join(process.cwd(), "node_modules/@playwright/test/index.mjs");
  const tagged = (lane: string) =>
    `test('${lane} needs a Mac', { tag: ${JSON.stringify(MAC_ONLY_TAG)} }, () => expect(1).toBe(1));
    test('${lane} runs anywhere', () => expect(1).toBe(1));`;
  const spec = (name: string, body: string) =>
    writeFileSync(
      join(dir, name),
      `import { test, expect } from ${JSON.stringify(testModule)};\n${body}`,
    );
  // An application suite and a file in no reviewed list, which defaults to desktop.
  spec("view.spec.ts", tagged("application"));
  spec("native-focus.spec.ts", tagged("desktop"));
  const results = join(dir, "results.json");
  const config = join(dir, "playwright.config.ts");
  mkdirSync(join(dir, "output"));
  writeFileSync(
    config,
    `import config from ${JSON.stringify(join(process.cwd(), "playwright.config.ts"))};
    import { E2E_PROJECTS } from ${JSON.stringify(join(process.cwd(), "tests/e2e/lanes.ts"))};
    export default { ...config, testDir: ${JSON.stringify(dir)}, globalSetup: undefined,
      tsconfig: ${JSON.stringify(join(process.cwd(), "tsconfig.node.json"))},
      projects: E2E_PROJECTS.filter((project) => project.name !== 'styles'),
      reporter: [['json', { outputFile: ${JSON.stringify(results)} }]],
      outputDir: ${JSON.stringify(join(dir, "output"))} };`,
  );
  type RunSuite = {
    specs?: {
      title: string;
      tests: { projectName: string; results: { startTime: string; duration: number }[] }[];
    }[];
    suites?: RunSuite[];
  };
  const ranWith = (tag: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", INFINITARY_E2E_TAG: tag };
    delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    const run = spawnSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", config],
      { encoding: "utf8", env },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const ran: { title: string; lane: string; start: number; end: number }[] = [];
    const visit = (suite: RunSuite) => {
      for (const spec of suite.specs ?? [])
        for (const test of spec.tests)
          for (const result of test.results) {
            const start = Date.parse(result.startTime);
            ran.push({
              title: spec.title,
              lane: test.projectName,
              start,
              end: start + result.duration,
            });
          }
      for (const child of suite.suites ?? []) visit(child);
    };
    for (const suite of (JSON.parse(readFileSync(results, "utf8")) as { suites: RunSuite[] })
      .suites)
      visit(suite);
    return ran;
  };
  const tagOnly = ranWith(MAC_ONLY_TAG);
  expect(tagOnly.map((test) => `${test.lane}: ${test.title}`).sort()).toEqual([
    "application: application needs a Mac",
    "desktop: desktop needs a Mac",
  ]);
  const desktop = tagOnly.find((test) => test.lane === "desktop");
  const application = tagOnly.find((test) => test.lane === "application");
  expect(desktop?.start).toBeGreaterThanOrEqual(application?.end ?? Number.POSITIVE_INFINITY);
  // No tag keeps every test, as an alpha's run of every journey.
  expect(ranWith("")).toHaveLength(4);
}, 60_000);

// A harmless journey through the real project config, with app fixtures removed:
// the runner starts workers, which reload the config without CLI file arguments.
for (const ci of ["", "true"]) {
  it(`executes ${ci ? "an unfiltered CI run" : "a focused local file"} through the project config`, () => {
    const dir = scratchDir("infinitary-ci-only-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const spec = join(dir, "probe.spec.ts");
    // Resolve Playwright from the project, not from the scratch directory.
    const testModule = join(process.cwd(), "node_modules/@playwright/test/index.mjs");
    writeFileSync(
      spec,
      `import { test, expect } from ${JSON.stringify(testModule)};
      test('the selected journey runs', () => expect(2 + 2).toBe(4));`,
    );
    const config = join(dir, "playwright.config.ts");
    mkdirSync(join(dir, "output"));
    writeFileSync(
      config,
      `import config from ${JSON.stringify(join(process.cwd(), "playwright.config.ts"))};
      export default { ...config, testDir: ${JSON.stringify(dir)}, globalSetup: undefined,
        tsconfig: ${JSON.stringify(join(process.cwd(), "tsconfig.node.json"))},
        projects: [{ name: 'probe' }], reporter: 'line',
        outputDir: ${JSON.stringify(join(dir, "output"))} };`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        config,
        "--workers",
        "1",
        ...(ci ? [] : [spec]),
      ],
      { encoding: "utf8", env: { ...process.env, CI: ci } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("1 passed");
    console.info(`${ci ? "CI unfiltered" : "Local focused"}:\n${result.stdout}`);
  }, 60_000);
}
