import { describe, expect, it } from "vitest";
import type { DeviceView } from "./devices";
import { type NearbyMac, nearbyAddress, nearbyMacsViewSchema, nearbyOnList } from "./nearbyMacs";
import { parseRemoteLoginAddress } from "./remoteLogin";

const MINI: NearbyMac = { name: "Kun’s Mac mini", at: "Kuns-Mac-mini.local" };

const device = (overrides: Partial<DeviceView>): DeviceView => ({
  id: "d1",
  kind: "work",
  name: "Studio",
  pairedAt: 1,
  ...overrides,
});

describe("Macs nearby", () => {
  it("fills in this Mac's user at that Mac's name, an address Add it takes", () => {
    expect(nearbyAddress(MINI, "kun")).toBe("kun@Kuns-Mac-mini.local");
    expect(parseRemoteLoginAddress(nearbyAddress(MINI, "kun"))).toBe("kun@Kuns-Mac-mini.local");
    // No user an address can carry: the name alone, which SSH reaches as this Mac's user.
    expect(nearbyAddress(MINI, null)).toBe("Kuns-Mac-mini.local");
  });

  it("marks a Mac added at its name on this network, whatever the user or case", () => {
    expect(nearbyOnList(MINI, [device({ remoteLogin: "sam@kuns-mac-mini.local." })])).toBe(true);
    expect(nearbyOnList(MINI, [device({ remoteLogin: "sam@studio.local" })])).toBe(false);
  });

  it("marks a Mac that joined under the same name, as a link or a command adds one", () => {
    expect(nearbyOnList(MINI, [device({ kind: "view", name: "Kun’s Mac mini" })])).toBe(true);
  });

  it("never marks one for another user on this Mac, which shares this Mac's name", () => {
    expect(
      nearbyOnList(MINI, [device({ name: "Kun’s Mac mini", onThisMac: true, user: "builder" })]),
    ).toBe(false);
  });

  it("refuses a name or user an address could not carry", () => {
    const view = { state: "looking", user: "kun", macs: [MINI] };
    expect(nearbyMacsViewSchema.safeParse(view).success).toBe(true);
    expect(
      nearbyMacsViewSchema.safeParse({ ...view, macs: [{ ...MINI, at: "-oProxyCommand=x" }] })
        .success,
    ).toBe(false);
    expect(nearbyMacsViewSchema.safeParse({ ...view, user: "two words" }).success).toBe(false);
    expect(
      nearbyMacsViewSchema.safeParse({ ...view, macs: [{ ...MINI, name: "a‮b" }] }).success,
    ).toBe(false);
  });
});
