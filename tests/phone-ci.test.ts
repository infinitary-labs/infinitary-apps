import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { GENERATED_CONTRACT, phoneDecision } from "../scripts/affected-phone";
import { PHONE_PARTS } from "../scripts/phone-test-plan";
import { DEVICE_GATES, NATIVE_JOB } from "../scripts/replaced-phone-runs";

// INF-79 / INF-136: the captain requested a Mac mini lane for phone/shared-contract PRs.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/phone.yml", "utf8"));

// The native job's condition with its gate step's (INF-2125 P1: the job chooses its own parts),
// for the chooser's reading on a pull request, or for a run started on request, whose chooser
// reads nothing.
function gateCondition(): string {
  const scope = (workflow.jobs["native-phone"].steps as { id?: string; env?: { GATE: string } }[])
    .find((step) => step.id === "scope")!
    .env!.GATE.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return `(${workflow.jobs["native-phone"].if}) && (${scope})`;
}
function eligible(run: boolean | "", event = "pull_request", evidenceRun = ""): string {
  const steps = new data.Dictionary({
    key: "select",
    value: new data.Dictionary({
      key: "outputs",
      value: new data.Dictionary({ key: "run", value: new data.StringData(String(run)) }),
    }),
  });
  const github = new data.Dictionary({ key: "event_name", value: new data.StringData(event) });
  const ast = new Parser(
    new Lexer(`!!(${gateCondition()})`).lex().tokens,
    ["steps", "github", "inputs"],
    [],
  ).parse();
  return new Evaluator(
    ast,
    new data.Dictionary(
      { key: "steps", value: steps },
      { key: "github", value: github },
      {
        key: "inputs",
        value: new data.Dictionary({
          key: "evidence_run",
          value: new data.StringData(evidenceRun),
        }),
      },
    ),
  )
    .evaluate()
    .coerceString();
}

// INF-487: a device gate's actual condition, given the iPhone gate's outcome and
// the reading of the replacement check right before the gate, with the virtual Mac
// switch off.
function gateStarts(gate: string, iphone: string, replaced: string): string {
  const steps = workflow.jobs[NATIVE_JOB].steps;
  const at = steps.findIndex((item: { name: string }) => item.name === gate);
  const expression = steps[at].if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const cancelled = { name: "cancelled", minArgs: 0, maxArgs: 0 };
  const context = new data.Dictionary(
    {
      key: "iphone",
      value: new data.Dictionary({ key: "outcome", value: new data.StringData(iphone) }),
    },
    {
      key: steps[at - 1].id,
      value: new data.Dictionary({
        key: "outputs",
        value: new data.Dictionary({ key: "replaced", value: new data.StringData(replaced) }),
      }),
    },
    // The chooser kept parts (gateCondition).
    {
      key: "scope",
      value: new data.Dictionary({
        key: "outputs",
        value: new data.Dictionary({ key: "gate", value: new data.StringData("true") }),
      }),
    },
  );
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    ["steps", "vars"],
    [cancelled],
  ).parse();
  const functions = new Map([
    ["cancelled", { ...cancelled, call: () => new data.BooleanData(false) }],
  ]);
  const contexts = new data.Dictionary(
    { key: "steps", value: context },
    { key: "vars", value: new data.Dictionary() },
  );
  return new Evaluator(ast, contexts, functions).evaluate().coerceString();
}
const [IPHONE, IPAD, BOTH] = DEVICE_GATES as [string, string, string];

// INF-524 (the captain's approved plan INF-517): the repository variable that moves the
// device gates into a virtual Mac. GitHub reads an unset variable as "".
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

