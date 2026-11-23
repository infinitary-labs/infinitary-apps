import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { importsOf } from "../scripts/affected-journeys";
import {
  chooseRequest,
  GENERATED_CONTRACT,
  phoneDecision,
  type RequestSelection,
  requestJobs,
  requestPasses,
  requestStopsEarly,
} from "../scripts/affected-phone";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { PHONE_DEVICES, PHONE_PART_TIMES, PHONE_PARTS } from "../scripts/phone-test-plan";
import { workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-79 / INF-136: the captain requested a Mac mini lane for phone changes; since INF-2139 it
// runs on request and in the phone release, never on a pull request.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/phone.yml", "utf8"));
// The native job, and the one step that runs both device gates (INF-2101).
const NATIVE_JOB = "native-phone";
const BOTH = "Read and recover on iPhone and iPad";

// The native job's condition with its gate step's (INF-2125 P1: the job chooses its own parts).
function gateCondition(): string {
  const scope = (workflow.jobs["native-phone"].steps as { id?: string; env?: { GATE: string } }[])
    .find((step) => step.id === "scope")!
    .env!.GATE.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return `(${workflow.jobs["native-phone"].if}) && (${scope})`;
}
// INF-5387's plan, piece 2: the recorded part times the chooser deals a request's passes by, and a request's selection
// as the chooser reads it, here of the iPhone's reached parts.
const TIMES = JSON.parse(readFileSync(PHONE_PART_TIMES, "utf8"));
const EVERY_PART = PHONE_PARTS.map((part) => part.name);
const selection = (over: Partial<RequestSelection> = {}): RequestSelection => ({
  devices: ["iphone"],
  kept: ["rest"],
  iphoneOnly: [],
  ipadParts: [],
  duoParts: [],
  repeats: [],
  repeatTests: {},
  full: false,
  named: false,
  ...over,
});
// Today's complete request, every part on every device, as the chooser deals it.
const FULL = selection({ devices: ["every"], kept: EVERY_PART, full: true });
const FULL_JOBS = requestJobs(FULL, TIMES);
// Whether the device gate starts in a request's first job: the chooser deals no job when its decision does not run
// (scripts/affected-phone.ts), and a default request (run "") chooses every part.
function eligible(run: boolean | "", evidenceRun = ""): string {
  const jobs = run === false ? [] : run === "" ? FULL_JOBS : requestJobs(selection(), TIMES);
  return String(
    holds(gateCondition(), {
      github: { event_name: "workflow_dispatch" },
      needs: { request: { outputs: { jobs: JSON.stringify(jobs) } } },
      matrix: jobs[0] ?? {},
      inputs: { evidence_run: evidenceRun, affected: run !== "", parts: "" },
    }),
  );
}

// INF-2202: old switch values must no longer redirect, suppress setup or create clones.
const OFF = "";
const IN_TURN = "in-turn";
const TOGETHER = "together";
const VIRTUAL_MAC_STEPS = ["Start a fresh virtual Mac", "Delete the virtual Mac"];
type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
};
type Plain = { [key: string]: string | number | boolean | Plain | readonly unknown[] };
const STATUS = ["success", "always", "cancelled", "failure"];

function toData(value: Plain): data.Dictionary {
  return JSON.parse(JSON.stringify(value), data.reviver) as data.Dictionary;
}

