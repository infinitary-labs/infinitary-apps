import { describe, expect, it } from "vitest";
import { crewHoldWays, premiumRetryPossible } from "./holds";

describe("blocked crew decision ways", () => {
  it("offers one premium retry for eligible lineages alongside the other ways", () => {
    for (const task of [
      undefined,
      { difficulty: "medium" as const },
      {
        difficulty: "high" as const,
        shape: { escalation: { attempt: 1 } },
      },
    ]) {
      const ways = crewHoldWays("attempt", task);
      expect(ways.map((way) => way.label)).toEqual([
        "Retry with the captain's guidance",
        "Try a premium model",
        "Discard the work",
      ]);
      expect(ways[1]?.args).toEqual({ shape: { escalate_from: "attempt", premium_ask: true } });
    }
  });

  it("keeps exactly the stronger-model way when premium has no available quota", () => {
    const ways = crewHoldWays("attempt", { difficulty: "medium" }, true, false);
    expect(ways.map((way) => way.label)).toEqual([
      "Retry with the captain's guidance",
      "Try a stronger model",
      "Discard the work",
    ]);
    expect(ways[1]?.args).toEqual({ shape: { escalate_from: "attempt" } });
    expect(ways.filter((way) => way.tool === "spawn_crewmate")).toHaveLength(1);
  });

  it("withholds both model ways when the previous attempt is premium or the lineage spent two rounds", () => {
    for (const task of [
      { difficulty: "premium" as const },
      { difficulty: "medium" as const, shape: { escalation: { attempt: 2 } } },
    ]) {
      expect(premiumRetryPossible(task)).toBe(false);
      expect(crewHoldWays("attempt", task).map((way) => way.label)).toEqual([
        "Retry with the captain's guidance",
        "Discard the work",
      ]);
    }
  });
});
