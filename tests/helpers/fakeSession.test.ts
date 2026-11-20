import { describe, expect, it } from "vitest";
import { admits } from "../../src/core/session/session";
import { FAKE_CONTROL_PROFILE } from "./fakeSession";

describe("admits", () => {
  it("admits a role that needs nothing, and a steer need only on a backend that steers that way", () => {
    const queued = { ...FAKE_CONTROL_PROFILE, steer: "followup-queue" as const };

    expect(admits(queued, undefined)).toBe(true);
    expect(admits(FAKE_CONTROL_PROFILE, { steer: "native" })).toBe(true);
    expect(admits(queued, { steer: "native" })).toBe(false);
  });
});
