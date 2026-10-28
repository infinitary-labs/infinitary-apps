import { describe, expect, it } from "vitest";
import { composeDelivery, splitDelivery } from "./taskDeliveryFields";

// Captain INF-1555 F12: an offer carries readiness; the old current cache is not authority or history.
describe("legacy separate readiness cache", () => {
  it("ignores only the current cache while retaining raw checks and append-only declarations", () => {
    const headSha = "93355db9d04e964513879db74d068a7789cb4c16";
    const declarations = [
      {
        headSha,
        verdict: "ready",
        evidence: "The earlier crew read this version's checks.",
        at: 1,
      },
    ];
    const checks = {
      headSha,
      items: [{ name: "unit-tests", state: "success" }],
      complete: true,
      absenceDeclared: false,
    };
    const saved = splitDelivery({
      mode: "direct-pr",
      headSha,
      checks,
      crewVerdict: "ready",
      ciRepair: { failures: [], diagnoses: [], repairs: [], declarations },
    });
    const live = composeDelivery(
      saved.history,
      saved.evidence ?? undefined,
      saved.permissions ?? undefined,
    );
    expect(live).not.toHaveProperty("crewVerdict");
    expect(live).toMatchObject({ headSha, checks, ciRepair: { declarations } });
    expect(live).not.toHaveProperty("mergeAuthorization");
    // Reading the old row does not rewrite its bytes or erase its declaration history.
    expect(JSON.parse(saved.evidence!.evidence_json!)).toMatchObject({ crewVerdict: "ready" });
  });
});
