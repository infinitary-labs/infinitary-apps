import { describe, expect, it } from "vitest";
import { classifyInboxBatch, classifyWake, stampOrigin } from "./origin";

describe("stampOrigin", () => {
  it("keeps the closed set and defaults unknown to agent", () => {
    expect(stampOrigin("captain-turn")).toBe("captain-turn");
    expect(stampOrigin("agent")).toBe("agent");
    expect(stampOrigin("crewmate-report:ab12")).toBe("crewmate-report:ab12");
    expect(stampOrigin("owner")).toBe("agent");
    expect(stampOrigin("captain")).toBe("agent");
  });
});

describe("classifyWake", () => {
  it("stamps a captain row as a captain turn", () => {
    expect(classifyWake({ origin: "captain", ref: "captain-turn" })).toEqual({
      origin: "captain-turn",
      canCreate: true,
      kind: "captain",
    });
  });

  it("refuses creates on scheduled and supervision wakes", () => {
    expect(classifyWake({ origin: "scheduled", ref: null })).toEqual({
      origin: "agent",
      canCreate: false,
      kind: "scheduled",
    });
    expect(classifyWake({ origin: "supervision", ref: "ab12" })).toEqual({
      origin: "agent",
      canCreate: false,
      kind: "supervision",
    });
  });

  it("stamps a crewmate report with the task its row names", () => {
    expect(classifyWake({ origin: "crewmate-report", ref: "ab12" })).toEqual({
      origin: "crewmate-report:ab12",
      canCreate: true,
      kind: "crewmate-report",
    });
  });

  it("never trusts a crewmate report whose ref is not a task id", () => {
    for (const ref of [null, "", "Not A Task"]) {
      expect(classifyWake({ origin: "crewmate-report", ref })).toEqual({
        origin: "agent",
        canCreate: true,
        kind: "agent",
      });
    }
  });

  it("treats other ops, and an unstamped row, as agent-derived and creatable", () => {
    for (const origin of ["agent", null] as const) {
      expect(classifyWake({ origin, ref: null })).toEqual({
        origin: "agent",
        canCreate: true,
        kind: "agent",
      });
    }
  });
});

describe("classifyInboxBatch", () => {
  it("keeps the least trusted origin and ANDs the create gate", () => {
    const mixed = classifyInboxBatch([
      { origin: "crewmate-report", ref: "ab12" },
      { origin: "scheduled", ref: null },
    ]);
    expect(mixed.origin).toBe("agent");
    expect(mixed.canCreate).toBe(false);
    expect(mixed.kind).toBe("scheduled");
  });

  it("does not let a parked captain turn lift a crewmate report's trust", () => {
    expect(
      classifyInboxBatch([
        { origin: "captain", ref: "captain-turn" },
        { origin: "crewmate-report", ref: "ab12" },
      ]),
    ).toEqual({ origin: "crewmate-report:ab12", canCreate: true, kind: "crewmate-report" });
  });

  it("fail-closes an empty batch", () => {
    expect(classifyInboxBatch([])).toEqual({
      origin: "agent",
      canCreate: false,
      kind: "agent",
    });
  });
});
