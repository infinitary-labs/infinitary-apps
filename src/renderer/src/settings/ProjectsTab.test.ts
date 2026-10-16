import { describe, expect, it } from "vitest";
import { drainPendingPolicy } from "./ProjectsTab";

describe("drainPendingPolicy", () => {
  it("sends every queued patch and empties the map", async () => {
    const pending = new Map([
      ["r1", { autonomy: true }],
      ["r2", { delivery: "direct-pr" as const }],
    ]);
    const calls: Array<[string, { autonomy?: boolean; delivery?: string }]> = [];
    await drainPendingPolicy(pending, async (id, changes) => {
      calls.push([id, changes]);
    });
    expect(pending.size).toBe(0);
    expect(calls).toEqual([
      ["r1", { autonomy: true }],
      ["r2", { delivery: "direct-pr" }],
    ]);
  });

  it("swallows a configure rejection so unmount cannot throw", async () => {
    const pending = new Map([["r1", { autonomy: true }]]);
    await expect(
      drainPendingPolicy(pending, async () => {
        throw new Error("could not change repository policy");
      }),
    ).resolves.toBeUndefined();
    expect(pending.size).toBe(0);
  });
});