// Whether a workflow expression holds, as GitHub reads its truthiness.
function holds(
  expression: string,
  contexts: Plain,
  status: { failed?: boolean; cancelled?: boolean } = {},
): boolean {
  contexts = {
    needs: {},
    env: {},
    steps: {},
    inputs: {},
    matrix: { device: "iphone" },
    ...contexts,
  };
  const bare = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const functions = STATUS.map((name) => ({ name, minArgs: 0, maxArgs: 0 }));
  const values: Record<string, boolean> = {
    success: !status.failed && !status.cancelled,
    always: true,
    cancelled: Boolean(status.cancelled),
    failure: Boolean(status.failed),
  };
  const ast = new Parser(
    new Lexer(`!!(${bare})`).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const calls = new Map(
    functions.map((f) => [
      f.name,
      { ...f, call: () => new data.BooleanData(Boolean(values[f.name])) },
    ]),
  );
  return new Evaluator(ast, toData(contexts), calls).evaluate().coerceString() === "true";
}

// A step's condition with GitHub's implied success() when it names no status function.
function condition(step: Step): string {
  const written = step.if ? String(step.if).replace(/^\$\{\{\s*|\s*\}\}$/g, "") : "success()";
  return STATUS.some((name) => written.includes(`${name}()`))
    ? written
    : `success() && (${written})`;
}

// A request's first attempt; a rerun of a failed job is its own (INF-4496's fix 2).
const BRANCH_REQUEST = {
  event_name: "workflow_dispatch",
  ref: "refs/heads/fm/task-1",
  run_attempt: "1",
};
// The native job's steps that run, in order, for a value of the switch, with every
// step succeeding (or the job failed, when `failed`); `outputs` gives a step's other
// outputs by its id.
function stepsThatRun(
  virtualMac: string,
  failed = false,
  inputs: Plain = {},
  github: Plain = BRANCH_REQUEST,
  outputs: Record<string, Plain> = {},
  matrix: Plain = { device: "iphone", key: "iphone" },
  strategy: Plain = { "job-total": 1 },
): Step[] {
  const seen: Plain = {};
  const ran: Step[] = [];
  for (const step of workflow.jobs[NATIVE_JOB].steps as Step[]) {
    const runs = holds(
      condition(step),
      {
        env: {},
        steps: seen,
        needs: {},
        vars: { PHONE_VIRTUAL_MAC: virtualMac },
        inputs,
        github,
        matrix,
        strategy,
      },
      { failed },
    );
    // The chooser kept parts (gateCondition).
    const gate = runs && step.id === "scope" ? "true" : "";
    if (step.id)
      seen[step.id] = {
        outcome: runs ? "success" : "skipped",
        outputs: { gate, ...(runs ? outputs[step.id] : {}) },
      };
    if (runs) ran.push(step);
  }
  return ran;
}
const RESULTS = "Keep native results and connection readings";
const SAVE_PACKAGES = "Save the Swift packages from main";
const KEEP_PASSES = "Keep the passes for a rerun of this job";
// INF-6039's plan, part 1: a dealt request's first job builds and shares, its other jobs fetch; a call runs none of them.
const BUILD_ONCE = "Build the app once for this check's jobs";
const SHARE_BUILD = "Share the build with this check's other jobs";
const FETCH_BUILD = "Fetch the build this check's first job shared";
const SHARED_BUILD_STEPS = [BUILD_ONCE, SHARE_BUILD, FETCH_BUILD];
// The steps a plain branch request skips: none since INF-2582, whose edited-part passes ride the
// ordinary gate and its evidence.
const SKIPPED_STEPS: string[] = [];
const names = (steps: Step[]) => steps.map((step) => step.name ?? step.uses ?? "");
const isGate = (step: Step) => step.name === BOTH;

describe("the native gate on an affected request", () => {
  it.each([
    "ios/Infinitary/InfinitaryApp/PhoneModel.swift",
    "scripts/generate-phone-contract.ts",
    "scripts/generate-phone-cards.ts",
    "scripts/phone-contract-shapes.ts",
    ".github/workflows/phone.yml",
    "scripts/test-phone.ts",
    "tests/helpers/phoneHome.ts",
    "tests/helpers/phoneScene.ts",
    "scripts/generate-phone-scene.ts",
    "scripts/phone-recording.ts",
    // INF-355: changing the native registration witness must exercise its simulator consumer.
    "tests/helpers/phoneKeyboard.ts",
    // INF-663: the gate's checks before its simulator tests.
    "scripts/phone-checks.ts",
    "scripts/phone-activity.ts",
    // INF-1596: the gate's start removes what killed runs left.
    "scripts/phone-leftovers.ts",
    "scripts/phone-test-plan.ts",
    // INF-1552: the extracted selector still reaches the device gate.
    "scripts/phone-simulator.ts",
    // INF-1645: a new pin must start the device gate on the pinned simulator.
    "scripts/phone-pin.json",
    // INF-1936 / INF-2185: an edit to one new runner-side diagnostic still reaches its native consumer.
    "scripts/phone-guest-observer.ts",
    "tests/helpers/phoneWebStacks.ts",
    "tests/helpers/phoneGuestLaunches.ts",
    "tests/helpers/phoneLauncherLog.ts",
    "tests/helpers/phoneLookupWait.ts",
    "tests/helpers/phoneProxyLaunches.ts",
    // INF-1242: the rest of what the launcher loads or reads on every part. Each module it loads is
    // named here, so a change to one runs the walk below.
    "tests/helpers/phoneLogs.ts",
    "tests/helpers/phoneStacks.ts",
    "tests/helpers/phoneWebContent.ts",
    "tests/helpers/phonePhotos.ts",
    "tests/helpers/budgets.ts",
    "tests/helpers/loadClock.ts",
    "tests/helpers/scratchDirs.ts",
    "tests/helpers/runScratchFolders.ts",
    "scripts/moduleRunner.ts",
    "scripts/checks-mode.ts",
    "scripts/heavy-run-place.ts",
    "scripts/phone-hinge.ts",
    "scripts/phone-hinge.m",
    "scripts/phone-work.json",
    "scripts/phone-part-times.json",
    "release-notes/pictures/activity-settles-setting-runs-light.png",
    // INF-1242: the test home's Google sign-in stand-in.
    "tests/helpers/phoneGoogle.ts",
    // INF-2625: the test home's crewmates and first mate are the journey stand-in's.
    "tests/e2e/mockProvider.ts",
    "tests/e2e/crewScripts.ts",
    "tests/e2e/mockModels.ts",
    "tests/e2e/providerRequest.ts",
    // INF-3563: the script the phone's Settings pages are built by, and the test home's accounts, rules and usage.
    "scripts/generate-phone-settings.ts",
    "tests/helpers/phoneSettings.ts",
  ])("runs the actual workflow condition when %s changes", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("true");
  });
  // INF-1242: every module the launcher loads selects the gate, so a change to one alone cannot
  // pass with no phone check. The walk leaves out the app's own code under src/, which alone never
  // selects the gate (INF-79 / INF-136), and stops at the test home, whose own helpers are chosen
  // one by one above.
  it("runs the actual workflow condition for every module the launcher loads", () => {
    const read = (file: string) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    };
    const loaded = new Set<string>();
    const walk = (file: string) => {
      if (loaded.has(file) || file.startsWith("src/")) return;
      loaded.add(file);
      if (file === "tests/helpers/phoneHome.ts") return;
      const source = read(file) ?? "";
      for (const next of importsOf(file, source, (candidate) => read(candidate) !== undefined))
        walk(next);
    };
    walk("scripts/test-phone.ts");
    // The walk reaches the launcher's own helpers and their helpers.
    expect(loaded).toContain("tests/helpers/phonePhotos.ts");
    expect(loaded).toContain("tests/helpers/loadClock.ts");
    const skipped = [...loaded].filter((file) => eligible(phoneDecision([file]).run) !== "true");
    expect(skipped).toEqual([]);
  });
  // INF-827 (the captain's "skip changes to unused setup"): the device gates never run the
  // chooser or the local test home, nor the virtual Mac scripts while the switch is off.
  it.each([
    "scripts/phone-test-home.ts",
    "scripts/affected-phone.ts",
    "scripts/virtual-mac/phone.sh",
    "scripts/virtual-mac/phone-job.sh",
    "scripts/virtual-mac/vm.sh",
  ])("skips setup the device gates do not use, %s alone", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("false");
  });
  // INF-524: the virtual Mac path the switch turns on.
  it.each([
    "scripts/virtual-mac/phone.sh",
    "scripts/virtual-mac/phone-job.sh",
    "scripts/virtual-mac/vm.sh",
  ])(
    "runs the actual workflow condition when %s changes with the virtual Mac switch on",
    (path) => {
      expect(eligible(phoneDecision([path], undefined, { virtualMac: true }).run)).toBe("true");
    },
  );
  it.each([
    "src/shared/connection.ts",
    "src/shared/feed.ts",
    "src/core/connection/connection.ts",
    "src/core/devices/pairing.ts",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/generate-phone-theme.ts",
  ])("honors the captain's narrower lane by skipping %s alone", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("false");
  });
  // INF-496 (captain: "Skip it too: the phone still sees only a number"): the phone sees
  // docs/contract.json only as the version line of its generated file.
  const generated = (...lines: string[]) =>
    ["--- a/f", "+++ b/f", "@@ -3 +3 @@", ...lines].join("\n");
  const version = (v: string) => `public static let version = "${v}"`;
  it.each([
    ["a minor version", "9.2.0", "9.3.0"],
    ["a first-number version", "9.2.0", "10.0.0"],
  ])("skips the Mac mini when the contract changes only %s", (_name, from, to) => {
    const diff = generated(`-    ${version(from)}`, `+    ${version(to)}`);
    expect(eligible(phoneDecision(["docs/contract.json", GENERATED_CONTRACT], diff).run)).toBe(
      "false",
    );
  });
  it.each([
    [
      "another line of the generated file",
      generated(
        `-    ${version("9.2.0")}`,
        `+    ${version("9.3.0")}`,
        "-    public static let maxFrameBytes = 1",
        "+    public static let maxFrameBytes = 2",
      ),
    ],
    ["a changed feed case", generated('+    case `newEvent` = "newEvent"')],
    ["an unreadable file comparison", undefined],
  ])("still selects the Mac mini for %s", (_name, diff) => {
    expect(eligible(phoneDecision(["docs/contract.json", GENERATED_CONTRACT], diff).run)).toBe(
      "true",
    );
  });
  it("skips unrelated changes but never skips an unreadable comparison", () => {
    expect(eligible(phoneDecision(["docs/ios.md"]).run)).toBe("false");
    expect(eligible(phoneDecision([]).run)).toBe("false");
    expect(eligible(phoneDecision(undefined).run)).toBe("true");
  });
  it("gives every phone run and attempt its own group, without cancelling work (INF-2202)", () => {
    // Each run's request group, which a newer same-selection request cancels, is
    // tests/workflow-request-groups.test.ts's (INF-3380); the device jobs keep their own.
    const runs = [
      { ref: "refs/pull/79/merge", run_id: "18800000001", run_attempt: "1" },
      { ref: "refs/pull/136/merge", run_id: "18800000002", run_attempt: "1" },
      { ref: "refs/pull/79/merge", run_id: "18800000001", run_attempt: "2" },
    ];
    const vars = { PHONE_VIRTUAL_MAC: TOGETHER, MAC_RUNNER: "mini-mac-any" };
    const native = workflow.jobs[NATIVE_JOB].concurrency;
    // INF-2582 and INF-2970's fix 1: a run's jobs share a run and attempt, and each waits for its own guest; INF-5387's
    // plan, piece 2: so does each job a request was dealt into.
    const groups = runs.flatMap((github) =>
      FULL_JOBS.map((job) =>
        workflowString(native.group, {
          github,
          vars,
          inputs: { mac_runner: "mini-mac-real" },
          matrix: job,
        }),
      ),
    );
    expect(FULL_JOBS.length).toBeGreaterThan(1);
    expect(new Set(groups).size).toBe(runs.length * FULL_JOBS.length);
    expect(native.queue).toBe("max");
    expect(native["cancel-in-progress"]).toBe(false);
  });
  // INF-4241 piece 6: PHONE_PARTS is the one list of devices; the device the phone check accepts, the devices its
  // job of every device runs and the phone release's call follow it, so a device the table adds or drops is checked
  // or refused everywhere. INF-4241 piece 8 (the brief's "a phone release runs all three passes from one build"): a
  // call naming no device is one job whose one gate runs every device the table names.
  it("checks the devices PHONE_PARTS names, in the request, its matrix and the phone release", () => {
    const devices = [...PHONE_DEVICES].sort();
    const native = workflow.jobs[NATIVE_JOB];
    expect(workflowValue(native.strategy.matrix.include, { inputs: {}, needs: {} })).toEqual([
      { device: "every", key: "every" },
    ]);
    const gate = (native.steps as Step[]).find(isGate)!.run!;
    expect(gate).toContain("every) device=(--every-device)");
    expect(
      /\n\s*([\w|]+)\) device=\(--device "\$PHONE_DEVICE"\)/.exec(gate)?.[1]?.split("|").sort(),
    ).toEqual(devices);
    const check = (workflow.jobs.request.steps as { run?: string }[]).find((step) =>
      step.run?.includes("Unknown phone device"),
    )!.run!;
    expect(/''\|([\w|]+)\) ;;/.exec(check)?.[1]?.split("|").sort()).toEqual(devices);
    const release = yaml.load(readFileSync(".github/workflows/ios-release.yml", "utf8"));
    expect(release.jobs.phone.strategy).toBeUndefined();
    expect(release.jobs.phone.with.device).toBeUndefined();
  });
  it("keeps TestFlight uploads in a line of their own, apart from the phone checks", () => {
    // INF-989 (captain: "keep TestFlight uploads in their own line").
    const release = yaml.load(readFileSync(".github/workflows/ios-release.yml", "utf8"));
    const testflight = release.jobs.testflight.concurrency;
    expect(testflight.group).not.toMatch(/\$\{\{/);
    expect(testflight.group).not.toBe("mac-mini-phone");
    expect(workflow.jobs["native-phone"].concurrency.group).not.toContain(testflight.group);
    expect(testflight.queue).toBe("max");
    expect(testflight["cancel-in-progress"]).toBe(false);
  });
  it("runs its device in one gate step", () => {
    const gates = workflow.jobs[NATIVE_JOB].steps
      .filter((step: { run?: string }) =>
        /scripts\/test-phone\.ts|scripts\/virtual-mac\/phone\.sh gate/.test(step.run ?? ""),
      )
      .map((step: { name: string }) => step.name);
    // INF-2101: one gate a job, never a second gate step beside it.
    expect(gates).toEqual([BOTH]);
  });
  // INF-1083 / INF-1072: the gate, not just its lease, ends on every route. INF-2052: the captain raised its
  // limit from 60 to 90 minutes for every part on both devices; alone, a full check passed in 59.
  // INF-2582: the two edited-part passes run in the same gate, each with the same 90 minutes, and the job
  // keeps 165 minutes for the ordinary pass and 90 more for each further pass.
  // INF-5387's plan, piece 2: the edited-part passes ride a request's dealt jobs, a dealt job is stopped at 27 minutes
  // and its gate at 23 (INF-6058, the captain's choice to raise both about 2 minutes for the wait on the simulator's
  // wallpaper prewarm); a call, which runs no further pass, keeps its gate's 90 and its job's limit.
  // INF-6039's plan, part 1, and the captain's answer on its review ("Give the first job 12 more minutes, the build
  // step's own limit"): job 1 of a check of several jobs builds and uploads before its gate, so its job keeps 39.
  it("caps a call's gate at ninety minutes and a dealt job's gate at 23, each within its job's limit", () => {
    const limits = (matrix: Plain, strategy: Plain = { "job-total": 1 }) => {
      const contexts = { matrix, strategy };
      return [
        workflowValue(
          String(
            stepsThatRun(OFF, false, {}, BRANCH_REQUEST, {}, matrix, strategy).find(isGate)?.[
              "timeout-minutes"
            ],
          ),
          contexts,
        ),
        workflowValue(String(workflow.jobs[NATIVE_JOB]["timeout-minutes"]), contexts),
      ];
    };
    for (const route of [OFF, IN_TURN, TOGETHER])
      expect(stepsThatRun(route).filter(isGate)).toHaveLength(1);
    for (const device of ["every", "ipad", "duo", "iphone"])
      expect(limits({ device, key: device })).toEqual([90, 165 + 90 * 2]);
    // The gate stops first, so an over-long one fails its job, which still keeps its results.
    expect(FULL_JOBS.length).toBeGreaterThan(1);
    const build = workflow.jobs[NATIVE_JOB].steps.find((step: { run?: string }) =>
      /scripts\/phone-build\.ts/.test(step.run ?? ""),
    );
    for (const job of FULL_JOBS)
      expect(limits(job, { "job-total": FULL_JOBS.length })).toEqual([
        23,
        job.key === "job-1" ? 27 + build["timeout-minutes"] : 27,
      ]);
    // A check dealt into one job builds in its gate, so its job keeps 27.
    expect(limits({ ...FULL_JOBS[0], key: "job-1" })).toEqual([23, 27]);
  });
  it("runs only on request or a reusable call, never on a pull request", () => {
    // INF-2139 (captain: "let's pull journeys and phone checks off PRs now"); the phone
    // release calls it, and main no longer does (INF-2492).
    expect(Object.keys(workflow.on)).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      parts: { type: "string" },
      // INF-3205: a request names its one device as a call does; empty, the default, checks both.
      device: { type: "string", default: "" },
      starve: { type: "boolean", default: false },
      perf: { type: "boolean", default: false },
      waits: { type: "boolean", default: false },
      evidence_run: { required: false, type: "string" },
      recording: { required: false, type: "boolean", default: false },
    });
    expect(workflow.on.workflow_dispatch.inputs.mac_runner).toBeUndefined();
    expect(workflow.jobs["native-phone"]["continue-on-error"]).toBeUndefined();
  });
  // INF-1066: exporting attachments must not supersede a failed native check with a skipped check of the same name.
  it.each(["", "40035937592"])(
    "keeps the native-check name distinct for evidence_run=%s",
    (evidenceRun) => {
      const name = workflowString(workflow.jobs[NATIVE_JOB].name, {
        github: { event_name: "workflow_dispatch" },
        inputs: { evidence_run: evidenceRun, trigger: "", waits: false },
        matrix: { device: "iphone" },
      });
      // Read as readers read it, by its name before the trigger-first rename.
      if (evidenceRun) expect(legacyJobName(name)).not.toBe(NATIVE_JOB);
      else expect(legacyJobName(name)).toBe(NATIVE_JOB);
    },
  );
  // INF-1066: record only on an explicit evidence request, never on ordinary checks.
  it.each([false, true])(
    "selects recording=%s through the native gate's real environment",
    (recording) => {
      const gate = workflow.jobs[NATIVE_JOB].steps.find((step: Step) => step.id === "both");
      const expression = gate.env.PHONE_RECORDING.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
      const ast = new Parser(new Lexer(expression).lex().tokens, ["inputs"], []).parse();
      const inputs = new data.Dictionary({
        key: "recording",
        value: new data.BooleanData(recording),
      });
      expect(
        new Evaluator(ast, new data.Dictionary({ key: "inputs", value: inputs }))
          .evaluate()
          .coerceString(),
      ).toBe(recording ? "1" : "");
    },
  );
  it("runs setup and the direct gate regardless of a stale clone switch (INF-2202)", () => {
    const all = names(workflow.jobs[NATIVE_JOB].steps);
    for (const route of [OFF, IN_TURN, TOGETHER]) {
      const ran = stepsThatRun(route);
      expect(names(ran)).toEqual(
        all.filter(
          (name) =>
            name !== RESULTS &&
            name !== SAVE_PACKAGES &&
            name !== KEEP_PASSES &&
            name !== "Restore the passes of this run's earlier attempts" &&
            !SHARED_BUILD_STEPS.includes(name) &&
            !SKIPPED_STEPS.includes(name),
        ),
      );
      expect(names(ran)).toContain("Install without reading this Mac's signing material");
      expect(ran.filter(isGate)).toHaveLength(1);
      expect(ran.find(isGate)?.env?.PHONE_PLAN).toBe(
        "${{ matrix.passes && toJSON(matrix.passes) || '' }}",
      );
    }
    // The shell execution and both-device arguments belong to release-workflows-journey-suites.test.ts.
  });
  it("ignores former runner overrides for every device job (INF-2202)", () => {
    for (const id of [NATIVE_JOB])
      for (const mode of [OFF, IN_TURN, TOGETHER])
        expect(
          workflowValue(workflow.jobs[id]["runs-on"], {
            vars: {
              MAC_QUEUES: JSON.stringify({ phone: "mini-mac-phone" }),
              PHONE_VIRTUAL_MAC: mode,
              VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
              MAC_RUNNER: "mini-mac-any",
              REAL_MAC_RUNNER: "mini-mac-real",
            },
            inputs: { mac_runner: "mini-mac-real" },
          }),
        ).toBe("mini-mac-phone");
  });
  it("supplies no runnable destination when the phone queue is absent (INF-2202)", () => {
    for (const id of [NATIVE_JOB]) {
      const resolve = (mapping: string) =>
        workflowValue(workflow.jobs[id]["runs-on"], {
          vars: {
            MAC_QUEUES: mapping,
            PHONE_VIRTUAL_MAC: TOGETHER,
            MAC_RUNNER: "mini-mac-any",
            VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
          },
          inputs: { mac_runner: "mini-mac-real" },
        });
      for (const mapping of ["{}", '{"phone":""}']) expect(resolve(mapping)).toBeFalsy();
      for (const mapping of ["", "not json"]) expect(() => resolve(mapping)).toThrow();
    }
  });
  it("never starts or deletes a fixed clone, failed checks included (INF-2202)", () => {
    for (const mode of [OFF, IN_TURN, TOGETHER])
      for (const failed of [false, true]) {
        const ran = names(stepsThatRun(mode, failed));
        expect(ran.filter((name) => VIRTUAL_MAC_STEPS.includes(name))).toEqual([]);
        expect(ran).toContain("Keep the small native command logs");
      }
  });
});

