import { describe, expect, it } from "vitest";
import { ciFactOf, ciFactWords } from "./ciFact";

describe("the recorded CI reading the Firstmate reads", () => {
  it("reports actual failures without a separate readiness verdict (INF-1555 F12)", () => {
    const fact = ciFactOf(
      {
        mode: "direct-pr",
        ci: "red",
        ciAt: 0,
        headSha: "pr604-version",
        checks: {
          headSha: "pr604-version",
          absenceDeclared: false,
          items: [{ name: "unit-tests", state: "failure" }],
        },
      },
      0,
    )!;
    expect(fact).toMatchObject({ overall: "red", checksWords: "failed" });
    expect(ciFactWords(fact)).toContain("recorded checks: failed");
    expect(fact).not.toHaveProperty("crewVerdict");
    expect(ciFactWords(fact)).not.toContain("Crew verdict:");
  });

  const now = Date.UTC(2026, 9, 9, 12, 0, 0);

  it("carries the overall, when, how old and the head the reading saw", () => {
    const fact = ciFactOf(
      { mode: "direct-pr", ci: "green", ciAt: now - 3 * 60_000, headSha: "abcdef1234567" },
      now,
    );
    expect(fact).toEqual({
      overall: "green",
      readAt: "2026-10-09T11:57:00.000Z",
      ageMinutes: 3,
      head: "abcdef1234567",
    });
    expect(fact && ciFactWords(fact)).toBe(
      " The app's recorded checks: green (read 3 min ago, head abcdef1); a merge rechecks them fresh.",
    );
  });

  it("says nothing before any reading is recorded, and never a negative age", () => {
    expect(ciFactOf(undefined, now)).toBeUndefined();
    expect(ciFactOf({ mode: "direct-pr" }, now)).toBeUndefined();
    expect(ciFactOf({ mode: "direct-pr", ci: "pending" }, now)).toBeUndefined();
    expect(ciFactOf({ mode: "direct-pr", ci: "red", ciAt: now + 60_000 }, now)).toMatchObject({
      overall: "red",
      ageMinutes: 0,
    });
  });
});
