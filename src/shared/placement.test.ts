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

/** INF-1870: the record explains locality without inventing it on older snapshots. */
describe("a basis-influenced placement explanation", () => {
  it("uses the recorded basis only, and leaves historical explanations unchanged", async () => {
    const { placementReason } = await import("./placement");
    const old = { computerName: "Mac mini" };
    expect(placementReason(old)).toBe(
      "Automatic chose Mac mini: it can run this project and had room to start.",
    );
    expect(
      placementReason({
        ...old,
        basis: { taskId: "plan", taskKey: "INF-1870", computerId: "mini" },
      }),
    ).toBe(
      `${placementReason(old)} This kept the task beside its basis, INF-1870, without changing model preference.`,
    );
  });
});
