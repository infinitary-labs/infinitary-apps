import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Asked,
  bestFloor,
  readEvalSet,
  readTags,
  scoreAsked,
} from "../scripts/score-task-tags.ts";

/**
 * The tag scorer reports, per tag and overall, precision, recall and the
 * tasks tagged exactly right, and for the probability way it keeps the
 * floor that tags the most tasks exactly right (the task tags plan, piece 2).
 */

const ROOT = resolve(import.meta.dirname, "..");
const TAGS = readTags(join(ROOT, "tests", "fixtures", "task-tags", "tags.json"));

function asked(
  id: string,
  expected: string[],
  predicted: string[],
  extra: Partial<Asked> = {},
): Asked {
  return {
    id,
    expected,
    predicted,
    unsure: 0,
    failed: 0,
    failures: [],
    requests: 1,
    input: 0,
    output: 0,
    ms: 0,
    ...extra,
  };
}

describe("the tag scorer", () => {
  it("reads the kept eval set against the kept tags", () => {
    const rows = readEvalSet(join(ROOT, "tests", "fixtures", "task-tags", "eval.jsonl"), TAGS);
    const names = TAGS.map((tag) => tag.name);
    expect(names).toEqual([
      "bug",
      "ci",
      "docs",
      "feature",
      "idea",
      "ios",
      "prompts",
      "release",
      "windows",
    ]);
    for (const name of names) {
      expect(rows.filter((row) => row.tags.includes(name)).length).toBeGreaterThanOrEqual(20);
    }
    expect(rows.filter((row) => row.tags.length === 0).length).toBeGreaterThanOrEqual(60);
  });

  it("scores precision and recall per tag and overall, and exact matches per task", () => {
    const scores = scoreAsked(
      [
        // Right on both tags.
        asked("t1", ["bug", "ios"], ["bug", "ios"]),
        // One right tag, one extra.
        asked("t2", ["ci"], ["ci", "bug"]),
        // A tag missed, and one question failed.
        asked("t3", ["windows"], [], { failed: 1, failures: ["unparsed"] }),
        // Fits no tag, and none kept.
        asked("t4", [], [], { unsure: 2 }),
        // A tag missed with every question answered.
        asked("t5", ["docs"], []),
      ],
      TAGS,
    );
    // Kept 4 tags, 3 of them right; expected 5 tags, 3 of them found.
    expect(scores).toMatchObject({ precision: 0.75, recall: 0.6, exact: 0.4, exact_tasks: 2 });
    expect(scores).toMatchObject({ unsure: 2, failed: 1, failures: { unparsed: 1 } });
    expect(scores.per_tag.bug).toEqual({ expected: 1, predicted: 2, precision: 0.5, recall: 1 });
    expect(scores.per_tag.windows).toEqual({
      expected: 1,
      predicted: 0,
      precision: null,
      recall: 0,
    });
  });

  it("keeps the probability floor that tags the most tasks exactly right", () => {
    const { best } = bestFloor(
      [
        asked("t1", ["bug", "ios"], [], {
          probabilities: { bug: 0.5, ios: 0.3, ci: 0.1, none: 0.1 },
        }),
        asked("t2", ["ci"], [], { probabilities: { ci: 0.8, bug: 0.15, none: 0.05 } }),
        asked("t3", [], [], { probabilities: { none: 0.7, docs: 0.25, ci: 0.05 } }),
      ],
      TAGS,
    );
    // At 0.3 every task is right: t1 keeps bug and ios, t2 keeps ci, t3 keeps nothing.
    // Below it t1 picks up ci (0.1) or t3 docs (0.25); above it t1 loses ios.
    expect(best?.floor).toBe(0.3);
    expect(best?.scores.exact).toBe(1);
  });
});
