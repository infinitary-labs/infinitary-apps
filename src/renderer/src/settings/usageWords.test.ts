import {
  EMPTY_USAGE_AMOUNT,
  type UsageAmount,
  type UsageModel,
  type UsageSummary,
  type UsageTask,
  type UsageWhere,
} from "@shared/usage";
import { describe, expect, it } from "vitest";
import {
  compactTokens,
  createdWords,
  dollars,
  exactTokens,
  formatAmount,
  formatDay,
  formatRecorded,
  kindWords,
  milestoneWords,
  modelLine,
  periodLabel,
  provenance,
  readouts,
  sortedModels,
  taskCount,
  taskFigures,
  taskNote,
  tokenCategoryCoverage,
  USAGE_WORDS,
  whereRows,
} from "./usageWords";

/** An amount with these tokens, and an estimate over `priced` of its `records`. */
function amount(
  tokens: number,
  cost: number | null,
  records = 1,
  priced = cost === null ? 0 : records,
): UsageAmount {
  return {
    ...EMPTY_USAGE_AMOUNT,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
    records,
    counted: records,
    tokenReported: { input: records, output: records, cacheRead: records, cacheWrite: records },
    cost,
    priced,
  };
}

function model(id: string, value: UsageAmount, extra: Partial<UsageModel> = {}): UsageModel {
  return {
    id,
    provider: "openai-codex",
    providerName: "Codex",
    model: id,
    name: id,
    attribution: "requested",
    priceSources: value.priced > 0 ? ["listed-prices"] : [],
    amount: value,
    places: [],
    where: { firstmate: EMPTY_USAGE_AMOUNT, projects: [], other: EMPTY_USAGE_AMOUNT },
    ...extra,
  };
}

function summary(fields: Partial<UsageSummary> = {}): UsageSummary {
  return {
    query: { period: "30d", scope: "all" },
    since: new Date(2026, 8, 6).getTime(),
    at: new Date(2026, 9, 5, 15).getTime(),
    total: amount(17_260_000, 17.18, 45),
    days: [
      { date: "2026-09-06", amount: EMPTY_USAGE_AMOUNT },
      { date: "2026-10-05", amount: amount(10, 0.1) },
    ],
    models: [model("gpt-6-sol", amount(17_260_000, 17.18, 45))],
    places: [],
    where: { firstmate: EMPTY_USAGE_AMOUNT, projects: [], other: EMPTY_USAGE_AMOUNT },
    finished: 6,
    finishedEver: 18,
    ...fields,
  };
}

describe("Usage's numbers", () => {
  it("writes tokens short and dollars as dollars, and never shows a missing value as zero", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12_400)).toBe("12.4k");
    expect(compactTokens(17_260_000)).toBe("17.26M");
    expect(compactTokens(1_200_000_000)).toBe("1.20B");
    expect(dollars(17.18)).toBe("$17.18");
    expect(dollars(1204.4)).toBe("$1,204");
    expect(dollars(0.004)).toBe("<$0.01");
    expect(formatAmount(amount(10, null), "usd")).toBe(USAGE_WORDS.notAvailable);
    expect(formatAmount(EMPTY_USAGE_AMOUNT, "tokens")).toBe(USAGE_WORDS.notAvailable);
  });

  it("tells a day with nothing recorded from a day whose records have no price", () => {
    expect(formatDay({ date: "2026-10-01", amount: EMPTY_USAGE_AMOUNT }, "usd")).toBe(
      "No activity",
    );
    expect(formatDay({ date: "2026-10-01", amount: amount(40, null) }, "usd")).toBe(
      USAGE_WORDS.notAvailable,
    );
  });

  it("names the period's local dates", () => {
    expect(periodLabel(summary())).toBe("Sep 6–Oct 5 · Local dates");
    expect(periodLabel(summary({ query: { period: "all", scope: "all" } }))).toBe(
      "Since Sep 6 · Local dates",
    );
    expect(periodLabel(summary({ days: [] }))).toBe("Nothing recorded yet");
  });
});

describe("Usage's readouts", () => {
  it("switches the total between tokens and a known estimate with its coverage, and keeps counts as counts", () => {
    expect(readouts(summary(), "tokens").map((readout) => readout.value)).toEqual([
      "17.26M",
      "6",
      "1",
    ]);
    const partial = summary({ total: amount(17_260_000, 15.41, 45, 33) });
    expect(readouts(partial, "usd")[0]).toEqual({
      label: "Known estimate · USD",
      value: "$15.41",
      note: "33 of 45 records priced",
    });
    expect(readouts(summary({ total: amount(400, null, 3) }), "usd")[0]?.value).toBe(
      USAGE_WORDS.notAvailable,
    );
  });

  it("says when older records name a model loosely", () => {
    const older = summary({
      models: [model("opus", amount(10, 1), { attribution: "recorded" })],
    });
    expect(readouts(older, "tokens")[2]?.label).toBe("Recorded models");
    expect(modelLine(older.models[0] as UsageModel)).toBe("Codex · Recorded model");
  });
});

