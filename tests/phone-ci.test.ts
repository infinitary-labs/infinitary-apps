import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { phoneDecision } from "../scripts/affected-phone";

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
