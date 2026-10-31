import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { citationsIn, holdProblems } from "../scripts/holds";
import {
  fixedHoldWords,
  HOLDS,
  type HoldKind,
  overrideRefusal,
  softHoldWords,
  withoutHoldWords,
} from "../src/shared/holds";

/**
 * INF-242's plan, move 3 of INF-484 (INF-473): "a hold outside the registry
 * fails pnpm check". `pnpm check` runs the script over the tree; here, what
 * it says of a source and of the docs table.
 */
describe("the holds registry check", () => {
  const docs = readFileSync(resolve(__dirname, "../docs/delivery-rigor.md"), "utf8");
  /** Every registered kind cited once, as the sites cite them. */
  const sites = (Object.keys(HOLDS) as (keyof typeof HOLDS)[]).map((kind) => ({
    path: `src/core/sites/${kind}.ts`,
    text:
      HOLDS[kind].level === "fixed"
        ? `return \`this work has no merge. \${fixedHoldWords("${kind}")}\`;`
        : `return \`the current version needs an independent review. \${softHoldWords("${kind}", "firstmate")}\`;`,
  }));

  it("passes the registry as the docs table lists it, each kind cited", () => {
    expect(holdProblems(HOLDS, sites, docs)).toEqual([]);
  });

  it("refuses a kind no registry entry holds", () => {
    const site = {
      path: "src/core/orchestrator/settleService.ts",
      text: 'if (overridePasses(record.delivery, "budget", at)) return undefined;',
    };
    expect(holdProblems(HOLDS, [...sites, site], docs)).toEqual([
      expect.stringContaining(
        'src/core/orchestrator/settleService.ts:1: overridePasses cites "budget", a hold outside the registry',
      ),
    ]);
  });

  it("refuses a hold's sentence written by hand", () => {
    const site = {
      path: "src/core/orchestrator/prCi.ts",
      text: "return `Cannot merge yet. Soft hold quota: the captain's own words pass it.`;",
    };
    expect(holdProblems(HOLDS, [...sites, site], docs)).toEqual([
      expect.stringContaining("src/core/orchestrator/prCi.ts:1: a hold's sentence written by hand"),
    ]);
  });

  it("refuses an override read on a fixed limit or a hold with a way of its own", () => {
    const site = {
      path: "src/core/orchestrator/prCi.ts",
      text: [
        'overridePasses(delivery, "sign-in", head);',
        'overridePasses(delivery, "escalation", head);',
      ].join("\n"),
    };
    expect(holdProblems(HOLDS, [...sites, site], docs)).toEqual([
      expect.stringContaining(
        'prCi.ts:1: overridePasses cites "sign-in", which the registry holds fixed',
      ),
      expect.stringContaining(
        'prCi.ts:2: overridePasses cites "escalation", which the registry holds soft with a way of its own',
      ),
    ]);
  });

  it("refuses an entry no site cites", () => {
    const problems = holdProblems(
      HOLDS,
      sites.filter((site) => !site.path.endsWith("/decisions.ts")),
      docs,
    );
    expect(problems).toEqual([expect.stringContaining('"decisions" has no site')]);
  });

  it("refuses a docs table out of step with the registry", () => {
    const drifted = docs.replace(
      "| `decisions` | soft | record |",
      "| `decisions` | fixed | record |",
    );
    expect(holdProblems(HOLDS, sites, drifted)).toEqual([
      expect.stringContaining(
        '"decisions" reads fixed, record; the registry holds it soft, record',
      ),
    ]);
    const missing = docs.replace(/^\| `decisions` \|.*\n/m, "");
    expect(holdProblems(HOLDS, sites, missing)).toEqual([
      expect.stringContaining('"The holds" table lists'),
    ]);
  });

  it("reads the kind from its argument, the branches of a choice and not what it compares", () => {
    const text = `!overridePasses(
          delivery,
          blocker.shape?.kind === "review" ? "parts" : "waits",
          delivery?.headSha,
        )`;
    expect(citationsIn("src/core/tasks/taskService.ts", text).map((site) => site.kind)).toEqual([
      "parts",
      "waits",
    ]);
    expect(
      citationsIn(
        "src/core/orchestrator/prCi.ts",
        'overridePasses(current.delivery, "story", existing?.headSha ?? (await git(dir, ["rev-parse", branch])))',
      ).map((site) => site.kind),
    ).toEqual(["story"]);
  });
});

/** His line leaves the agents' sentences out (the vocabulary: no tool names on his surface). */
describe("an override naming a retired hold", () => {
  it("is refused in words that name the retired hold, never a crash (INF-1876)", () => {
    // A release before INF-1876 wrote the review and live-proof holds; an
    // older record or habit may still name one.
    const refusal = overrideRefusal(["checks", "review" as HoldKind, "live-proof" as HoldKind]);
    expect(refusal).toContain(
      "review is a retired hold: nothing holds on it now, so leave it out.",
    );
    expect(refusal).toContain("live-proof is a retired hold");
    expect(overrideRefusal(["checks", "waits"])).toBeUndefined();
  });
});

describe("a line the captain reads", () => {
  it("takes out every hold sentence and nothing else", () => {
    const text = `Cannot merge: the current version needs an independent review. ${softHoldWords("checks", "firstmate")}`;
    expect(withoutHoldWords(text)).toBe(
      "Cannot merge: the current version needs an independent review.",
    );
    expect(withoutHoldWords(`Nothing to merge. ${fixedHoldWords("nothing-to-merge")}`)).toBe(
      "Nothing to merge.",
    );
    expect(withoutHoldWords("Cannot merge: the task closed.")).toBe(
      "Cannot merge: the task closed.",
    );
  });
});
