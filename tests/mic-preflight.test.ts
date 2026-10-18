import { describe, expect, it } from "vitest";
import { micPreflightFailure } from "./e2e/micPreflight";

// INF-391: the lane's voice journeys failed one by one after 15 s each
// because the fake microphone never opened; the run now stops first.
describe("micPreflightFailure", () => {
  it("passes a microphone that opened", () => {
    expect(micPreflightFailure("opened")).toBeNull();
  });
  it.each(["no-answer", "refused"] as const)("stops the run on a microphone that %s", (probe) => {
    const message = micPreflightFailure(probe);
    expect(message).toContain(probe);
    expect(message).toContain("kTCCServiceMicrophone");
  });
});
