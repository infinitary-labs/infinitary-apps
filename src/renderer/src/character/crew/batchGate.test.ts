import { BATCH_GATE } from "@shared/batchGate";
import { expect, it } from "vitest";
import { crewWaitOf } from "./crewSignal";
import { CrewOrbit } from "./orbit";

// Approved batch gate: bank the same real orbit model used by boot and task changes.
// Its frames, not elapsed wall time, own the exact turn and Reduced Motion behavior.
it("turns only an active batch at the approved rate and leaves reduced motion still", () => {
  for (const batch of ["waiting", "in-batch", "paused"] as const) {
    const model = new CrewOrbit(0);
    model.spawn(
      "publish-map",
      "working",
      0,
      true,
      "high",
      crewWaitOf({ state: "active", reason: "checks", batch }),
    );
    const first = model.update(0).crew[0];
    const later = model.update(1000).crew[0];
    expect(first).toMatchObject({ wait: 1, work: 0, batch: true });
    expect(first?.waitArc).toBeUndefined();
    expect((later?.batchTurn ?? 0) - (first?.batchTurn ?? 0)).toBeCloseTo(
      batch === "in-batch" ? BATCH_GATE.turnRadPerS : 0,
      6,
    );
    expect(model.update(2000, true).crew[0]?.batchTurn).toBe(0);
    model.setWait("publish-map", "checks");
    expect(model.update(2016).crew[0]?.batch).toBeUndefined();
    expect(model.update(2032).crew[0]?.waitArc).toBeDefined();
  }
});
