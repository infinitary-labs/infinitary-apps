import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { phoneDecision } from "../scripts/affected-phone";
import { DEVICE_GATES, NATIVE_JOB } from "../scripts/replaced-phone-runs";

// INF-79 / INF-136: the captain requested a Mac mini lane for phone/shared-contract PRs.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/phone.yml", "utf8"));

function eligible(run: boolean): string {
  const needs = new data.Dictionary({
    key: "choose-phone",
    value: new data.Dictionary({
      key: "outputs",
      value: new data.Dictionary({ key: "run", value: new data.StringData(String(run)) }),
    }),
  });
  const expression = workflow.jobs["native-phone"].if;
  const ast = new Parser(new Lexer(expression).lex().tokens, ["needs"], []).parse();
  return new Evaluator(ast, new data.Dictionary({ key: "needs", value: needs }))
    .evaluate()
    .coerceString();
}

// INF-487: a device gate's actual condition, given the iPhone gate's outcome and
// the reading of the replacement check right before the gate.
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
  const ast = new Parser(new Lexer(expression).lex().tokens, ["steps"], [cancelled]).parse();
  const functions = new Map([
    ["cancelled", { ...cancelled, call: () => new data.BooleanData(false) }],
  ]);
  return new Evaluator(ast, new data.Dictionary({ key: "steps", value: context }), functions)
    .evaluate()
    .coerceString();
}
const [IPHONE, IPAD] = DEVICE_GATES as [string, string];

describe("the native pull-request gate", () => {
  it.each([
    "ios/Infinitary/InfinitaryApp/PhoneModel.swift",
    "docs/contract.json",
    "scripts/generate-phone-contract.ts",
    "scripts/phone-contract-shapes.ts",
    ".github/workflows/phone.yml",
    "scripts/test-phone.ts",
    "tests/helpers/phoneHome.ts",
    "scripts/phone-test-home.ts",
    "scripts/affected-phone.ts",
    "scripts/with-mac-check.py",
    "scripts/replaced-phone-runs.ts",
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
      .filter((step: { run?: string }) => step.run?.includes("scripts/test-phone.ts"))
      .map((step: { name: string }) => step.name);
    expect(gates).toEqual(DEVICE_GATES);
  });
  it("reads the pull request's latest version right before each device gate", () => {
    const steps = workflow.jobs[NATIVE_JOB].steps;
    for (const gate of DEVICE_GATES) {
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
    expect(workflow.on).toEqual({ pull_request: null });
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
});
