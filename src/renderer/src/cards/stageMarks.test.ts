import { describe, expect, it } from "vitest";
import { markStage, STAGE_MARKS_KEPT, stageOutcome } from "./stageMarks";

const card = (id: string, extra: { held?: boolean } = {}) => ({
  id,
  held: false,
  ...extra,
});

describe("a selection's outcome (FI3-871)", () => {
  const prepared = { successor: { id: "b", unprepared: null }, warm: "b" };

  it("is a hit when the prepared page of the selected card drew its current document", () => {
    expect(stageOutcome(card("b"), prepared, "current", true)).toBe("hit");
  });

  it("names how far the prepared page of the selected card got", () => {
    expect(stageOutcome(card("b"), prepared, "none", true)).toBe("not-drawn");
    expect(stageOutcome(card("b"), prepared, "stale", true)).toBe("stale");
    expect(stageOutcome(card("b"), prepared, "failed", true)).toBe("mount-failed");
  });

  it("names a different prepared card, and nothing coming next", () => {
    expect(stageOutcome(card("c"), prepared, "none", true)).toBe("other-card");
    expect(stageOutcome(null, prepared, "none", true)).toBe("none");
  });

  it("names what the selected entry is before what was prepared", () => {
    expect(stageOutcome(card("b", { held: true }), prepared, "current", true)).toBe("held-view");
  });

  it("names why the successor it brought up was not prepared", () => {
    for (const unprepared of ["thread-pending", "in-place", "slot-busy"] as const) {
      const facts = { successor: { id: "b", unprepared }, warm: null };
      expect(stageOutcome(card("b"), facts, "none", true)).toBe(unprepared);
    }
    const hidden = { successor: { id: "b", unprepared: "window-hidden" as const }, warm: null };
    expect(stageOutcome(card("c"), hidden, "none", false)).toBe("window-hidden");
  });
});

describe("the stage's timing marks", () => {
  it("stay bounded: past the selections kept, the marks start over", () => {
    performance.clearMarks();
    for (let n = 0; n <= STAGE_MARKS_KEPT; n++) {
      markStage("select", { card: `c${n}`, outcome: "hit" });
      markStage("visible", { slot: `c${n}#0` });
    }
    const selects = performance.getEntriesByName("stage:select") as PerformanceMark[];
    expect(selects.length).toBeLessThanOrEqual(STAGE_MARKS_KEPT);
    expect(selects.at(-1)?.detail).toEqual({ card: `c${STAGE_MARKS_KEPT}`, outcome: "hit" });
    expect(performance.getEntriesByName("stage:visible").length).toBeLessThanOrEqual(
      STAGE_MARKS_KEPT,
    );
  });
});
