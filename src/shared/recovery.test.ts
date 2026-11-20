import { describe, expect, it } from "vitest";
import { keptRecoveryWaySchema, recoveryWay, recoveryWaySchema, waitStall } from "./recovery";

// INF-1540's approved B/C: classify facts, not the words "blocked" or "wait".
describe("recovery facts", () => {
  const wait = {
    owner: "INF-1539",
    end: "The fresh task starts on the inherited branch",
    observation: "The host fix is merged but absent from the installed app",
    cheapestWay: "Start the takeover with branch_from",
  };
  it("detects missing ownership, missing end and repeated unchanged facts", () => {
    expect(waitStall({ ...wait, owner: undefined })?.kind).toBe("wait-without-owner");
    expect(waitStall({ ...wait, end: undefined })?.kind).toBe("wait-without-end");
    expect(waitStall(wait)).toBeUndefined();
    expect(waitStall(wait, wait)?.kind).toBe("repeated-wait");
    expect(waitStall({ ...wait, observation: "INF-1539 started" }, wait)).toBeUndefined();
  });
  it("marks moves from their hold basis, keeping sign-in captain-owned", () => {
    const move = {
      action: "Take the named way",
      approach: "workaround" as const,
      evidence: "The owner exposes this operation",
      nextFact: "Read the operation result",
    };
    expect(recoveryWay({ ...move, hold: "waits" })).toMatchObject({
      basis: "record",
      needsConsent: false,
    });
    expect(recoveryWay({ ...move, hold: "escalation" })).toMatchObject({
      basis: "made-up number",
      needsConsent: false,
    });
    expect(recoveryWay({ ...move, hold: "asks-first" })).toMatchObject({
      basis: "consent",
      needsConsent: true,
    });
    expect(recoveryWay({ ...move, hold: "sign-in" })).toMatchObject({
      basis: "outside fact",
      needsConsent: true,
    });
  });
  it("INF-1554 F7: passing a hold and choosing a stronger model stay captain-owned regardless of basis", () => {
    for (const approach of ["pass-hold", "stronger-model", undefined] as const) {
      for (const hold of ["waits", "checks", "escalation", "sign-in"] as const) {
        expect(
          recoveryWay({
            action: "Take the declared way",
            hold,
            approach,
            evidence: "The owner names this move",
            nextFact: "Read the outcome",
          }).needsConsent,
        ).toBe(true);
      }
    }
  });

  // Source: R6 of INF-1644, "rejects legitimate reports across the supported boundary".
  it("reads a hold or approach this build does not know as the captain's, never as a refusal", () => {
    // INF-1688 retired the repair limit; a same-major build from before it can still name it.
    const way = {
      action: "Push one more repair",
      approach: "workaround",
      hold: "repairs",
      evidence: "The checks failed on the same version",
      nextFact: "Read the next check result",
    };
    expect(recoveryWaySchema.safeParse(way).success).toBe(false);
    const kept = keptRecoveryWaySchema.parse(way);
    expect(recoveryWay(kept)).toEqual({ ...way, basis: undefined, needsConsent: true });
    expect(
      recoveryWay(keptRecoveryWaySchema.parse({ ...way, hold: "waits", approach: "reroute" })),
    ).toMatchObject({ basis: "record", approach: "reroute", needsConsent: true });
  });
});
