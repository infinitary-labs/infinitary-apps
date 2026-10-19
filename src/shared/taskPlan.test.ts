import { describe, expect, it } from "vitest";
import {
  clipPlanLine,
  foldPlan,
  PLAN_FOLD_PAST,
  PLAN_LINE_MAX,
  type PlanItem,
  planCounts,
  readPlanItems,
} from "./taskPlan";

const item = (label: string, state: PlanItem["state"]): PlanItem => ({
  label,
  short: label.slice(0, 12),
  state,
});

describe("a crewmate's plan (FI3-734)", () => {
  it("reads the list as declared, tidying the words and refusing only what no surface could draw", () => {
    expect(
      readPlanItems([{ label: "  Reproduce  the failure ", short: "Repro ", state: "done" }]),
    ).toEqual({ items: [{ label: "Reproduce the failure", short: "Repro", state: "done" }] });
    // INF-484 move 5, from E16's 64 refused notes: a long plan with long words
    // is kept whole, every word and every item, for the surfaces to cut.
    const long = Array.from({ length: 15 }, (_, i) => ({
      label: `Confirm every merged change since the last alpha has a release note, part ${i}`,
      short: `Notes ledger ${i}`,
      state: "next",
    }));
    expect(readPlanItems(long)).toEqual({ items: long });
    expect(readPlanItems([{ label: "x", short: "x", state: "soon" }])).toMatchObject({
      refusal: expect.stringContaining("plan[0][state]"),
    });
    expect(readPlanItems([{ label: "", short: "x", state: "next" }])).toMatchObject({
      refusal: expect.stringContaining("plan[0][label]"),
    });
    expect(readPlanItems([])).toMatchObject({ refusal: expect.any(String) });
    expect(readPlanItems("soon")).toMatchObject({ refusal: expect.any(String) });
  });

  it("counts done against the items that count, and names the first current one", () => {
    expect(
      planCounts([
        item("a", "done"),
        item("b", "skipped"),
        item("c", "done"),
        item("d", "current"),
        item("e", "next"),
      ]),
    ).toEqual({ done: 2, total: 4, skipped: 1, current: item("d", "current") });
    expect(planCounts([item("a", "done")])).toEqual({
      done: 1,
      total: 1,
      skipped: 0,
      current: null,
    });
  });

  it("folds the finished items before the newest finished one, only past the fold and only when two or more", () => {
    const short = Array.from({ length: PLAN_FOLD_PAST }, (_, i) =>
      item(`Item ${i}`, i < 5 ? "done" : "next"),
    );
    expect(foldPlan(short)).toBeNull();
    const long = [
      ...Array.from({ length: 6 }, (_, i) => item(`Done ${i}`, "done")),
      item("Skipped", "skipped"),
      item("Last done", "done"),
      item("Current", "current"),
      item("Next", "next"),
    ];
    const fold = foldPlan(long);
    expect(fold?.folded.map((it) => it.label)).toEqual([
      "Done 0",
      "Done 1",
      "Done 2",
      "Done 3",
      "Done 4",
      "Done 5",
    ]);
    expect(fold?.rest.map((it) => it.label)).toEqual(["Skipped", "Last done", "Current", "Next"]);
    // One finished item before the newest would fold nothing worth folding.
    const barely = [
      item("First", "done"),
      item("Second", "done"),
      ...Array.from({ length: 8 }, (_, i) => item(`Next ${i}`, "next")),
    ];
    expect(foldPlan(barely)).toBeNull();
  });

  it("cuts the summary's line past its dots, folding the items after the current one and keeping the current dot", () => {
    const plan = (count: number, current: number) =>
      Array.from({ length: count }, (_, i) =>
        item(`Item ${i}`, i < current ? "done" : i === current ? "current" : "next"),
      );
    expect(clipPlanLine(plan(PLAN_LINE_MAX, 2))).toBeNull();
    expect(clipPlanLine(plan(PLAN_LINE_MAX + 1, 2))?.later).toHaveLength(2);
    // A current item at the line's end leaves one item to fold, which would
    // take a dot of its own: nothing gained.
    expect(clipPlanLine(plan(PLAN_LINE_MAX + 1, PLAN_LINE_MAX - 1))).toBeNull();
    const clipped = clipPlanLine(plan(15, 2));
    expect(clipped?.shown.map((it) => it.label)).toEqual(
      Array.from({ length: PLAN_LINE_MAX - 1 }, (_, i) => `Item ${i}`),
    );
    expect(clipped?.later.map((it) => it.label)).toEqual([
      "Item 11",
      "Item 12",
      "Item 13",
      "Item 14",
    ]);
    // A current item past the line keeps its dot; only what follows it folds.
    const late = clipPlanLine(plan(20, 14));
    expect(late?.shown.at(-1)?.label).toBe("Item 14");
    expect(late?.later.map((it) => it.label)).toEqual([
      "Item 15",
      "Item 16",
      "Item 17",
      "Item 18",
      "Item 19",
    ]);
  });
});