// INF-2125 piece 3 (the captain's "i want to get to a state where each PR's phone check finishes very
// quickly", approved plan: "reuse main's SwiftPM package cache"): a run on a branch reads the Swift
// packages main saved, and only main saves them, since a branch's own save no other run reads (INF-724).
describe("the phone check's Swift packages", () => {
  const steps = workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[];
  const restore = steps.find((step) => step.id === "swift-packages")!;
  const save = steps.find((step) => step.name === SAVE_PACKAGES)!;
  const MAIN = { event_name: "workflow_dispatch", ref: "refs/heads/main" };
  const BRANCH = { event_name: "workflow_dispatch", ref: "refs/heads/fm/task-1" };
  const ran = (github: Plain, hit = "", virtualMac = OFF) =>
    names(stepsThatRun(virtualMac, false, {}, github, { "swift-packages": { "cache-hit": hit } }));
  it("restores into the folder the gate reads, and saves that folder under the restore's own key", () => {
    const gate = steps.find(isGate)!;
    expect(gate.env?.INFINITARY_PHONE_PACKAGE_CACHE).toBe(restore.with?.path);
    expect(save.with?.path).toBe(restore.with?.path);
    expect(save.with?.key).toBe("${{ steps.swift-packages.outputs.cache-primary-key }}");
    expect(String(restore.with?.key).startsWith(String(restore.with?.["restore-keys"]))).toBe(true);
  });
  it("restores on every route on this Mac, and saves only from main when nothing matched", () => {
    for (const github of [MAIN, BRANCH]) expect(ran(github)).toContain(restore.name);
    expect(ran(BRANCH)).not.toContain(SAVE_PACKAGES);
    expect(ran(MAIN)).toContain(SAVE_PACKAGES);
    // A failed gate fetched the packages too; an exact match has nothing new to save.
    const failedGate = {
      both: { outcome: "failure" },
      "swift-packages": { outputs: { "cache-hit": "" } },
    };
    expect(
      holds(
        condition(save),
        { steps: failedGate, vars: { PHONE_VIRTUAL_MAC: OFF }, github: MAIN },
        { failed: true },
      ),
    ).toBe(true);
    expect(ran(MAIN, "true")).not.toContain(SAVE_PACKAGES);
  });
  it("a stale clone switch cannot suppress the placed guest's package cache (INF-2202)", () => {
    for (const github of [BRANCH, MAIN]) expect(ran(github, "", TOGETHER)).toEqual(ran(github));
  });
});

