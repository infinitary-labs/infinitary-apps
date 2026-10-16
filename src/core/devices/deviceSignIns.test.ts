import type { DeviceSsh, DeviceView } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { DeviceSignIns } from "./deviceSignIns";

/**
 * Every surface that draws a computer out of reach says "connecting" for one
 * whose connection is being made (captain, INF-49); the sign-ins view carries
 * it to Subscriptions, Projects' Runs on and the device forge rows.
 */

const MINI: DeviceView = { id: "mini", kind: "work", name: "Mac mini", pairedAt: 1 };

function view(inReach: boolean, ssh: DeviceSsh | undefined) {
  const signIns = new DeviceSignIns({
    devices: () => [MINI],
    work: {
      ask: async () => {
        throw new Error("not asked");
      },
      onWorkDevice: () => () => {},
      inReach: () => inReach,
      version: () => undefined,
    },
    emit: () => {},
    broadcastEvent: () => {},
    ssh: () => ssh,
  });
  const [only] = signIns.view();
  signIns.dispose();
  return only;
}

describe("a computer's sign-ins view", () => {
  it("says connecting only for a computer out of reach whose connection is being made", () => {
    expect(view(false, { state: "connecting" })).toMatchObject({
      inReach: false,
      connecting: true,
    });
    for (const state of ["reconnecting", "at-login", "not-started", "stopped"] as const)
      expect(view(false, { state })?.connecting).toBeUndefined();
    expect(view(false, undefined)?.connecting).toBeUndefined();
    expect(view(true, { state: "connecting" })?.connecting).toBeUndefined();
  });
});
