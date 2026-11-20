import { describe, expect, it } from "vitest";
import { type CenterNode, centerCues } from "./dependencyVisual";

/**
 * INF-38 (recovered from FI3-1823's diagnosis): FI3-1788 was started and
 * idle on its one blocker FI3-1822, yet kept its slot because queued
 * FI3-1789 waited on it. Queued work has no crewmate, so it makes no chain.
 */
describe("centerCues", () => {
  const node = (
    key: string,
    blockedBy: string[],
    fields: Partial<CenterNode> = {},
  ): CenterNode => ({
    id: key,
    key,
    blockedBy,
    deviceId: null,
    idleDependency: false,
    crewed: true,
    ...fields,
  });
  const blocker = node("FI3-1822", []);
  const waiter = node("FI3-1788", ["FI3-1822"], { idleDependency: true });
  const modeOf = (nodes: CenterNode[]) =>
    centerCues(nodes).find((cue) => cue.waiterId === "FI3-1788")?.mode ?? null;

  it("circles the blocker although queued work waits on the waiter", () => {
    const queued = node("FI3-1789", ["FI3-1788"], { crewed: false });
    expect(centerCues([blocker, waiter, queued])).toEqual([
      {
        waiterId: "FI3-1788",
        mode: "satellite",
        blockerId: "FI3-1822",
        index: 0,
        count: 1,
        arrows: ["FI3-1822"],
      },
    ]);
  });

  it("keeps its slot when a started crewmate waits on the waiter", () => {
    const started = node("FI3-1789", ["FI3-1788"]);
    expect(modeOf([blocker, waiter, started])).toBe("tether");
  });

  it("keeps its slot while the waiter still works", () => {
    const queued = node("FI3-1789", ["FI3-1788"], { crewed: false });
    expect(modeOf([blocker, { ...waiter, idleDependency: false }, queued])).toBe("tether");
  });
});