const PULL_REQUEST = { event_name: "pull_request", ref: "refs/pull/1/merge" };
// The native job's steps that run, in order, for a value of the switch, with every
// step succeeding (or the job failed, when `failed`) and each replacement check reading `replaced`;
// `outputs` gives a step's other outputs by its id.
function stepsThatRun(
  virtualMac: string,
  replaced = "false",
  failed = false,
  inputs: Plain = {},
  github: Plain = PULL_REQUEST,
  outputs: Record<string, Plain> = {},
): Step[] {
  const seen: Plain = {};
  const ran: Step[] = [];
  for (const step of workflow.jobs[NATIVE_JOB].steps as Step[]) {
    const runs = holds(
      condition(step),
      { steps: seen, vars: { PHONE_VIRTUAL_MAC: virtualMac }, inputs, github },
      { failed },
    );
    const reading = runs && step.run?.includes("stop-if-replaced") ? replaced : "";
    // The chooser kept parts (gateCondition).
    const gate = runs && step.id === "scope" ? "true" : "";
    if (step.id)
      seen[step.id] = {
        outcome: runs ? "success" : "skipped",
        outputs: { replaced: reading, gate, ...(runs ? outputs[step.id] : {}) },
      };
    if (runs) ran.push(step);
  }
  return ran;
}
const RESULTS = "Keep native results and connection readings";
const SAVE_PACKAGES = "Save the Swift packages for pull requests";
// The chooser's steps a pull request skips: the simulated search for main's part times finds no
// run, and only a crewmate's request chooses affected parts.
const SKIPPED_CHOOSER_STEPS = [
  "Read that check's part times",
  "Choose affected parts for a crewmate request",
];
const names = (steps: Step[]) => steps.map((step) => step.name ?? step.uses ?? "");
const isGate = (step: Step) => DEVICE_GATES.includes(step.name ?? "");