// INF-4496's fix 2 (the captain's "Let a passing phone retry clear the failed run it retried, so nobody reruns
// the whole failed job"): a rerun of a failed device job reads the passes its run's earlier attempts kept, so
// its gate runs only the rest, and its pass turns that same run green. INF-5387's plan, piece 2: each dealt job keeps
// and restores its own, by its key.
describe("a rerun of a failed phone job", () => {
  const steps = workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[];
  const restore = steps.find((step) => step.id === "earlier-passes")!;
  const keep = steps.find((step) => step.name === KEEP_PASSES)!;
  const gate = steps.find(isGate)!;
  const at = (run_id: string, run_attempt: string, key = "job-1") => ({
    github: { run_id, run_attempt },
    matrix: { key },
  });
  const key = (step: Step & { with?: Plain }, field: string, contexts: Plain) =>
    workflowString(String(step.with?.[field]), contexts);
  // GitHub restores the newest cache whose key starts with a restore key, after no exact match.
  const restores = (saved: Plain, rerun: Plain) => {
    const kept = key(keep, "key", saved);
    return (
      kept === key(restore, "key", rerun) || kept.startsWith(key(restore, "restore-keys", rerun))
    );
  };
  it("restores what an earlier attempt of the same run and job kept, and nothing of another", () => {
    expect(restores(at("43796100185", "1"), at("43796100185", "2"))).toBe(true);
    expect(restores(at("43796100185", "2"), at("43796100185", "3"))).toBe(true);
    // Each attempt keeps its own record, so a later one never overwrites an earlier one's key.
    expect(key(keep, "key", at("43796100185", "1"))).not.toBe(
      key(keep, "key", at("43796100185", "2")),
    );
    expect(restores(at("43796100185", "1", "job-2"), at("43796100185", "2"))).toBe(false);
    expect(restores(at("43796100185", "1", "job-1"), at("43796100185", "2", "job-10"))).toBe(false);
    expect(restores(at("4379610018", "1"), at("43796100185", "2"))).toBe(false);
    expect(restores(at("43796100185", "1"), at("4379610018", "2"))).toBe(false);
  });
  it("hands the gate the record in the folder the rerun restores and the failed attempt keeps", () => {
    const temp = "/runner/temp";
    const folder = (step: Step & { with?: Plain }) =>
      workflowString(String(step.with?.path), { runner: { temp } });
    expect(folder(keep)).toBe(folder(restore));
    expect(
      workflowString(String(gate.env?.PHONE_PASSES), { runner: { temp } }).startsWith(
        `${folder(restore)}/`,
      ),
    ).toBe(true);
  });
  it("restores only on a rerun with a gate to run, and keeps the record when the gate failed or was cancelled", () => {
    const gateRuns = { scope: { outputs: { gate: "true" } } };
    for (const [attempt, gateStep, restored] of [
      ["1", gateRuns, false],
      ["2", gateRuns, true],
      ["2", { scope: { outputs: { gate: "" } } }, false],
    ] as const)
      expect(holds(condition(restore), { ...at("1", attempt), steps: gateStep })).toBe(restored);
    // A dealt job another job's failure cancelled keeps its passes too, since a rerun of the failed jobs reruns it.
    for (const [outcome, kept] of [
      ["failure", true],
      ["cancelled", true],
      ["success", false],
      ["skipped", false],
    ] as const)
      expect(
        holds(
          condition(keep),
          { steps: { both: { outcome } } },
          { failed: outcome === "failure", cancelled: outcome === "cancelled" },
        ),
      ).toBe(kept);
  });
});