describe("Usage's models and places", () => {
  it("sorts models by the unit shown, a model with no value in it last", () => {
    const unpriced = model("local", amount(900, null));
    const priced = model("sol", amount(100, 2));
    expect(sortedModels([priced, unpriced], "tokens").map((each) => each.id)).toEqual([
      "local",
      "sol",
    ]);
    expect(sortedModels([unpriced, priced], "usd").map((each) => each.id)).toEqual([
      "sol",
      "local",
    ]);
  });

  it("lists the Firstmate first, each project by subtotal with its kinds by category name, and other work last", () => {
    const where: UsageWhere = {
      firstmate: amount(50, null),
      projects: [
        {
          project: { id: "p-web", name: "Website" },
          amount: amount(300, 9),
          kinds: [
            { kind: "plan", amount: amount(100, 9) },
            { kind: "implement", amount: amount(200, null) },
          ],
        },
        {
          project: { id: "p-fm", name: "firstmate-3000" },
          amount: amount(700, 2),
          kinds: [
            { kind: null, amount: amount(300, 1) },
            { kind: "fix", amount: amount(300, 1) },
            { kind: "reproduce", amount: amount(100, null) },
          ],
        },
        {
          project: null,
          amount: amount(5, null),
          kinds: [{ kind: "chore", amount: amount(5, null) }],
        },
      ],
      other: amount(5, null),
    };
    const listed = (unit: "tokens" | "usd") => {
      const rows = whereRows(where, unit, true);
      return rows.projects.map((project) => [
        project.name,
        ...project.kinds.map((kind) => kind.name),
      ]);
    };
    // Largest first in the unit; a tie goes by name.
    expect(listed("tokens")).toEqual([
      ["firstmate-3000", "Fixes", "Other task work", "Issue reproduction"],
      ["Website", "Implementation", "Plans"],
      ["Project unavailable", "Maintenance"],
    ]);
    // In dollars, what has no estimate follows what has one.
    expect(listed("usd")).toEqual([
      ["Website", "Plans", "Implementation"],
      ["firstmate-3000", "Fixes", "Other task work", "Issue reproduction"],
      ["Project unavailable", "Maintenance"],
    ]);
    expect(whereRows(where, "tokens", true).other).toBe(where.other);
  });

  it("keeps the Firstmate in the work that includes it with no activity, and leaves out what has no record", () => {
    const where: UsageWhere = {
      firstmate: EMPTY_USAGE_AMOUNT,
      projects: [],
      other: EMPTY_USAGE_AMOUNT,
    };
    const rows = whereRows(where, "tokens", true);
    expect(rows.firstmate).toBe(EMPTY_USAGE_AMOUNT);
    expect(formatRecorded(EMPTY_USAGE_AMOUNT, "tokens")).toBe("No activity");
    expect(rows.other).toBeNull();
    // A model's own work names the Firstmate only when the model served it.
    expect(whereRows(where, "tokens", false).firstmate).toBeNull();
  });

  it("says where a model's estimates came from and how much of them split by category", () => {
    const claude = model(
      "claude-opus-4-1",
      { ...amount(100, 3, 4, 3), split: 0 },
      {
        attribution: "served",
        priceSources: ["claude"],
      },
    );
    expect(provenance(claude, "usd")).toEqual([
      "Named by the provider that answered.",
      "Estimates are Claude's own, made for each response.",
      "3 of 4 records priced.",
      "No estimate here is split by category.",
    ]);
    expect(provenance(model("local", amount(9, null)), "usd")[1]).toBe(
      "No record of this model has a price, so it has no estimate.",
    );
    // An OpenRouter decision priced by the cost its reply stated.
    const decision = model(
      "typesafe/jev-1.13-20260917",
      { ...amount(474, 0.0000317), split: 0 },
      { provider: "openrouter", attribution: "served", priceSources: ["reported"] },
    );
    expect(provenance(decision, "usd").slice(0, 3)).toEqual([
      "Named by the provider that answered.",
      "Estimates use the cost the provider reported for each response.",
      "1 of 1 records priced.",
    ]);
  });
});

