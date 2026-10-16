import { describe, expect, it } from "vitest";
import {
  foldPlan,
  PLAN_FOLD_PAST,
  PLAN_ITEMS_MAX,
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
  it("reads the list as declared, tidying the words and refusing what no surface could show", () => {
    expect(
      readPlanItems([{ label: "  Reproduce  the failure ", short: "Repro ", state: "done" }]),
    ).toEqual({ items: [{ label: "Reproduce the failure", short: "Repro", state: "done" }] });
    const long = Array.from({ length: PLAN_ITEMS_MAX + 1 }, (_, i) => item(`Item ${i}`, "next"));
    expect(readPlanItems(long)).toMatchObject({ refusal: expect.stringContaining("at most 12") });
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
});
