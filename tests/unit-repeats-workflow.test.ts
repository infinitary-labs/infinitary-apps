import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { repetitionArgs } from "../scripts/unit-repeats.ts";

const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
  load: (input: string) => unknown;
};
type RepeatsJob = {
  name: string;
  strategy: { "fail-fast": boolean; matrix: { shard: number[] } };
  steps: { run?: string; "timeout-minutes"?: number; env?: Record<string, string> }[];
};
function job(): RepeatsJob {
  const workflow = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: { "unit-repeats": RepeatsJob };
  };
  return workflow.jobs["unit-repeats"];
}
function interpolate(template: string, contexts: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression: string) => {
    const ast = new Parser(new Lexer(expression).lex().tokens, Object.keys(contexts), []).parse();
    const context = JSON.parse(JSON.stringify(contexts), data.reviver) as data.Dictionary;
    return new Evaluator(ast, context).evaluate().coerceString();
  });
}

// INF-2203: the two real Actions entries must cover every shard, retain the
// existing 30-minute deadline, and select the same PR or manual branch range.
describe("the changed-file repetition workflow", () => {
  it("evaluates every matrix entry into a complete distinct Vitest shard", () => {
    const repeats = job();
    const step = repeats.steps.find((s) => s.run?.startsWith("pnpm test:repeats"));
    expect(step).toBeDefined();
    expect(step?.["timeout-minutes"]).toBe(30);
    expect(repeats.strategy["fail-fast"]).toBe(false);
    const shards = repeats.strategy.matrix.shard;
    const commands = shards.map((shard) => {
      const context = { matrix: { shard }, strategy: { "job-total": shards.length } };
      const split = interpolate(step?.env?.SHARD ?? "", context);
      expect(interpolate(repeats.name, context)).toBe(`unit-repeats (${split})`);
      // Read the actual workflow command's arguments after environment expansion.
      const command = step?.run?.replace('"$BASE"', "origin/main").replace('"$SHARD"', split);
      expect(command).toBe(`pnpm test:repeats --base origin/main --shard ${split}`);
      return repetitionArgs(
        ["tests/unit-repeats.test.ts", "tests/unit-repeats-workflow.test.ts"],
        split,
      );
    });
    expect(shards).toEqual([1, 2]);
    expect(commands).toEqual(
      shards.map((shard) => [
        "exec",
        "vitest",
        "run",
        "--retry",
        "0",
        "--shard",
        `${shard}/${shards.length}`,
        "tests/unit-repeats.test.ts",
        "tests/unit-repeats-workflow.test.ts",
      ]),
    );
  });

  it.each([
    ["pull_request", "main", "origin/main"],
    ["pull_request", "release", "origin/release"],
    ["workflow_dispatch", "", "origin/main"],
    ["push", "", ""],
  ])("keeps the %s base selection (%s)", (event, base, expected) => {
    const step = job().steps.find((s) => s.run?.startsWith("pnpm test:repeats"));
    expect(
      interpolate(step?.env?.BASE ?? "", { github: { event_name: event, base_ref: base } }),
    ).toBe(expected);
  });
});
