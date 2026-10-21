import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { GENERATED_CONTRACT, phoneDecision } from "../scripts/affected-phone";
import { DEVICE_GATES, NATIVE_JOB } from "../scripts/replaced-phone-runs";

// INF-79 / INF-136: the captain requested a Mac mini lane for phone/shared-contract PRs.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/phone.yml", "utf8"));

// The native job's actual condition, for the chooser's reading on a pull request, or for a run
// started on request, whose chooser reads nothing.
function eligible(run: boolean | "", event = "pull_request"): string {
  const needs = new data.Dictionary({
    key: "choose-phone",
    value: new data.Dictionary({
      key: "outputs",
      value: new data.Dictionary({ key: "run", value: new data.StringData(String(run)) }),
    }),
  });
  const github = new data.Dictionary({ key: "event_name", value: new data.StringData(event) });
  const expression = workflow.jobs["native-phone"].if;
  const ast = new Parser(
    new Lexer(`!!(${expression})`).lex().tokens,
    ["needs", "github"],
    [],
  ).parse();
  return new Evaluator(
    ast,
    new data.Dictionary({ key: "needs", value: needs }, { key: "github", value: github }),
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
const VIRTUAL_MAC_STEPS = ["Start a fresh virtual Mac", BOTH, "Delete the virtual Mac"];
type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string };
type Plain = { [key: string]: string | Plain };
const STATUS = ["success", "always", "cancelled", "failure"];

function toData(value: Plain): data.Dictionary {
  const dictionary = new data.Dictionary();
  for (const [key, item] of Object.entries(value))
    dictionary.add(key, typeof item === "string" ? new data.StringData(item) : toData(item));
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

// The native job's steps that run, in order, for a value of the switch, with every
// step succeeding and each replacement check reading `replaced`.
function stepsThatRun(virtualMac: string, replaced = "false"): Step[] {
  const seen: Plain = {};
  const ran: Step[] = [];
  for (const step of workflow.jobs[NATIVE_JOB].steps as Step[]) {
    const runs = holds(condition(step), { steps: seen, vars: { PHONE_VIRTUAL_MAC: virtualMac } });
    const reading = runs && step.run?.includes("stop-if-replaced") ? replaced : "";
    if (step.id)
      seen[step.id] = { outcome: runs ? "success" : "skipped", outputs: { replaced: reading } };
    if (runs) ran.push(step);
  }
  return ran;
}
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
    // INF-355: changing the native registration witness must exercise its simulator consumer.
    "tests/helpers/phoneKeyboard.ts",
    "scripts/phone-test-home.ts",
    "scripts/affected-phone.ts",
    "scripts/with-mac-check.py",
    "scripts/replaced-phone-runs.ts",
    // INF-663: the gate's checks before its simulator tests.
    "scripts/phone-checks.ts",
    // INF-524: the virtual Mac path the switch turns on.
    "scripts/virtual-mac/phone.sh",
    "scripts/virtual-mac/phone-job.sh",
    "scripts/virtual-mac/vm.sh",
  ])("runs the actual workflow condition when %s changes", (path) => {
    expect(eligible(phoneDecision([path]).run)).toBe("true");
  });
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
    // Real shared/exclusive command admission belongs to mac-check-lock.test.ts.
    const journeys = yaml.load(readFileSync(".github/workflows/journeys.yml", "utf8"));
    const native = workflow.jobs["native-phone"].concurrency;
    expect(journeys.jobs["affected-journeys"].concurrency).toBeUndefined();
    const resolveGroup = (group: string, ref: string) =>
      group.replace(/\$\{\{(.*?)\}\}/g, (_: string, expression: string) => {
        const github = new data.Dictionary({ key: "ref", value: new data.StringData(ref) });
        const ast = new Parser(new Lexer(expression).lex().tokens, ["github"], []).parse();
        return new Evaluator(ast, new data.Dictionary({ key: "github", value: github }))
          .evaluate()
          .coerceString();
      });
    const refs = ["refs/pull/79/merge", "refs/pull/136/merge"];
    const phones = refs.map((ref) => resolveGroup(native.group, ref));
    const desktops = refs.map((ref) => resolveGroup(journeys.concurrency.group, ref));
    expect(phones[0]).toBeTruthy();
    expect(new Set(phones).size).toBe(1);
    expect(new Set(desktops).size).toBe(refs.length);
    expect(desktops.some((group) => phones.includes(group))).toBe(false);
    expect(native.queue).toBe("max");
    expect(native["cancel-in-progress"]).toBe(false);
  });
  it("never holds a newer version behind its pull request's older run", () => {
    // INF-487: a run-level group kept PR #135's current version waiting for hours.
    expect(workflow.concurrency).toBeUndefined();
    const cancel = workflow.jobs["cancel-replaced"];
    expect(cancel.needs).toBeUndefined();
    expect(cancel.if).toBeUndefined();
    expect(cancel.steps.at(-1).run).toBe("node scripts/replaced-phone-runs.ts cancel-older");
  });
  it("names the native job and its simulator steps as the replacement script reads them", () => {
    const gates = workflow.jobs[NATIVE_JOB].steps
      .filter((step: { run?: string }) =>
        /scripts\/test-phone\.ts|scripts\/virtual-mac\/phone\.sh gate/.test(step.run ?? ""),
      )
      .map((step: { name: string }) => step.name);
    expect(gates).toEqual(DEVICE_GATES);
  });
  it("reads the pull request's latest version right before each device gate", () => {
    const steps = workflow.jobs[NATIVE_JOB].steps;
    for (const gate of [IPHONE, IPAD]) {
      const at = steps.findIndex((step: { name: string }) => step.name === gate);
      expect(steps[at - 1].run).toBe("node scripts/replaced-phone-runs.ts stop-if-replaced");
    }
  });
  it("skips the iPhone gate when a newer push replaced this version, a manual rerun included", () => {
    // INF-487: a rerun of a replaced version has no newer run to cancel it while it waits.
    expect(gateStarts(IPHONE, "", "false")).toBe("true");
    // The replacement check failed to read: the gate still runs.
    expect(gateStarts(IPHONE, "", "")).toBe("true");
    expect(gateStarts(IPHONE, "", "true")).toBe("false");
  });
  it("skips the iPad gate only when a newer push replaced this version", () => {
    expect(gateStarts(IPAD, "success", "false")).toBe("true");
    expect(gateStarts(IPAD, "failure", "false")).toBe("true");
    // The replacement check failed to read: the gate still runs.
    expect(gateStarts(IPAD, "success", "")).toBe("true");
    expect(gateStarts(IPAD, "success", "true")).toBe("false");
    expect(gateStarts(IPAD, "skipped", "")).toBe("false");
  });
  it("receives every pull request and selects the Mac mini without a paid fallback", () => {
    expect(workflow.on).toEqual({ pull_request: null, workflow_dispatch: null });
    const expression = workflow.jobs["native-phone"]["runs-on"].replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const ast = new Parser(new Lexer(expression).lex().tokens, ["vars"], []).parse();
    for (const configured of ["mini-mac", ""]) {
      const variables = new data.Dictionary({
        key: "MAC_RUNNER",
        value: new data.StringData(configured),
      });
      expect(
        new Evaluator(ast, new data.Dictionary({ key: "vars", value: variables }))
          .evaluate()
          .coerceString(),
      ).toBe("mini-mac");
    }
    expect(workflow.jobs["native-phone"]["continue-on-error"]).toBeUndefined();
  });
  it("runs today's steps on the Mac mini while the virtual Mac switch is off", () => {
    const all = names(workflow.jobs[NATIVE_JOB].steps);
    expect(names(stepsThatRun(OFF))).toEqual(
      all.filter((name) => !VIRTUAL_MAC_STEPS.includes(name)),
    );
    for (const step of stepsThatRun(OFF).filter(isGate)) {
      // The step's shell takes the Mac check lease unless the switch is set.
      expect(step.run).toMatch(
        /^if \[ -n "\$PHONE_VIRTUAL_MAC" \]; then exec .*; fi\npython3 scripts\/with-mac-check\.py --max-hold \d+[smh] exclusive /,
      );
    }
    // The gates' shell sees the switch as the repository sets it, empty when unset.
    const shell = workflow.jobs[NATIVE_JOB].env.PHONE_VIRTUAL_MAC.replace(
      /^\$\{\{\s*|\s*\}\}$/g,
      "",
    );
    for (const value of [OFF, IN_TURN, TOGETHER])
      expect(holds(`(${shell}) == '${value}'`, { vars: { PHONE_VIRTUAL_MAC: value } })).toBe(true);
  });
  it("runs the device gates in a fresh virtual Mac on its own runner when the switch is on", () => {
    const expression = workflow.jobs[NATIVE_JOB]["runs-on"];
    const runner = (virtualMac: string, macRunner: string) =>
      [virtualMac && "mini-mac-vm", macRunner, "mini-mac"].find(Boolean);
    for (const virtualMac of [OFF, IN_TURN, TOGETHER])
      for (const macRunner of ["", "mini-mac"]) {
        const vars = { PHONE_VIRTUAL_MAC: virtualMac, MAC_RUNNER: macRunner };
        for (const label of ["mini-mac", "mini-mac-vm"])
          expect(
            holds(`(${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")}) == '${label}'`, { vars }),
          ).toBe(runner(virtualMac, macRunner) === label);
      }
    const inTurn = names(stepsThatRun(IN_TURN));
    const together = names(stepsThatRun(TOGETHER));
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
      gatesIn(inTurn).filter(
        (name) => DEVICE_GATES.includes(name) || VIRTUAL_MAC_STEPS.includes(name),
      ),
    ).toEqual(["Start a fresh virtual Mac", IPHONE, IPAD, "Delete the virtual Mac"]);
    expect(
      gatesIn(together).filter(
        (name) => DEVICE_GATES.includes(name) || VIRTUAL_MAC_STEPS.includes(name),
      ),
    ).toEqual(["Start a fresh virtual Mac", BOTH, "Delete the virtual Mac"]);
    // In the virtual Mac no gate takes the Mac check lease: phone checks wait only for each
    // other through the mac-mini-phone queue (the captain's answer on INF-79's rule).
    expect(
      stepsThatRun(IN_TURN)
        .filter(isGate)
        .map((step) => step.run?.split("\n")[0]),
    ).toEqual([
      'if [ -n "$PHONE_VIRTUAL_MAC" ]; then exec scripts/virtual-mac/phone.sh gate iphone; fi',
      'if [ -n "$PHONE_VIRTUAL_MAC" ]; then exec scripts/virtual-mac/phone.sh gate ipad; fi',
    ]);
    expect(
      stepsThatRun(TOGETHER)
        .filter(isGate)
        .map((step) => step.run),
    ).toEqual(["scripts/virtual-mac/phone.sh gate iphone ipad"]);
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

// INF-663 (captain: "add a nightly phone check" on main): a run started on request checks
// both devices whatever changed, and every gate's failure reaches the run.
describe("the phone check on request", () => {
  const ON_REQUEST = "workflow_dispatch";
  it("runs the native job whatever changed, while a pull request still asks the chooser", () => {
    const select = workflow.jobs["choose-phone"].steps.find(
      (step: Step) => step.id === "select",
    ) as Step;
    expect(holds(condition(select), { github: { event_name: ON_REQUEST } })).toBe(false);
    expect(holds(condition(select), { github: { event_name: "pull_request" } })).toBe(true);
    // The skipped chooser leaves its reading empty.
    expect(eligible("", ON_REQUEST)).toBe("true");
    expect(eligible(false, "pull_request")).toBe("false");
  });
  it("starts both device gates and the iPad gate after a failed iPhone gate", () => {
    // The replacement script answers replaced=false with no pull request (replaced-phone-runs.test.ts).
    for (const virtualMac of [OFF, IN_TURN])
      expect(names(stepsThatRun(virtualMac, "false").filter(isGate))).toEqual([IPHONE, IPAD]);
    expect(gateStarts(IPAD, "failure", "false")).toBe("true");
  });
});