// INF-1343 (the captain's "Stop a failing pull request check at its first failed part" and
// "Upload the 530 MB phone results only when a check fails"); since INF-2139 the early stop
// belongs to a complete branch selection and its edited-part passes, and since INF-2811 to any
// request with edited-part passes, whose failed pass stops the later ones.
describe("a failing phone check", () => {
  // INF-5387's plan, piece 2: the chooser decides it, and the first failed job of such a request cancels the others.
  it("stops at its first failed part for a complete selection or edited-part passes, and only then", () => {
    const gate = stepsThatRun(OFF).find(isGate) as Step;
    const native = workflow.jobs[NATIVE_JOB];
    for (const [chosen, stops] of [
      [FULL, true],
      [{ ...FULL, iphoneOnly: ["join-read"] }, true],
      [selection({ kept: ["talk-drafts"], repeats: ["talk-drafts"] }), true],
      [selection(), false],
      // A request that names its parts reads neither the selection's completeness nor its further passes.
      [{ ...FULL, named: true }, false],
      [selection({ repeats: ["rest"], named: true }), false],
    ] as const) {
      const contexts = {
        needs: { request: { outputs: { stop_early: String(requestStopsEarly(chosen)) } } },
      };
      expect(requestStopsEarly(chosen)).toBe(stops);
      expect(workflowString(gate.env!.INFINITARY_PHONE_STOP_EARLY!, contexts)).toBe(
        stops ? "1" : "0",
      );
      expect(workflowValue(String(native.strategy["fail-fast"]), contexts)).toBe(stops);
    }
    // A call chooses nothing, so it never stops early.
    expect(workflowString(gate.env!.INFINITARY_PHONE_STOP_EARLY!, { needs: {} })).toBe("0");
    expect(workflowValue(String(native.strategy["fail-fast"]), { needs: {} })).toBe(false);
  });
  it("keeps the whole results only when the job failed or recorded, and its logs and pictures always", () => {
    for (const virtualMac of [OFF, TOGETHER]) {
      const kept = (failed: boolean, recording = "") =>
        names(stepsThatRun(virtualMac, failed, { recording }));
      expect(kept(false)).not.toContain(RESULTS);
      expect(kept(true)).toContain(RESULTS);
      // INF-1066: the evidence export reads a recording run's clips from its results.
      expect(kept(false, "true")).toContain(RESULTS);
      for (const failed of [false, true])
        expect(kept(failed)).toEqual(
          expect.arrayContaining([
            "Keep the small native command logs",
            "Keep the simulator logs as their own artifact",
            "Keep the pictures as their own artifact",
          ]),
        );
    }
  });
  // INF-2053: a full gate's live simulator logs, one per part and device, 1.5 to 17 MB each packed, took
  // phone-logs to 86 to 94 MB, past the app's 64 MiB artifact download, while every other
  // file in it came to 1.5 MiB. Each upload's paths are read as upload-artifact reads them,
  // every line a glob and a leading ! leaving out what it matches, against files real gates
  // kept: a failed full gate's (run 41145496442) and two failed parts' log readings (run 40937645392).
  it("keeps each part's simulator log in its own artifact and every other log with the small ones", () => {
    const temp = "/runner/temp";
    // INF-2970's fix 1: each job names its artifacts for its key, its device or its dealt number (INF-5387's plan, piece 2).
    const uploaded = (name: string, files: string[]) => {
      const step = (workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[]).find(
        (each) =>
          each.uses?.startsWith("actions/upload-artifact") &&
          workflowString(String(each.with?.name ?? ""), {
            inputs: {},
            github: BRANCH_REQUEST,
            matrix: FULL_JOBS[1]!,
          }) === `${name}-job-2`,
      );
      const lines = String(step?.with?.path)
        .split("\n")
        .map((line) => line.trim().replace(/\$\{\{\s*runner\.temp\s*\}\}/g, temp))
        .filter(Boolean);
      const left = lines.filter((line) => line.startsWith("!")).map((line) => line.slice(1));
      const taken = lines.filter((line) => !line.startsWith("!"));
      return files
        .filter((file) => taken.some((glob) => matchesGlob(`${temp}/phone/${file}`, glob)))
        .filter((file) => !left.some((glob) => matchesGlob(`${temp}/phone/${file}`, glob)));
    };
    const simulatorLogs = [
      ...(["iphone", "ipad"] as const).flatMap((device) =>
        PHONE_PARTS.map((part) => `${device}/${part.name}/simulator-live.log`),
      ),
      // INF-2582: an edited part's further passes write folders beside its ordinary pass's.
      "ipad/talk-tasks-round-2/simulator-live.log",
      "iphone/talk-tasks-round-3/simulator-live.log",
    ];
    const commandLogs = [
      "1-xcrun.log",
      "2-node.log",
      "6-swift.log",
      "8-xcodebuild.log",
      "101-plutil.log",
      "ipad/photos-stream.log",
      "iphone/photos-stream.log",
      "ipad/cards/1-plutil.log",
      "ipad/cards/14-xcodebuild.log",
      "iphone/rest/13-xcodebuild.log",
      "iphone/relaunch/46-xcodebuild.log",
      "iphone/talk/keyboard-timeout-capture.log",
      // What the app and the simulator's system logged, read after a part failed.
      "iphone/talk/71-xcrun.log",
      "iphone/talk/72-xcrun.log",
      "ipad/talk-tasks-round-2/9-xcodebuild.log",
      "iphone/talk-tasks-round-3/9-xcodebuild.log",
      "ipad/rest/phone.xcresult/Staging/1_Test/Diagnostics/InfinitaryUITests-71653F01-C0E0-418C-AAA9-959D2FAC473C-Configuration-Test Scheme Action-Iteration-1/scheduling.log",
    ];
    const files = [
      ...commandLogs,
      ...simulatorLogs,
      "part-times.json",
      "ipad/rest/phone.xcresult/Info.plist",
    ];
    expect(uploaded("phone-logs", files)).toEqual([...commandLogs, "part-times.json"]);
    // INF-2582: a release call of one device keeps that device's part times under its folder.
    const deviceTimes = ["ipad/part-times.json", "iphone/part-times.json"];
    expect(uploaded("phone-logs", deviceTimes)).toEqual(deviceTimes);
    expect(uploaded("phone-simulator-logs", files)).toEqual(simulatorLogs);
  });
});

