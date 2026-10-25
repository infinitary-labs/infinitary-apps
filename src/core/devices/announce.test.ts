import type { DeviceView } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { ANNOUNCE_SERVICE, dnsSdAnnounceArgs, HomeAnnouncement } from "./announce";
import { avahiAnnounceArgs } from "./avahi";
import type { DnsSdRun } from "./dnsSd";

/**
 * INF-64 piece 1: while a phone is on the list, this Mac announces itself
 * over Bonjour so the phone can find it again (docs/devices.md, "Announcing
 * to a phone"); INF-95: so does a Linux home, with Avahi. Against a stand-in
 * for dns-sd or avahi-publish in memory; never the system's own.
 */

const device = (kind: DeviceView["kind"], system?: DeviceView["system"]): DeviceView =>
  ({
    id: kind + (system ?? ""),
    kind,
    name: "X",
    pairedAt: 1,
    onThisMac: false,
    ...(system ? { system } : {}),
  }) as DeviceView;

function announcer(
  args: (name: string, port: number) => readonly string[] = dnsSdAnnounceArgs,
  name = "Kun’s Mac mini",
) {
  const started: string[][] = [];
  const stopped: number[] = [];
  const run: DnsSdRun = (args) => {
    started.push([...args]);
    const at = started.length - 1;
    return { stop: () => stopped.push(at) };
  };
  const announcement = new HomeAnnouncement({
    run,
    args,
    name: async () => name,
    port: 47623,
  });
  return { announcement, started, stopped };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("announcing to a phone", () => {
  // INF-64 piece 2: Nearby must find the first phone's Mac before that phone is paired.
  it("announces while a direct invitation is open, then stops unless a phone joined", async () => {
    const { announcement, started, stopped } = announcer();
    announcement.devicesChanged([], true);
    await settle();
    expect(started).toHaveLength(1);
    announcement.devicesChanged([], false);
    expect(stopped).toEqual([0]);
    announcement.devicesChanged([], true);
    await settle();
    announcement.devicesChanged([device("view", "ios")], false);
    expect(started).toHaveLength(2);
    expect(stopped).toEqual([0]);
    announcement.devicesChanged([], false);
    expect(stopped).toEqual([0, 1]);
    announcement.dispose();
  });

  it("announces under this Mac's name at the connection's port while a phone is on the list, and once", async () => {
    const { announcement, started } = announcer();
    announcement.devicesChanged([device("mac", "macos")]);
    await settle();
    expect(started).toEqual([]);
    announcement.devicesChanged([device("mac", "macos"), device("view", "ios")]);
    announcement.devicesChanged([device("view", "ios"), device("view", "ios")]);
    await settle();
    expect(started).toEqual([["-R", "Kun’s Mac mini", ANNOUNCE_SERVICE, "local.", "47623"]]);
  });

  // INF-95: a Linux home announces the same service with Avahi, so a phone paired to it finds it again.
  it("asks a Linux home's avahi-publish for the same service under its name at the connection's port", async () => {
    const { announcement, started } = announcer(avahiAnnounceArgs, "studio");
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    expect(started).toEqual([["--no-fail", "--service", "studio", ANNOUNCE_SERVICE, "47623"]]);
    announcement.dispose();
  });

  it("stops once the last phone is gone, and again announces when a phone joins", async () => {
    const { announcement, started, stopped } = announcer();
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    announcement.devicesChanged([device("view", "ios")]);
    expect(stopped).toEqual([]);
    announcement.devicesChanged([device("mac", "macos")]);
    expect(stopped).toEqual([0]);
    expect(announcement.announcing).toBe(false);
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    expect(started).toHaveLength(2);
    announcement.dispose();
    expect(stopped).toEqual([0, 1]);
  });

  it("starts nothing when the phone left before the name was read, and nothing where dns-sd is missing", async () => {
    const { announcement, started } = announcer();
    announcement.devicesChanged([device("view", "ios")]);
    announcement.devicesChanged([]);
    await settle();
    expect(started).toEqual([]);
    const none = new HomeAnnouncement({
      run: null,
      args: dnsSdAnnounceArgs,
      name: async () => "x",
      port: 1,
    });
    none.devicesChanged([device("view", "ios")]);
    expect(none.announcing).toBe(false);
  });

  it("announces again, later each time, after a run ended by itself while a phone is listed", async () => {
    const ends: Array<() => void> = [];
    const waits: number[] = [];
    const fires: Array<() => void> = [];
    let starts = 0;
    const run: DnsSdRun = (_args, heard) => {
      starts += 1;
      ends.push(() => heard.ended(false));
      return { stop: () => {} };
    };
    const announcement = new HomeAnnouncement({
      run,
      args: dnsSdAnnounceArgs,
      name: async () => "Mini",
      port: 1,
      later: (ms, fire) => {
        waits.push(ms);
        fires.push(fire);
        return () => {};
      },
    });
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    ends[0]?.();
    expect(announcement.announcing).toBe(false);
    fires[0]?.();
    await settle();
    expect(starts).toBe(2);
    ends[1]?.();
    expect(waits).toEqual([5_000, 10_000]);
    // The phone left while it waited: nothing starts.
    announcement.devicesChanged([]);
    fires[1]?.();
    await settle();
    expect(starts).toBe(2);
  });

  it("is final once disposed: a later change on the list starts nothing", async () => {
    const { announcement, started, stopped } = announcer();
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    announcement.dispose();
    expect(stopped).toEqual([0]);
    announcement.devicesChanged([device("view", "ios")]);
    await settle();
    expect(started).toHaveLength(1);
    expect(announcement.announcing).toBe(false);
  });
});
