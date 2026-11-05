import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { GENERATED_CONTRACT, phoneDecision } from "../scripts/affected-phone";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { PHONE_PARTS, relaunchPairs } from "../scripts/phone-test-plan";
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
// Whether the device gate starts: a default request never consults the chooser (run ""); an
// affected request keeps parts only when the chooser's decision runs, since
// scripts/affected-phone.ts writes an empty parts list otherwise.
function eligible(run: boolean | "", evidenceRun = ""): string {
  const steps = new data.Dictionary({
    key: "request-select",
    value: new data.Dictionary({
      key: "outputs",
      value: new data.Dictionary({ key: "parts", value: new data.StringData(run ? "rest" : "") }),
    }),
  });
  const github = new data.Dictionary({
    key: "event_name",
    value: new data.StringData("workflow_dispatch"),
  });
  const ast = new Parser(
    new Lexer(`!!(${gateCondition()})`).lex().tokens,
    ["steps", "github", "inputs", "env"],
    [],
  ).parse();
  return new Evaluator(
    ast,
    new data.Dictionary(
      { key: "steps", value: steps },
      { key: "env", value: new data.Dictionary() },
      { key: "github", value: github },
      {
        key: "inputs",
        value: new data.Dictionary(
          { key: "evidence_run", value: new data.StringData(evidenceRun) },
          { key: "affected", value: new data.BooleanData(run !== "") },
          { key: "parts", value: new data.StringData("") },
        ),
      },
    ),
  )
    .evaluate()
    .coerceString();
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
type Plain = { [key: string]: string | boolean | Plain };
const STATUS = ["success", "always", "cancelled", "failure"];

function toData(value: Plain): data.Dictionary {
  const dictionary = new data.Dictionary();
  for (const [key, item] of Object.entries(value))
    dictionary.add(
      key,
      typeof item === "string"
        ? new data.StringData(item)
        : typeof item === "boolean"
          ? new data.BooleanData(item)
          : toData(item),
    );
  return dictionary;
}

// Whether a workflow expression holds, as GitHub reads its truthiness.
function holds(
  expression: string,
  contexts: Plain,
  status: { failed?: boolean; cancelled?: boolean } = {},
): boolean {
  contexts = { env: {}, steps: {}, inputs: {}, ...contexts };
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

const BRANCH_REQUEST = { event_name: "workflow_dispatch", ref: "refs/heads/fm/task-1" };
// The native job's steps that run, in order, for a value of the switch, with every
// step succeeding (or the job failed, when `failed`); `outputs` gives a step's other
// outputs by its id.
function stepsThatRun(
  virtualMac: string,
  failed = false,
  inputs: Plain = {},
  github: Plain = BRANCH_REQUEST,
  outputs: Record<string, Plain> = {},
): Step[] {
  const seen: Plain = {};
  const ran: Step[] = [];
  for (const step of workflow.jobs[NATIVE_JOB].steps as Step[]) {
    const runs = holds(
      condition(step),
      { env: {}, steps: seen, vars: { PHONE_VIRTUAL_MAC: virtualMac }, inputs, github },
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
    // INF-2625: the test home's crewmates and first mate are the journey stand-in's.
    "tests/e2e/mockProvider.ts",
  ])("runs the actual workflow condition when %s changes", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("true");
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
    const journeys = yaml.load(readFileSync(".github/workflows/journeys.yml", "utf8"));
    expect(journeys.concurrency).toBeUndefined();
    expect(journeys.jobs["affected-journeys"].concurrency).toBeUndefined();
    const runs = [
      { ref: "refs/pull/79/merge", run_id: "18800000001", run_attempt: "1" },
      { ref: "refs/pull/136/merge", run_id: "18800000002", run_attempt: "1" },
      { ref: "refs/pull/79/merge", run_id: "18800000001", run_attempt: "2" },
    ];
    const vars = { PHONE_VIRTUAL_MAC: TOGETHER, MAC_RUNNER: "mini-mac-any" };
    const native = workflow.jobs[NATIVE_JOB].concurrency;
    // INF-2582: the phone release's two device calls share a run and attempt, and each waits for its own guest.
    const groups = runs.flatMap((github) =>
      ["", "ipad", "iphone"].map((device) =>
        workflowString(native.group, {
          github,
          vars,
          inputs: { mac_runner: "mini-mac-real", device },
        }),
      ),
    );
    expect(new Set(groups).size).toBe(runs.length * 3);
    expect(native.queue).toBe("max");
    expect(native["cancel-in-progress"]).toBe(false);
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
  it("runs both devices in one gate step", () => {
    const gates = workflow.jobs[NATIVE_JOB].steps
      .filter((step: { run?: string }) =>
        /scripts\/test-phone\.ts|scripts\/virtual-mac\/phone\.sh gate/.test(step.run ?? ""),
      )
      .map((step: { name: string }) => step.name);
    // INF-2101: one gate for both devices without claiming overlap.
    expect(gates).toEqual([BOTH]);
  });
  // INF-1083 / INF-1072: the gate, not just its lease, ends on every route. INF-2052: the captain raised its
  // limit from 60 to 90 minutes for every part on both devices; alone, a full check passed in 59.
  // INF-2582: the two edited-part passes run in the same gate, each with the same 90 minutes, and the job
  // keeps 165 minutes for the ordinary pass and 90 more for each further pass.
  it("caps every route at ninety minutes a pass, within the job's own limit", () => {
    const passes = (repeat: string) =>
      workflowValue(String(stepsThatRun(OFF).find(isGate)?.["timeout-minutes"]), {
        steps: { "request-select": { outputs: { repeat_parts: repeat } } },
      });
    for (const route of [OFF, IN_TURN, TOGETHER])
      expect(stepsThatRun(route).filter(isGate)).toHaveLength(1);
    expect(passes("")).toBe(90);
    expect(passes("talk-tasks")).toBe(90 * 3);
    expect(workflow.jobs[NATIVE_JOB]["timeout-minutes"]).toBe(165 + 90 * 2);
  });
  it("runs only on request or a reusable call, never on a pull request", () => {
    // INF-2139 (captain: "let's pull journeys and phone checks off PRs now"); the phone
    // release calls it, and main no longer does (INF-2492).
    expect(Object.keys(workflow.on)).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      parts: { type: "string" },
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
          (name) => name !== RESULTS && name !== SAVE_PACKAGES && !SKIPPED_STEPS.includes(name),
        ),
      );
      expect(names(ran)).toContain("Install without reading this Mac's signing material");
      expect(ran.filter(isGate)).toHaveLength(1);
      expect(ran.find(isGate)?.env?.PHONE_PARTS).toBe(
        "${{ inputs.parts || steps.request-select.outputs.parts }}",
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

// INF-1343 (the captain's "Stop a failing pull request check at its first failed part" and
// "Upload the 530 MB phone results only when a check fails"); since INF-2139 the early stop
// belongs to a complete branch selection and its edited-part passes.
describe("a failing phone check", () => {
  it("stops at its first failed part only for a complete selection, its edited-part passes included", () => {
    const gate = stepsThatRun(OFF).find(isGate) as Step;
    const stopEarly = gate.env?.INFINITARY_PHONE_STOP_EARLY?.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    for (const [full, repeat, value] of [
      ["true", "", "1"],
      ["true", "join-read", "1"],
      ["false", "", "0"],
      ["", "", "0"],
    ] as const)
      expect(
        holds(`(${stopEarly}) == '${value}'`, {
          steps: { "request-select": { outputs: { full, repeat_parts: repeat } } },
        }),
      ).toBe(true);
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
    const uploaded = (name: string, files: string[]) => {
      const step = (workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[]).find(
        (each) =>
          each.uses?.startsWith("actions/upload-artifact") &&
          workflowString(String(each.with?.name ?? ""), { inputs: {} }) === name,
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
  it("starts the device gate for both devices", () => {
    // INF-662: one gate runs both devices, and neither stops the other (virtual-mac-phone.test.ts).
    for (const virtualMac of [OFF, IN_TURN, TOGETHER])
      expect(names(stepsThatRun(virtualMac).filter(isGate))).toEqual([BOTH]);
  });
});

// INF-1066: extracting a saved native scene capture uses Xcode, but starts no new device gate.
it("exports existing native evidence without starting simulators", () => {
  expect(eligible("", "40023566877")).toBe("false");
  expect(eligible("")).toBe("true");
});

// INF-1258: the captain picked touched parts only for crewmate requests, not PR/nightly gates.
describe("affected request routing", () => {
  const steps = workflow.jobs[NATIVE_JOB].steps as Step[];
  const request = steps.find((step) => step.id === "request-select")!;
  it("accounts for affected, full and explicit requests without changing main", () => {
    for (const [event, affected, parts, expected] of [
      ["workflow_dispatch", true, "", true],
      ["workflow_dispatch", false, "", true],
      // INF-2259: explicit diagnostic parts never silently become a complete
      // verification request, even when they name the whole live part table.
      ["workflow_dispatch", true, "cards", false],
      ["workflow_dispatch", true, PHONE_PARTS.map((part) => part.name).join(" "), false],
    ] as const) {
      // Boolean inputs must remain BooleanData, not the truthy string "false".
      expect(
        holds(condition(request), {
          github: { event_name: event },
          inputs: { affected, parts },
        }),
      ).toBe(expected);
    }
  });
  it("passes selected parts into the device gate and honors explicit diagnostic parts", () => {
    const expression = (workflow.jobs[NATIVE_JOB].steps as Step[])
      .find((step) => step.id === "both")!
      .env!.PHONE_PARTS!.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const ast = new Parser(new Lexer(expression).lex().tokens, ["inputs", "steps"], []).parse();
    for (const [parts, chosen, expected] of [
      ["", "cards", "cards"],
      ["join", "cards", "join"],
      ["", "", ""],
    ])
      expect(
        new Evaluator(
          ast,
          toData({
            inputs: { parts: parts! },
            steps: { "request-select": { outputs: { parts: chosen! } } },
          }),
        )
          .evaluate()
          .coerceString(),
      ).toBe(expected);
  });
  it("starts selected requests, skips an empty affected request, and keeps default full runs", () => {
    for (const [affected, parts, chosen, expected] of [
      [true, "", "cards", true],
      [true, "", "", false],
      [false, "", "", true],
      [true, "join", "", true],
    ] as const)
      expect(
        holds(gateCondition(), {
          github: { event_name: "workflow_dispatch" },
          inputs: { affected, parts },
          steps: { "request-select": { outputs: { parts: chosen } } },
        }),
      ).toBe(expected);
  });
});

// INF-2259: full ordinary coverage and exactly two further edited-test passes, at one workflow
// version, never retries after a failure. INF-2582 direction A (the captain's "A: wait once and
// trim the soak"): both further passes run in the ordinary job's gate, on its build and simulators,
// so a request waits for a phone Mac once; scripts/phone-test-plan.ts orders the passes.
describe("complete-selection phone CI repeats", () => {
  const gate = () => (workflow.jobs[NATIVE_JOB].steps as Step[]).find(isGate)!;
  it("runs no job on a phone Mac but the one native job", () => {
    const onPhoneMac = Object.entries(workflow.jobs as Record<string, { "runs-on": string }>)
      .filter(([, job]) => String(job["runs-on"]).includes("MAC_QUEUES).phone"))
      .map(([id]) => id);
    expect(onPhoneMac).toEqual([NATIVE_JOB]);
    expect(workflow.jobs[NATIVE_JOB].outputs).toBeUndefined();
  });
  it("hands the chooser's edited parts and iPhone-only parts to the one gate", () => {
    const chosen = {
      inputs: { parts: "" },
      steps: {
        "request-select": {
          outputs: {
            parts: "join-read talk-tasks rest",
            iphone_parts: "join-read rest",
            repeat_parts: "talk-tasks",
            full: "true",
          },
        },
      },
    };
    expect(workflowString(gate().env!.PHONE_PARTS!, chosen)).toBe("join-read talk-tasks rest");
    expect(workflowString(gate().env!.PHONE_IPHONE_PARTS!, chosen)).toBe("join-read rest");
    expect(workflowString(gate().env!.PHONE_REPEAT_PARTS!, chosen)).toBe("talk-tasks");
    expect(workflowString(gate().env!.INFINITARY_PHONE_STOP_EARLY!, chosen)).toBe("1");
  });
});

// INF-2582 direction A: a request on a branch runs 2 of INF-1735's 20 relaunch pairs, one per relaunch
// part; a check of main and the phone release's call run all 20.
describe("the relaunch soak", () => {
  const pairs = (github: Plain, inputs: Plain = {}) =>
    workflowString(
      String(
        (workflow.jobs[NATIVE_JOB].steps as Step[]).find(isGate)!.env!
          .INFINITARY_PHONE_RELAUNCH_PAIRS,
      ),
      { github, inputs },
    );
  it("trims a branch request to one pair a part and keeps every pair on main and in the release", () => {
    expect(pairs(BRANCH_REQUEST)).toBe("1");
    expect(pairs(BRANCH_REQUEST, { affected: true, parts: "relaunch-first" })).toBe("1");
    expect(relaunchPairs(pairs(BRANCH_REQUEST)) * 2).toBe(2);
    expect(pairs({ event_name: "workflow_dispatch", ref: "refs/heads/main" })).toBe("");
    expect(
      pairs(
        { event_name: "workflow_dispatch", ref: "refs/heads/main" },
        { source_commit: "3835224557b6764d4455b13c1cee359fbb09b5f1" },
      ),
    ).toBe("");
    expect(relaunchPairs("") * 2).toBe(20);
  });
});