// INF-663 (captain: "add a nightly phone check" on main): a run started on request checks
// both devices whatever changed, and every gate's failure reaches the run.
describe("the phone check on request", () => {
  it("runs every part on a default request, and what the chooser keeps on an affected one", () => {
    expect(eligible("")).toBe("true");
    expect(eligible(true)).toBe("true");
    expect(eligible(false)).toBe("false");
  });
  it("starts the device gate in each device's job and each dealt job", () => {
    // INF-2970's fix 1: each device's job runs its own gate; INF-5387's plan, piece 2: so does each dealt job.
    const matrices: Plain[] = [
      ...["ipad", "duo", "iphone", "every"].map((device) => ({ device, key: device })),
      ...FULL_JOBS,
    ];
    for (const virtualMac of [OFF, IN_TURN, TOGETHER])
      for (const matrix of matrices)
        expect(
          names(stepsThatRun(virtualMac, false, {}, BRANCH_REQUEST, {}, matrix).filter(isGate)),
        ).toEqual([BOTH]);
    // A call, or a wait-clock or tool request, runs the job of the device it names, or of every device.
    expect(
      ["", "ipad", "duo", "iphone"].map((device) =>
        workflowValue(workflow.jobs[NATIVE_JOB].strategy.matrix.include, {
          inputs: { device },
          needs: {},
        }),
      ),
    ).toEqual(["every", "ipad", "duo", "iphone"].map((device) => [{ device, key: device }]));
  });
  // INF-6039's plan, part 1: only a dealt request's jobs share a build, the first job's, within their own run attempt; the
  // gate then decides whether it may use it (tests/phone-build.test.ts). A call, the phone release's among them, builds
  // in its gate as before.
  it("shares the first job's build with the other jobs of its own run attempt, and only in a dealt request", () => {
    const steps = workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[];
    const ran = (matrix: Plain, jobs: number) =>
      names(stepsThatRun(OFF, false, {}, BRANCH_REQUEST, {}, matrix, { "job-total": jobs })).filter(
        (name) => SHARED_BUILD_STEPS.includes(name),
      );
    const [first = {}, ...others] = FULL_JOBS;
    expect(others.length).toBeGreaterThan(0);
    expect(ran(first, FULL_JOBS.length)).toEqual([BUILD_ONCE, SHARE_BUILD]);
    for (const job of others) expect(ran(job, FULL_JOBS.length)).toEqual([FETCH_BUILD]);
    for (const device of ["every", "ipad", "duo", "iphone"])
      expect(ran({ device, key: device }, 1)).toEqual([]);
    // A request dealt into one job, as any request within 14 recorded minutes is, shares nothing.
    const lone = requestJobs(selection(), TIMES);
    expect(lone).toHaveLength(1);
    expect(ran(lone[0] ?? {}, 1)).toEqual([]);
    const sharing = (jobs: number) =>
      workflowValue(String(steps.find(isGate)?.env?.PHONE_SHARED), {
        strategy: { "job-total": jobs },
      });
    expect([sharing(1), sharing(FULL_JOBS.length)]).toEqual([false, true]);
    const named = (name: string, field: "name" | "pattern", attempt: string) =>
      workflowString(String(steps.find((step) => step.name === name)?.with?.[field]), {
        github: { ...BRANCH_REQUEST, run_attempt: attempt },
      });
    for (const attempt of ["1", "2"]) {
      expect(named(SHARE_BUILD, "name", attempt)).toBe(`phone-build-${attempt}`);
      expect(named(FETCH_BUILD, "pattern", attempt)).toBe(`phone-build-${attempt}`);
    }
    // Sharing is a saving only: a failed upload or download never fails the check.
    for (const name of [SHARE_BUILD, FETCH_BUILD])
      expect(steps.find((step) => step.name === name)).toHaveProperty("continue-on-error", true);
    // The dealt gate reads the folder both steps use.
    const folder = (name: string) =>
      String(
        steps.find((step) => step.name === name)?.with?.path ??
          steps.find((step) => step.name === name)?.run,
      );
    for (const name of [SHARE_BUILD, FETCH_BUILD])
      expect(folder(name)).toBe("${{ runner.temp }}/phone-build");
    expect(folder(BUILD_ONCE)).toContain('--out "$RUNNER_TEMP/phone-build"');
    expect(steps.find(isGate)?.run).toContain('shared=(--shared-build "$RUNNER_TEMP/phone-build")');
  });
});

