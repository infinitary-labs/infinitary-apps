import { describe, expect, it } from "vitest";
import { micPreflightAsked, micPreflightFailure } from "./e2e/micPreflight";

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

// INF-726: tests/run-evidence-playwright.test.ts's fixture runs open no
// microphone, yet in a virtual Mac the check booted Electron before their
// first spec, past that test's wait on a slow guest; they now turn it off.
describe("micPreflightAsked", () => {
  it("checks in a virtual Mac unless the run turned the check off", () => {
    expect(micPreflightAsked(undefined, true)).toBe(true);
    expect(micPreflightAsked("0", true)).toBe(false);
  });
});
