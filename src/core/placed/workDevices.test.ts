import { describe, expect, it } from "vitest";
import { type WorkDeviceLink, WorkDevices } from "./workDevices";

/** A connection that keeps what it is told to hold. */
function link(held: (string | null)[]): WorkDeviceLink {
  return {
    ask: async () => {
      throw new Error("not asked here");
    },
    onWorkDevice: () => () => {},
    onViewDevice: () => () => {},
    hold: (why) => {
      held.push(why);
    },
  };
}

describe("the hold a moving first mate puts on its connection", () => {
  // A home that stopped mid-move and launched again holds before its
  // connection starts (docs/devices.md, "The stop").
  it("holds a connection attached after the hold from its start, and lets it go on null", () => {
    const devices = new WorkDevices();
    devices.hold("Your first mate is moving to Mac mini. Try again once it has.");
    const held: (string | null)[] = [];
    devices.attach(link(held));
    expect(held).toEqual(["Your first mate is moving to Mac mini. Try again once it has."]);
    devices.hold(null);
    const later: (string | null)[] = [];
    devices.attach(link(later));
    expect(held.at(-1)).toBeNull();
    expect(later).toEqual([]);
  });
});