// INF-3205: a replacement proof of one device runs that device's passes alone at the branch's current version, with
// the part selection it would have beside the other devices', and nothing else. INF-5387's plan, piece 2: the chooser
// deals those passes into the request's jobs, so the selection is read where the chooser makes it.
describe("a request that names one device", () => {
  const PLACEMENT = "Keep the chosen and left parts";
  const native = workflow.jobs[NATIVE_JOB];
  // A change whose test code edits talk-tasks and only reaches join-read and rest, with the phone app's screens edited.
  const reach = [
    { part: "join-read", distance: 1, why: "reached" },
    { part: "talk-tasks", distance: 0, why: "edited", repeat: true },
    { part: "rest", distance: 1, why: "reached" },
  ] as const;
  const kept = reach.map((each) => each.part);
  const chosen = (device = "") => chooseRequest(kept, reach, { device, screens: true });
  const devicesOf = (jobs: { passes: { device: string }[] }[]) =>
    [...new Set(jobs.flatMap((job) => job.passes.map((pass) => pass.device)))].sort();
  it("deals only the named device's passes, and every device's when it names none", () => {
    expect(devicesOf(requestJobs(chosen(), TIMES))).toEqual([...PHONE_DEVICES].sort());
    for (const device of PHONE_DEVICES) {
      expect(chosen(device).devices).toEqual([device]);
      expect(devicesOf(requestJobs(chosen(device), TIMES))).toEqual([device]);
    }
    // A call, and a wait-clock or tool request, run the job of the device it names, or of every device.
    for (const device of ["", ...PHONE_DEVICES])
      expect(
        workflowValue(native.strategy.matrix.include, { inputs: { device }, needs: {} }),
      ).toEqual([{ device: device || "every", key: device || "every" }]);
  });
  it.each(PHONE_DEVICES.map((device) => [device]))(
    "runs the %s's passes as a request of every device runs them",
    (device) => {
      const alone = requestPasses(chosen(device));
      expect(alone).toEqual(requestPasses(chosen()).filter((pass) => pass.device === device));
      // The iPad and the Duo still run each part once and never the iPhone's further passes.
      if (device !== "iphone") expect(alone.every((pass) => pass.round === 1)).toBe(true);
      else
        expect(alone.filter((pass) => pass.round > 1).map((pass) => pass.part)).toEqual([
          "talk-tasks",
          "talk-tasks",
        ]);
    },
  );
  // INF-4241 piece 9: the iPad's and the Duo's passes are the parts the chooser named for them, which hold a short pass
  // the iPhone does not run when the change edits the phone app's screens; the iPhone runs the reached parts.
  it("hands each other device its own parts and the iPhone the reached parts", () => {
    const passes = requestPasses(chosen());
    const parts = (device: string) =>
      [...new Set(passes.filter((pass) => pass.device === device).map((pass) => pass.part))].sort();
    expect(parts("iphone")).toEqual([...kept].sort());
    expect(parts("ipad")).toEqual([...chosen().ipadParts].sort());
    expect(parts("duo")).toEqual([...chosen().duoParts].sort());
    expect(chosen().iphoneOnly).toEqual(["join-read", "rest"]);
    // With no screen edited, the iPad runs only the edited part, and the Duo, which has no row for it, nothing.
    const plain = requestPasses(chooseRequest(kept, reach));
    expect(plain.filter((pass) => pass.device === "ipad").map((pass) => pass.part)).toEqual([
      "talk-tasks",
    ]);
    expect(plain.filter((pass) => pass.device === "duo")).toEqual([]);
  });
  // An iPad request whose kept parts all run on the iPhone alone deals no job, so it takes no phone Mac.
  it("deals no job for a device whose kept parts all run on the iPhone alone", () => {
    const reached = [{ part: "rest", distance: 1, why: "reached" }] as const;
    const alone = chooseRequest(["rest"], reached, { device: "ipad" });
    expect(requestJobs(alone, TIMES)).toEqual([]);
    expect(holds(native.if, { inputs: {}, needs: { request: { outputs: { jobs: "[]" } } } })).toBe(
      false,
    );
    const named = chooseRequest(["rest"], [], { explicit: true, named: true, device: "ipad" });
    expect(devicesOf(requestJobs(named, TIMES))).toEqual(["ipad"]);
  });
  it("keeps the part selection in the Linux request job before reserving a phone Mac", () => {
    const keeps = (workflow.jobs.request.steps as Step[]).find((step) => step.name === PLACEMENT)!;
    expect(keeps).toBeDefined();
    for (const device of ["", "ipad", "iphone"])
      expect(holds(condition(keeps), { github: BRANCH_REQUEST, inputs: { device } })).toBe(true);
    expect((native.steps as Step[]).some((step) => step.name === PLACEMENT)).toBe(false);
  });
});

