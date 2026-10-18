import { describe, expect, it } from "vitest";
import { type PlacementSnapshot, placementCandidateLines } from "./placement";

/**
 * A saved placement keeps its rejection and the core reach reading, so
 * its words distinguish connecting from out of reach (INF-49; INF-416 L).
 */
describe("a candidate's saved verdict", () => {
  const candidate = (over: Record<string, unknown>) => ({
    computerId: "mini",
    name: "Mac mini",
    physicalComputerId: null,
    rejections: ["out-of-reach"],
    missingTools: [],
    reading: { status: "unknown", reason: "out-of-reach" },
    factsAgeMs: null,
    capacity: null,
    reserved: { cpu: 0, memoryBytes: 0 },
    remaining: null,
    model: null,
    preferenceRank: null,
    ...over,
  });
  const lines = (over: Record<string, unknown>) =>
    placementCandidateLines({
      computerId: "other",
      candidateCount: 1,
      candidates: [candidate(over)],
    } as unknown as PlacementSnapshot);

  it("says connecting for a computer whose connection was being made, and out of reach otherwise", () => {
    expect(lines({ reach: "connecting" })[0]).toContain("Mac mini: connecting.");
    expect(lines({})[0]).toContain("Mac mini: out of reach.");
  });
});