describe("the native pull-request gate", () => {
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
  ])("runs the actual workflow condition when %s changes", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("true");
  });
  // INF-827 (the captain's "skip changes to unused setup"): the device gates never run the
  // chooser, the replacement script or the local test home, nor the virtual Mac scripts while
  // the switch is off.
  it.each([
    "scripts/phone-test-home.ts",
    "scripts/affected-phone.ts",
    "scripts/replaced-phone-runs.ts",
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
  it("queues only phone jobs across PRs, leaving desktop PRs independent", () => {
    // The captain's review-cap choice replaces the former all-jobs queue.
    // Command overlap belongs to mac-check-lock.test.ts.
    // INF-989 (captain: "let both virtual Macs run phone checks at once by ending the
    // one-at-a-time line"): a job on the virtual-Mac label gets a group of its own; the Mac
    // mini's runners and PHONE_VIRTUAL_MAC's one fixed clone keep the shared line.
    const journeys = yaml.load(readFileSync(".github/workflows/journeys.yml", "utf8"));
    const native = workflow.jobs["native-phone"].concurrency;
    expect(journeys.jobs["affected-journeys"].concurrency).toBeUndefined();
    const resolveGroup = (group: string, given: Plain) => {
      const contexts: Plain = { inputs: {}, ...given };
      return group.replace(/\$\{\{(.*?)\}\}/g, (_: string, expression: string) => {
        const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(contexts), [
          { name: "format", minArgs: 1, maxArgs: 255 },
        ]).parse();
        return new Evaluator(ast, toData(contexts)).evaluate().coerceString();
      });
    };
    // Two pull requests' runs, as GitHub names them.
    const runs = [
      { ref: "refs/pull/79/merge", run_id: "18800000001", run_attempt: "1" },
      { ref: "refs/pull/136/merge", run_id: "18800000002", run_attempt: "1" },
    ];
    const groups = (vars: Plain) =>
      runs.map((github) => resolveGroup(native.group, { github, vars }));
    const desktops = runs.map((github) => resolveGroup(journeys.concurrency.group, { github }));
    expect(new Set(desktops).size).toBe(runs.length);
    const lines: { vars: Plain; shared: boolean }[] = [
      // Today's repository variables: phone checks in the virtual Macs, side by side.
      {
        vars: { VIRTUAL_MAC_RUNNER: "mini-mac-virtual", MAC_RUNNER: "mini-mac-any" },
        shared: false,
      },
      // INF-2112: the phone kind's virtual-only queue, side by side as well.
      {
        vars: { MAC_QUEUES: '{"phone":"mini-mac-phone"}', MAC_RUNNER: "mini-mac-any" },
        shared: false,
      },
      // The Mac mini's own runners keep the shared phone queue.
      { vars: { MAC_RUNNER: "mini-mac-any" }, shared: true },
      {
        vars: { MAC_QUEUES: '{"check":"mini-mac-check"}', MAC_RUNNER: "mini-mac-any" },
        shared: true,
      },
      { vars: {}, shared: true },
      // PHONE_VIRTUAL_MAC reuses one fixed clone, whatever the other variables say.
      {
        vars: { PHONE_VIRTUAL_MAC: "together", VIRTUAL_MAC_RUNNER: "mini-mac-virtual" },
        shared: true,
      },
      { vars: { PHONE_VIRTUAL_MAC: "together" }, shared: true },
    ];
    for (const { vars, shared } of lines) {
      const phones = groups(vars);
      for (const group of phones) expect(group).toBeTruthy();
      expect(new Set(phones).size).toBe(shared ? 1 : runs.length);
      expect(desktops.some((group) => phones.includes(group))).toBe(false);
    }
    // A rerun of the same run is a new job, never queued behind its own first attempt.
    const virtual = { VIRTUAL_MAC_RUNNER: "mini-mac-virtual" };
    expect(
      resolveGroup(native.group, { github: { ...runs[0], run_attempt: "2" }, vars: virtual }),
    ).not.toBe(groups(virtual)[0]);
    // INF-869: the real-Mac overlap proof selects a runner without changing shared vars.
    const proofGroups = runs.map((github) =>
      resolveGroup(native.group, {
        github,
        vars: virtual,
        inputs: { mac_runner: "mini-mac-real" },
      }),
    );
    expect(proofGroups).toEqual(["mac-mini-phone", "mac-mini-phone"]);
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
  it("never holds a newer version behind its pull request's older run", () => {
    // INF-487: a run-level group kept PR #135's current version waiting for hours.
    expect(workflow.concurrency).toBeUndefined();
    const cancel = workflow.jobs["cancel-replaced"];
    expect(cancel.needs).toBeUndefined();
    expect(cancel.if).toBeUndefined();
    expect(cancel.steps.at(-1).run).toBe("node scripts/replaced-phone-runs.ts cancel-older");
  });
  it("names the native job and its simulator step as the replacement script reads them", () => {
    const gates = workflow.jobs[NATIVE_JOB].steps
      .filter((step: { run?: string }) =>
        /scripts\/test-phone\.ts|scripts\/virtual-mac\/phone\.sh gate/.test(step.run ?? ""),
      )
      .map((step: { name: string }) => step.name);
    // INF-662 piece 1: one gate for both devices. The replacement script still knows the
    // per-device gates, which a pull request's older run of an earlier version shows.
    expect(gates).toEqual([BOTH]);
    expect(DEVICE_GATES).toEqual([IPHONE, IPAD, BOTH]);
  });
  // INF-1083 / INF-1072: the gate, not just its lease, ends on every route.
  it("caps every route at sixty minutes while preserving the 165-minute job", () => {
    for (const route of [OFF, IN_TURN, TOGETHER]) {
      const gates = stepsThatRun(route).filter(isGate);
      expect(gates).toHaveLength(1);
      expect(gates[0]?.["timeout-minutes"]).toBe(60);
    }
    expect(workflow.jobs[NATIVE_JOB]["timeout-minutes"]).toBe(165);
  });
  it("reads the pull request's latest version right before the device gate", () => {
    const steps = workflow.jobs[NATIVE_JOB].steps;
    const at = steps.findIndex((step: { name: string }) => step.name === BOTH);
    expect(steps[at - 1].run).toBe("node scripts/replaced-phone-runs.ts stop-if-replaced");
  });
  it("skips the device gate when a newer push replaced this version, a manual rerun included", () => {
    // INF-487: a rerun of a replaced version has no newer run to cancel it while it waits.
    expect(gateStarts(BOTH, "", "false")).toBe("true");
    // The replacement check failed to read: the gate still runs.
    expect(gateStarts(BOTH, "", "")).toBe("true");
    expect(gateStarts(BOTH, "", "true")).toBe("false");
  });
  it("runs only on request, never on a pull request, and selects the Mac mini without a paid fallback", () => {
    // INF-2139 (captain: "let's pull journeys and phone checks off PRs now").
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      parts: { type: "string" },
      starve: { type: "boolean", default: false },
      perf: { type: "boolean", default: false },
      waits: { type: "boolean", default: false },
      evidence_run: { required: false, type: "string" },
      recording: { required: false, type: "boolean", default: false },
    });
    const expression = workflow.jobs["native-phone"]["runs-on"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const ast = new Parser(new Lexer(expression).lex().tokens, ["vars", "inputs"], []).parse();
    for (const configured of ["mini-mac", ""]) {
      const variables = new data.Dictionary({
        key: "MAC_RUNNER",
        value: new data.StringData(configured),
      });
      expect(
        new Evaluator(
          ast,
          new data.Dictionary(
            { key: "vars", value: variables },
            { key: "inputs", value: new data.Dictionary() },
          ),
        )
          .evaluate()
          .coerceString(),
      ).toBe("mini-mac");
    }
    expect(workflow.jobs["native-phone"]["continue-on-error"]).toBeUndefined();
  });
  // INF-1066: exporting attachments must not supersede a failed native check with a skipped check of the same name.
  it.each(["", "40035937592"])(
    "keeps the native-check name distinct for evidence_run=%s",
    (evidenceRun) => {
      const expression = workflow.jobs[NATIVE_JOB].name.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
      const ast = new Parser(new Lexer(expression).lex().tokens, ["inputs"], []).parse();
      const inputs = new data.Dictionary({
        key: "evidence_run",
        value: new data.StringData(evidenceRun),
      });
      const name = new Evaluator(ast, new data.Dictionary({ key: "inputs", value: inputs }))
        .evaluate()
        .coerceString();
      if (evidenceRun) expect(name).not.toBe(NATIVE_JOB);
      else expect(name).toBe(NATIVE_JOB);
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
  it("runs today's steps on the Mac mini while the virtual Mac switch is off", () => {
    const all = names(workflow.jobs[NATIVE_JOB].steps);
    expect(names(stepsThatRun(OFF))).toEqual(
      all.filter(
        (name) =>
          !VIRTUAL_MAC_STEPS.includes(name) &&
          name !== RESULTS &&
          name !== SAVE_PACKAGES &&
          !SKIPPED_CHOOSER_STEPS.includes(name),
      ),
    );
    // INF-662 piece 1: one gate checks and builds once
    // and runs both devices side by side; the switch, when set, sends it to the virtual Mac.
    expect(
      stepsThatRun(OFF)
        .filter(isGate)
        .map((step) => step.run),
    ).toEqual([
      [
        // INF-827: the parts the chooser kept, none (every part) on a run on request.
        'parts=(); for part in $PHONE_PARTS; do parts+=(--part "$part"); done',
        'if [ -n "$PHONE_VIRTUAL_MAC" ]; then exec scripts/virtual-mac/phone.sh gate iphone ipad; fi',
        // INF-658: a job placed in a virtual Mac uses two simulators.
        'if [ "$(sysctl -n kern.hv_vmm_present 2> /dev/null)" = 1 ]; then exec node scripts/test-phone.ts --both "${parts[@]}" --simulators 2 --evidence "$RUNNER_TEMP/phone"; fi',
        'node scripts/test-phone.ts --both "${parts[@]}" --evidence "$RUNNER_TEMP/phone"',
        "",
      ].join("\n"),
    ]);
    // The gate reads the chooser's parts, which a run on request leaves empty.
    expect(stepsThatRun(OFF).find(isGate)?.env?.PHONE_PARTS).toBe(
      "${{ inputs.parts || steps.select.outputs.parts || steps.request-select.outputs.parts }}",
    );
    // The gates' shell sees the switch as the repository sets it, empty when unset.
    const shell = workflow.jobs[NATIVE_JOB].env.PHONE_VIRTUAL_MAC.replace(
      /^\$\{\{\s*|\s*\}\}$/g,
      "",
    );
    for (const value of [OFF, IN_TURN, TOGETHER])
      expect(holds(`(${shell}) == '${value}'`, { vars: { PHONE_VIRTUAL_MAC: value } })).toBe(true);
  });
  it("selects the requested real Mac for the overlap proof without changing default variables", () => {
    // INF-869 requires a real-Mac phone gate beside a virtual-Mac check.
    const expression = workflow.jobs[NATIVE_JOB]["runs-on"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    expect(
      holds(`(${expression}) == 'mini-mac-real'`, {
        vars: { VIRTUAL_MAC_RUNNER: "mini-mac-virtual", MAC_RUNNER: "mini-mac-any" },
        inputs: { mac_runner: "mini-mac-real" },
      }),
    ).toBe(true);
  });
  it("runs the device gates in a fresh virtual Mac on its own runner when the switch is on", () => {
    const expression = workflow.jobs[NATIVE_JOB]["runs-on"];
    // INF-897: VIRTUAL_MAC_RUNNER puts the job in the placement service's
    // virtual-Mac scale set, which no journey or full check shares; unset, the job
    // runs where MAC_RUNNER sends it, as before. The values are the repository's.
    const runner = (virtualMac: string, virtualRunner: string, macRunner: string) =>
      [virtualMac && "mini-mac-vm", virtualRunner, macRunner, "mini-mac"].find(Boolean);
    for (const virtualMac of [OFF, IN_TURN, TOGETHER])
      for (const virtualRunner of ["", "mini-mac-virtual"])
        for (const macRunner of ["", "mini-mac", "mini-mac-any"]) {
          const vars = {
            PHONE_VIRTUAL_MAC: virtualMac,
            VIRTUAL_MAC_RUNNER: virtualRunner,
            MAC_RUNNER: macRunner,
            REAL_MAC_RUNNER: "mini-mac-real",
          };
          for (const label of ["mini-mac", "mini-mac-vm", "mini-mac-any", "mini-mac-virtual"])
            expect(
              holds(`(${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")}) == '${label}'`, {
                vars,
                inputs: {},
              }),
            ).toBe(runner(virtualMac, virtualRunner, macRunner) === label);
        }
    const inTurn = names(stepsThatRun(IN_TURN));
    const together = names(stepsThatRun(TOGETHER));
    // INF-662 piece 1: every value of the switch runs both devices at once from one build.
    expect(inTurn).toEqual(together);
    // The packages install inside the clone, never on this Mac.
    for (const ran of [inTurn, together])
      expect(ran.filter((name) => name.startsWith("Install") || name.startsWith("pnpm/"))).toEqual(
        [],
      );
    const gatesIn = (ran: string[]) =>
      ran.slice(
        ran.indexOf("Start a fresh virtual Mac"),
        ran.indexOf("Delete the virtual Mac") + 1,
      );
    expect(
      gatesIn(together).filter(
        (name) => DEVICE_GATES.includes(name) || VIRTUAL_MAC_STEPS.includes(name),
      ),
    ).toEqual(["Start a fresh virtual Mac", BOTH, "Delete the virtual Mac"]);
    // The phone switch keeps one fixed clone at a time without excluding desktop checks.
    expect(
      stepsThatRun(TOGETHER)
        .filter(isGate)
        .map((step) => step.run?.split("\n")[1]),
    ).toEqual([
      'if [ -n "$PHONE_VIRTUAL_MAC" ]; then exec scripts/virtual-mac/phone.sh gate iphone ipad; fi',
    ]);
  });
  it("deletes the virtual Mac however the job ends, and never starts one with the switch off", () => {
    const steps = workflow.jobs[NATIVE_JOB].steps as Step[];
    const remove = steps.find((step) => step.name === "Delete the virtual Mac") as Step;
    expect(remove.run).toBe("scripts/virtual-mac/phone.sh delete");
    for (const outcome of ["success", "failure", "cancelled"])
      for (const status of [{}, { failed: true }, { cancelled: true }])
        expect(holds(condition(remove), { steps: { vm: { outcome } }, vars: {} }, status)).toBe(
          true,
        );
    expect(
      holds(
        condition(remove),
        { steps: { vm: { outcome: "skipped" } }, vars: {} },
        { failed: true },
      ),
    ).toBe(false);
    // A replaced version's clone is deleted too, and starts no gate.
    for (const virtualMac of [IN_TURN, TOGETHER]) {
      const ran = names(stepsThatRun(virtualMac, "true"));
      expect(ran.filter((name) => DEVICE_GATES.includes(name))).toEqual([]);
      expect(ran).toContain("Delete the virtual Mac");
    }
  });
  it("reads the latest version right before every device gate, whichever way the switch is set", () => {
    // INF-487: no simulator exists before a gate; the virtual Mac's start creates none.
    for (const virtualMac of [OFF, IN_TURN, TOGETHER]) {
      const ran = stepsThatRun(virtualMac);
      const gates = ran.filter(isGate);
      expect(gates.length).toBeGreaterThan(0);
      for (const gate of gates)
        expect(ran[ran.indexOf(gate) - 1]?.run).toBe(
          "node scripts/replaced-phone-runs.ts stop-if-replaced",
        );
    }
  });
});

// INF-2125 piece 3 (the captain's "i want to get to a state where each PR's phone check finishes very
// quickly", approved plan: "reuse main's SwiftPM package cache"): a pull request reads the Swift packages
// main saved, and only main saves them, since a pull request's own save no other run reads (INF-724).
describe("the phone check's Swift packages", () => {
  const steps = workflow.jobs[NATIVE_JOB].steps as (Step & { with?: Plain })[];
  const restore = steps.find((step) => step.id === "swift-packages")!;
  const save = steps.find((step) => step.name === SAVE_PACKAGES)!;
  const MAIN = { event_name: "workflow_dispatch", ref: "refs/heads/main" };
  const BRANCH = { event_name: "workflow_dispatch", ref: "refs/heads/fm/task-1" };
  const ran = (github: Plain, hit = "", virtualMac = OFF) =>
    names(
      stepsThatRun(virtualMac, "false", false, {}, github, {
        "swift-packages": { "cache-hit": hit },
      }),
    );
  it("restores into the folder the gate reads, and saves that folder under the restore's own key", () => {
    const gate = steps.find(isGate)!;
    expect(gate.env?.INFINITARY_PHONE_PACKAGE_CACHE).toBe(restore.with?.path);
    expect(save.with?.path).toBe(restore.with?.path);
    expect(save.with?.key).toBe("${{ steps.swift-packages.outputs.cache-primary-key }}");
    expect(String(restore.with?.key).startsWith(String(restore.with?.["restore-keys"]))).toBe(true);
  });
  it("restores on every route on this Mac, and saves only from main when nothing matched", () => {
    for (const github of [PULL_REQUEST, MAIN, BRANCH]) expect(ran(github)).toContain(restore.name);
    expect(ran(PULL_REQUEST)).not.toContain(SAVE_PACKAGES);
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
    // A replaced version never started its gate, so it fetched nothing.
    expect(names(stepsThatRun(OFF, "true", false, {}, MAIN))).not.toContain(SAVE_PACKAGES);
  });
  it("neither restores nor saves when the gate runs inside the virtual Mac's clone", () => {
    for (const github of [PULL_REQUEST, MAIN])
      expect(ran(github, "", TOGETHER).filter((name) => name.includes("Swift packages"))).toEqual(
        [],
      );
  });
});

// INF-1343 (the captain's "Stop a failing pull request check at its first failed part" and
// "Upload the 530 MB phone results only when a check fails").
describe("a failing phone check", () => {
  it("stops at its first failed part on a pull request, and runs every part on request", () => {
    const gate = stepsThatRun(OFF).find(isGate) as Step;
    const stopEarly = gate.env?.INFINITARY_PHONE_STOP_EARLY?.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    for (const [event, value] of [
      ["pull_request", "1"],
      ["workflow_dispatch", "0"],
    ] as const)
      expect(holds(`(${stopEarly}) == '${value}'`, { github: { event_name: event } })).toBe(true);
  });
  it("keeps the whole results only when the job failed or recorded, and its logs and pictures always", () => {
    for (const virtualMac of [OFF, TOGETHER]) {
      const kept = (failed: boolean, recording = "") =>
        names(stepsThatRun(virtualMac, "false", failed, { recording }));
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
        (each) => each.uses?.startsWith("actions/upload-artifact") && each.with?.name === name,
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
    const simulatorLogs = (["iphone", "ipad"] as const).flatMap((device) =>
      PHONE_PARTS.map((part) => `${device}/${part.name}/simulator-live.log`),
    );
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
      "ipad/rest/phone.xcresult/Staging/1_Test/Diagnostics/InfinitaryUITests-71653F01-C0E0-418C-AAA9-959D2FAC473C-Configuration-Test Scheme Action-Iteration-1/scheduling.log",
    ];
    const files = [
      ...commandLogs,
      ...simulatorLogs,
      "part-times.json",
      "ipad/rest/phone.xcresult/Info.plist",
    ];
    expect(uploaded("phone-logs", files)).toEqual([...commandLogs, "part-times.json"]);
    expect(uploaded("phone-simulator-logs", files)).toEqual(simulatorLogs);
    expect(simulatorLogs).toHaveLength(PHONE_PARTS.length * 2);
  });
});

// INF-663 (captain: "add a nightly phone check" on main): a run started on request checks
// both devices whatever changed, and every gate's failure reaches the run.
describe("the phone check on request", () => {
  const ON_REQUEST = "workflow_dispatch";
  it("runs the native job whatever changed, while a pull request still asks the chooser", () => {
    const select = workflow.jobs[NATIVE_JOB].steps.find(
      (step: Step) => step.id === "select",
    ) as Step;
    expect(holds(condition(select), { github: { event_name: ON_REQUEST } })).toBe(false);
    expect(holds(condition(select), { github: { event_name: "pull_request" } })).toBe(true);
    // The skipped chooser leaves its reading empty.
    expect(eligible("", ON_REQUEST)).toBe("true");
    expect(eligible(false, "pull_request")).toBe("false");
  });
  it("starts the device gate for both devices", () => {
    // The replacement script answers replaced=false with no pull request (replaced-phone-runs.test.ts).
    // INF-662: one gate runs both devices, and neither stops the other (virtual-mac-phone.test.ts).
    for (const virtualMac of [OFF, IN_TURN, TOGETHER])
      expect(names(stepsThatRun(virtualMac, "false").filter(isGate))).toEqual([BOTH]);
  });
});

// INF-1066: extracting a saved native scene capture uses Xcode, but starts no new device gate.
it("exports existing native evidence without starting simulators", () => {
  expect(eligible("", "workflow_dispatch", "40023566877")).toBe("false");
  expect(eligible("", "workflow_dispatch")).toBe("true");
});

// INF-1346: on 2026-10-25 a passing check of main's cards part alone became the newest passing
// check, and every pull request's chooser read no part times from it and ran every part. The
// step's own script runs against GitHub's answers and the runs' real phone-logs archives.
describe("the chooser's part times", () => {
  type Run = { id: number; conclusion: string | null; html_url: string };
  type Artifact = { id: number; name: string; expired: boolean; zip?: string };
  const FIXTURES = "tests/fixtures/phone-runs/2026-10-25";
  const readings = JSON.parse(readFileSync(`${FIXTURES}/runs.json`, "utf8")) as {
    runs: Run[];
    artifacts: Record<string, Artifact[]>;
  };
  const script = workflow.jobs[NATIVE_JOB].steps.find(
    (step: Step & { with?: { script?: string } }) => step.id === "timing-run",
  )?.with?.script as string;

  async function choose(runs: Run[], artifacts = readings.artifacts) {
    const outputs: Record<string, string> = {};
    const summaries: string[] = [];
    const downloaded: number[] = [];
    const summary = {
      addRaw: (text: string) => {
        summaries.push(text);
        return summary;
      },
      write: async () => {},
    };
    const repo = { owner: "infinitary-labs", repo: "infinitary" };
    // GitHub as it answered: main's runs on request, by page, those that passed if asked.
    const listWorkflowRuns = async ({
      per_page = 30,
      page = 1,
      status,
      ...query
    }: Record<string, unknown>) => {
      expect(query).toEqual({
        ...repo,
        workflow_id: "phone.yml",
        branch: "main",
        event: "workflow_dispatch",
      });
      const listed = runs.filter((run) => !status || run.conclusion === status);
      const from = (Number(page) - 1) * Number(per_page);
      return {
        data: {
          total_count: listed.length,
          workflow_runs: listed.slice(from, from + Number(per_page)),
        },
      };
    };
    const listWorkflowRunArtifacts = async ({
      run_id,
      name,
    }: {
      run_id: number;
      name: string;
    }) => ({
      data: {
        artifacts: (artifacts[String(run_id)] ?? []).filter((artifact) => artifact.name === name),
      },
    });
    const downloadArtifact = async ({ artifact_id }: { artifact_id: number }) => {
      downloaded.push(artifact_id);
      const artifact = Object.values(artifacts)
        .flat()
        .find((candidate) => candidate.id === artifact_id);
      const zip = readFileSync(`${FIXTURES}/${artifact?.zip}`);
      // Octokit hands an archive over as an ArrayBuffer.
      return { data: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
    };
    const iterator = async function* (
      method: typeof listWorkflowRuns,
      parameters: Record<string, unknown>,
    ) {
      for (let page = 1; ; page++) {
        const { data } = await method({ ...parameters, page });
        if (data.workflow_runs.length === 0) return;
        yield { data: data.workflow_runs };
      }
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("core", "github", "context", script)(
      { setOutput: (name: string, value: string) => (outputs[name] = String(value)), summary },
      {
        rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts, downloadArtifact } },
        paginate: { iterator },
      },
      { repo },
    );
    return { outputs, summaries, downloaded };
  }

  it("passes over a check of some parts for the newest passing check with part times", async () => {
    const [cards, full] = readings.runs;
    const found = await choose(readings.runs);
    expect(found.outputs.id).toBe(String(full?.id));
    expect(found.summaries.join("")).toContain(full?.html_url);
    // It read the cards check's logs, found no part times there, and read no older run's.
    expect(found.downloaded).toEqual([
      readings.artifacts[String(cards?.id)]?.find((artifact) => artifact.name === "phone-logs")?.id,
      readings.artifacts[String(full?.id)]?.find((artifact) => artifact.name === "phone-logs")?.id,
    ]);
  });

  it("skips a failed run and expired logs, and names no run when none has part times", async () => {
    const [cards, full] = readings.runs as [Run, Run];
    const failed = { ...full, conclusion: "failure" };
    expect((await choose([cards, failed])).outputs.id).toBeUndefined();
    const expired = {
      ...readings.artifacts,
      [String(full.id)]: (readings.artifacts[String(full.id)] ?? []).map((artifact) => ({
        ...artifact,
        expired: true,
      })),
    };
    const reading = await choose([cards, full], expired);
    expect(reading.outputs.id).toBeUndefined();
    expect(reading.summaries).toEqual([]);
  });
});

// INF-1258: the captain picked touched parts only for crewmate requests, not PR/nightly gates.
describe("affected request routing", () => {
  const steps = workflow.jobs[NATIVE_JOB].steps as Step[];
  const request = steps.find((step) => step.id === "request-select")!;
  it("chooses only for opted-in requests, leaving nightly and explicit diagnostics alone", () => {
    for (const [event, affected, parts, expected] of [
      ["workflow_dispatch", true, "", true],
      ["workflow_dispatch", false, "", false],
      ["workflow_dispatch", true, "cards", false],
      ["pull_request", false, "", false],
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
          steps: {
            select: { outputs: { run: "" } },
            "request-select": { outputs: { parts: chosen } },
          },
        }),
      ).toBe(expected);
  });
});