// INF-1066: extracting a saved native scene capture uses Xcode, but starts no new device gate.
it("exports existing native evidence without starting simulators", () => {
  expect(eligible("", "40023566877")).toBe("false");
  expect(eligible("")).toBe("true");
});

// INF-1258: the captain picked touched parts only for crewmate requests, not PR/nightly gates.
describe("affected request routing", () => {
  const request = (workflow.jobs.request.steps as Step[]).find(
    (step) => step.id === "request-select",
  )!;
  const gate = (workflow.jobs[NATIVE_JOB].steps as Step[]).find(isGate)!;
  it("accounts for affected, full and explicit requests without changing main", () => {
    // INF-5387's plan, piece 2: the chooser deals every manual request's passes, named parts included.
    // Boolean inputs must remain BooleanData, not the truthy string "false".
    for (const [affected, parts] of [
      [true, ""],
      [false, ""],
      [true, "cards"],
      [true, EVERY_PART.join(" ")],
    ] as const)
      expect(
        holds(condition(request), {
          github: { event_name: "workflow_dispatch" },
          inputs: { affected, parts },
        }),
      ).toBe(true);
    // INF-2259: explicit diagnostic parts never silently become a complete verification request, even when they name
    // the whole live part table: they run no further pass and never stop early.
    const named = chooseRequest(EVERY_PART, [], { explicit: true, named: true });
    expect(requestPasses(named).every((pass) => pass.round === 1)).toBe(true);
    expect(requestStopsEarly(named)).toBe(false);
  });
  it("passes each dealt job's passes into its gate and honors explicit diagnostic parts", () => {
    for (const job of FULL_JOBS)
      expect(JSON.parse(workflowString(gate.env!.PHONE_PLAN!, { matrix: job }))).toEqual(
        job.passes,
      );
    expect(
      workflowString(gate.env!.PHONE_PLAN!, { matrix: { device: "every", key: "every" } }),
    ).toBe("");
    const named = chooseRequest(["cards-form"], [], { explicit: true, named: true });
    expect(requestJobs(named, TIMES).flatMap((job) => job.passes)).toEqual([
      { device: "iphone", part: "cards-form", round: 1 },
    ]);
  });
  // INF-2970's fix 1 with INF-2582's "iPhone only; iPad waits for the release check": no iPad pass is dealt when
  // every kept part runs on the iPhone alone.
  it("deals no iPad pass when the iPhone runs every kept part alone", () => {
    const reached = chooseRequest(["rest"], [{ part: "rest", distance: 1, why: "reached" }]);
    expect(
      requestJobs(reached, TIMES).flatMap((job) => job.passes.map((pass) => pass.device)),
    ).toEqual(["iphone"]);
    const edited = chooseRequest(["rest"], [{ part: "rest", distance: 0, why: "edited" }]);
    expect(
      new Set(requestJobs(edited, TIMES).flatMap((job) => job.passes.map((pass) => pass.device))),
    ).toEqual(new Set(["ipad", "iphone"]));
  });
  it("starts selected requests, skips an empty affected request, and keeps default full runs", () => {
    const reached = requestJobs(selection(), TIMES);
    for (const [affected, parts, jobs, expected] of [
      [true, "", reached, true],
      [true, "", [], false],
      [false, "", FULL_JOBS, true],
      [true, "join", reached, true],
    ] as const)
      expect(
        holds(gateCondition(), {
          github: { event_name: "workflow_dispatch" },
          inputs: { affected, parts },
          needs: { request: { outputs: { jobs: JSON.stringify(jobs) } } },
          matrix: jobs[0] ?? {},
        }),
      ).toBe(expected);
  });
});

// INF-2259: full ordinary coverage and exactly two further edited-test passes, at one workflow
// version, never retries after a failure. INF-2582 direction A (the captain's "A: wait once and
// trim the soak"): both further passes run on the iPhone; scripts/phone-test-plan.ts orders the passes, and since
// INF-5387's plan, piece 2, the chooser deals them into the request's jobs like any other pass.
describe("complete-selection phone CI repeats", () => {
  it("runs no job on a phone Mac but the one native job", () => {
    const onPhoneMac = Object.entries(workflow.jobs as Record<string, { "runs-on": string }>)
      .filter(([, job]) => String(job["runs-on"]).includes("MAC_QUEUES).phone"))
      .map(([id]) => id);
    expect(onPhoneMac).toEqual([NATIVE_JOB]);
    expect(workflow.jobs[NATIVE_JOB].outputs).toBeUndefined();
  });
  it("deals the chooser's edited parts and iPhone-only parts into the request's jobs", () => {
    const chosen = { ...FULL, iphoneOnly: ["join-read", "rest"], repeats: ["talk-tasks"] };
    const passes = requestJobs(chosen, TIMES).flatMap((job) => job.passes);
    for (const part of ["join-read", "rest"])
      expect(passes.filter((pass) => pass.part === part).map((pass) => pass.device)).toEqual([
        "iphone",
      ]);
    expect(
      passes
        .filter((pass) => pass.part === "talk-tasks")
        .map((pass) => `${pass.device} ${pass.round}`)
        .sort(),
    ).toEqual(["ipad 1", "iphone 1", "iphone 2", "iphone 3"]);
    expect(requestStopsEarly(chosen)).toBe(true);
  });
});

// Approved cut 4: the Linux request's jobs keep an empty request from taking a phone Mac. INF-5387's plan, piece 2:
// one job for each job the chooser dealt.
it("uses the dealt jobs and skips native work when Linux selects none", () => {
  const native = workflow.jobs[NATIVE_JOB];
  for (const jobs of [requestJobs(selection(), TIMES), FULL_JOBS]) {
    const needs = { request: { outputs: { jobs: JSON.stringify(jobs) } } };
    expect(workflowValue(native.strategy.matrix.include, { inputs: {}, needs })).toEqual(jobs);
    expect(holds(native.if, { inputs: {}, needs })).toBe(true);
  }
  expect(holds(native.if, { inputs: {}, needs: { request: { outputs: { jobs: "[]" } } } })).toBe(
    false,
  );
  // A release call has no manual selection and runs every device in one job (INF-4241 piece 8).
  expect(workflowValue(native.strategy.matrix.include, { inputs: {}, needs: {} })).toEqual([
    { device: "every", key: "every" },
  ]);
});

// Release calls inherit their caller's dispatch event, but must never run manual preselection.
it("leaves the release's resolved-source call out of manual selection and its artifact upload", () => {
  const contexts = {
    github: BRANCH_REQUEST,
    inputs: { source_commit: "6073f484509752eb55ee1b1c85c38b82b4909cc3" },
  };
  for (const step of (workflow.jobs.request.steps as Step[]).slice(1))
    expect(holds(condition(step), contexts), step.name ?? step.uses).toBe(false);
});
