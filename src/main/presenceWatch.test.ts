import type { Presence } from "@shared/channels/shell";
import { describe, expect, it } from "vitest";
import { DISPLAY_STATUS_GUID, displayOff, PresenceWatch } from "./presenceWatch";

// INF-5528's answer: the music resumes once someone is back, which on a
// computer that asks for a password is the unlock, not the screen waking.
describe("PresenceWatch", () => {
  it("stays away while any reason lasts and tells only when that changes", () => {
    const watch = new PresenceWatch(true);
    const heard: Presence[] = [];
    watch.listen((presence) => heard.push(presence));
    watch.set("screen-off", true);
    watch.set("locked", true);
    watch.set("screen-off", false);
    expect(watch.presence()).toEqual({ away: true, watched: true });
    watch.set("locked", false);
    expect(heard).toEqual([
      { away: true, watched: true },
      { away: false, watched: true },
    ]);
  });
});

/** A `POWERBROADCAST_SETTING` as Windows lays it out: GUID, DWORD length, DWORD data. */
function setting(guid: Buffer, data: number): Buffer {
  const bytes = Buffer.alloc(24);
  guid.copy(bytes, 0);
  bytes.writeUInt32LE(4, 16);
  bytes.writeUInt32LE(data, 20);
  return bytes;
}

// GUID_SESSION_DISPLAY_STATUS's data: 0 off, 1 on, 2 dimmed (Microsoft's
// power setting GUIDs); a dimmed screen still shows, so nobody left.
describe("displayOff", () => {
  it("reads the display's state and ignores any other setting", () => {
    expect(displayOff(setting(DISPLAY_STATUS_GUID, 0))).toBe(true);
    expect(displayOff(setting(DISPLAY_STATUS_GUID, 1))).toBe(false);
    expect(displayOff(setting(DISPLAY_STATUS_GUID, 2))).toBe(false);
    expect(displayOff(setting(Buffer.alloc(16), 0))).toBeNull();
  });
});