describe("Usage's recent tasks", () => {
  /** A task with every category reported on each of its records. */
  function recent(fields: Partial<UsageTask> = {}): UsageTask {
    return {
      task: { key: "WEB-4", title: "Refresh the homepage", project: "Website" },
      createdAt: new Date(2026, 9, 5, 15, 12).getTime(),
      amount: {
        tokens: { input: 210_000, output: 52_500, cacheRead: 1_732_500, cacheWrite: 105_000 },
        records: 2,
        counted: 2,
        cost: 3.75,
        priced: 2,
        costParts: { input: 0.375, output: 0.1875, cacheRead: 3, cacheWrite: 0.1875 },
        split: 2,
      },
      reported: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
      costReported: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
      ...fields,
    };
  }
  const values = (task: UsageTask, unit: "tokens" | "usd") =>
    taskFigures(task, unit).map((figure) => [figure.label, figure.value, figure.coverage]);

  it("shows the five figures in full, the total counting each category once", () => {
    expect(exactTokens(6_800_000)).toBe("6,800,000");
    expect(values(recent(), "tokens")).toEqual([
      ["Input", "210,000", null],
      ["Output", "52,500", null],
      ["Cache read", "1,732,500", null],
      ["Cache write", "105,000", null],
      ["Total", "2,100,000", null],
    ]);
    expect(taskNote(recent(), "tokens")).toBeNull();
    expect(values(recent(), "usd")).toEqual([
      ["Input", "$0.38", null],
      ["Output", "$0.19", null],
      ["Cache read", "$3.00", null],
      ["Cache write", "$0.19", null],
      ["Total", "$3.75", null],
    ]);
  });

  it("says a category no record reported is not available, and how much a partial one covers", () => {
    const partial = recent({ reported: { input: 2, output: 2, cacheRead: 2, cacheWrite: 0 } });
    expect(values(partial, "tokens")[3]).toEqual(["Cache write", USAGE_WORDS.notAvailable, null]);
    const half = recent({ reported: { input: 1, output: 2, cacheRead: 2, cacheWrite: 2 } });
    expect(values(half, "tokens")[0]).toEqual(["Input", "210,000", "1 of 2 records"]);
    expect(taskNote(half, "tokens")).toBe(
      "The total counts recorded tokens only; some categories were not reported.",
    );
  });

  it("shows only an estimate's recorded parts in dollars, never a total split after the fact", () => {
    // Claude's own estimate: a total with no split.
    const whole = recent({
      amount: {
        ...recent().amount,
        costParts: { input: null, output: null, cacheRead: null, cacheWrite: null },
        split: 0,
      },
      costReported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(values(whole, "usd").map(([, value]) => value)).toEqual([
      USAGE_WORDS.notAvailable,
      USAGE_WORDS.notAvailable,
      USAGE_WORDS.notAvailable,
      USAGE_WORDS.notAvailable,
      "$3.75",
    ]);
    expect(taskNote(whole, "usd")).toBe("No estimate here is split by category.");
    // One of two records priced and split.
    const partial = recent({
      amount: { ...recent().amount, cost: 1, priced: 1, split: 1 },
      costReported: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    expect(values(partial, "usd")[4]).toEqual(["Total", "$1.00", "1 of 2 records priced"]);
    expect(taskNote(partial, "usd")).toBe("The total leaves out unpriced activity.");
    const unpriced = recent({ amount: { ...recent().amount, cost: null, priced: 0, split: 0 } });
    expect(values(unpriced, "usd")[4]?.[1]).toBe(USAGE_WORDS.notAvailable);
    expect(taskNote(unpriced, "usd")).toBe(
      "No record of this task has a price, so it has no estimate.",
    );
  });

  it("names when a task was created and how many of the matching tasks it shows", () => {
    expect(createdWords(new Date(2026, 9, 5, 15, 12).getTime())).toBe("Created Oct 5, 3:12 PM");
    expect(taskCount(10, 23)).toBe("Showing 10 of 23 tasks");
    expect(taskCount(23, 23)).toBe("All 23 tasks shown");
    expect(taskCount(1, 1)).toBe("1 task shown");
  });
});

describe("Usage's milestones", () => {
  it("counts finished work toward 1, 10, 25 and 50, and keeps the last reached after 50", () => {
    expect(milestoneWords(0).title).toBe("No tasks finished yet · First milestone at 1");
    expect(milestoneWords(1).title).toBe("1 task finished · Next milestone at 10");
    expect(milestoneWords(18).title).toBe("18 tasks finished · Next milestone at 25");
    expect(milestoneWords(62).title).toBe("62 tasks finished · Reached 50");
    expect(milestoneWords(18).note).toMatch(/not more tokens/);
  });
});

describe("token coverage disclosure", () => {
  it("says the total covers reported categories only when some categories were not reported", () => {
    const partial = amount(42, 1);
    partial.tokenReported = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const view = summary({ total: partial });
    expect(readouts(view, "tokens")[0]?.note).toBe("Reported categories only");
    expect(tokenCategoryCoverage(partial, "cacheRead")).toBe("0 of 1 records");
  });
  it("discloses absent coverage and no reported tokens without claiming totals are available", () => {
    const missing = { ...amount(0, 1), tokenReported: undefined };
    expect(tokenCategoryCoverage(missing, "input")).toBe("Coverage not available");
    const none = { ...EMPTY_USAGE_AMOUNT, records: 1, cost: 1, priced: 1 };
    expect(readouts(summary({ total: none }), "tokens")[0]?.value).toBe(USAGE_WORDS.notAvailable);
  });
});

// INF-1430 piece 1: retrieval takes explanations too, and every saved
// retrieval task - past lookups included - reads under the new name.
it("calls the saved retrieval kind Lookups and explanations without renaming research", () => {
  expect(kindWords("retrieval")).toBe("Lookups and explanations");
  expect(kindWords("research")).toBe("Research");
  expect(kindWords(null)).toBe("Other task work");
});
