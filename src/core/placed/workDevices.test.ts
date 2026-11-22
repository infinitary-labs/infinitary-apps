import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { WorkDeviceContact, WorkDeviceVersion } from "../connection/connection";
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

describe("a computer welcomed before the connection is attached", () => {
  // The home attaches its connection only once its window opened (src/main/shell.ts);
  // a computer that reconnected meanwhile read in reach on its own side while the
  // home's Devices row said out of reach and every part refused it orders.
  it("is in reach with its version, takes orders, and still goes, once attached", async () => {
    const at = await home();
    const workGrant = await at.join("work", "Mac mini");
    const viewGrant = await at.join("view", "MacBook Pro");
    const work = await connectClient(workGrant, { appVersion: "0.1.30", answer: () => [] });
    const view = await connectClient(viewGrant);
    const devices = new WorkDevices();
    const heard: { contact: WorkDeviceContact; version: WorkDeviceVersion | undefined }[] = [];
    devices.onWorkDevice((contact) =>
      heard.push({ contact, version: devices.version(contact.deviceId) }),
    );
    // What listens for versions hears it too: the one way a hold for that
    // computer's app update learns it is installed (INF-5578).
    const versions: [string, WorkDeviceVersion | null][] = [];
    devices.onVersion((deviceId, reported) => versions.push([deviceId, reported]));
    devices.attach(at.connection);
    const version = { contract: PROTOCOL_VERSION, app: "0.1.30", takesWork: true };
    expect(versions).toEqual([[workGrant.deviceId, version]]);
    // Heard as its welcome tells it: its version first, then in reach.
    expect(heard).toEqual([
      { contact: { deviceId: workGrant.deviceId, contact: "in-reach" }, version },
    ]);
    expect(devices.inReach(workGrant.deviceId)).toBe(true);
    expect(devices.controlling(viewGrant.deviceId)).toBe(true);
    await expect(devices.ask(workGrant.deviceId, "inf:session:roster", [])).resolves.toEqual([]);
    await work.close();
    await view.close();
    await expect.poll(() => devices.inReach(workGrant.deviceId)).toBe(false);
    await expect.poll(() => devices.controlling(viewGrant.deviceId)).toBe(false);
    expect(devices.version(workGrant.deviceId)).toBeUndefined();
  });
});
