import { describe, expect, it } from "vitest";
import { type EffectiveTaskPolicies, policyEditConsequences } from "./taskPolicies";

/** INF-416 piece H: the host's policy consequences are said only when that edit applies. */
const now = (autonomy: boolean, rigor: EffectiveTaskPolicies["rigor"]["value"]) => ({
  autonomy: { value: autonomy, source: "task" as const },
  rigor: { value: rigor, source: "task" as const, requested: rigor },
});

describe("policy edit consequences (INF-416 piece H)", () => {
  it("names an ask-first cancel only when merging was set to ask first", () => {
    const text = policyEditConsequences({
      edits: { autonomy: false },
      now: now(false, "standard"),
      before: now(true, "standard"),
      mergeSent: false,
    });
    expect(text).toContain("Asks first cancels unsent merges.");
    expect(text).not.toContain("Self-merging rechecks");
    expect(text).not.toContain("destination change");
    expect(text).toContain("Queued work stays queued");
    expect(text).not.toContain("merge already sent");
  });

  it("names a cancelled approval only when the destination changed", () => {
    const text = policyEditConsequences({
      edits: { delivery: "local-only" },
      now: now(false, "standard"),
      before: now(false, "standard"),
      mergeSent: false,
    });
    expect(text).toContain("A destination change cancels the old approval.");
    expect(text).not.toContain("Asks first cancels");
    expect(text).not.toContain("Higher rigor");
  });

  it("names the self-merging recheck only when merging was turned on", () => {
    const text = policyEditConsequences({
      edits: { autonomy: true },
      now: now(true, "standard"),
      before: now(false, "standard"),
      mergeSent: true,
    });
    expect(text).toContain("Self-merging rechecks requirements.");
    expect(text).toContain("merge already sent");
    expect(text).not.toContain("Asks first cancels");
    expect(text).not.toContain("Queued work stays queued");
  });

  it("names higher or lower rigor only when rigor moved that way", () => {
    const higher = policyEditConsequences({
      edits: { rigor: "reviewed" },
      now: now(false, "reviewed"),
      before: now(false, "standard"),
      mergeSent: false,
    });
    expect(higher).toContain("Higher rigor requires missing validation or review");
    expect(higher).not.toContain("A lower rigor");
    const lower = policyEditConsequences({
      edits: { rigor: "quick" },
      now: now(false, "quick"),
      before: now(false, "reviewed"),
      mergeSent: false,
    });
    expect(lower).toContain("A lower rigor removes only policy-owned requirements");
    expect(lower).not.toContain("Higher rigor");
    const same = policyEditConsequences({
      edits: { rigor: "standard" },
      now: now(false, "standard"),
      before: now(false, "standard"),
      mergeSent: false,
    });
    expect(same).not.toContain("Higher rigor");
    expect(same).not.toContain("A lower rigor");
  });

  it("does not guess a care direction when the earlier care is unknown", () => {
    const text = policyEditConsequences({
      edits: { rigor: "reviewed" },
      now: now(false, "reviewed"),
      mergeSent: false,
    });
    expect(text).not.toContain("Higher rigor");
    expect(text).not.toContain("A lower rigor");
    expect(text).toContain("Published work, evidence and the pull request stay.");
  });
});
