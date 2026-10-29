import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_PIN,
  phoneSimulator,
  phoneXcode,
  type SimulatorCatalog,
} from "../scripts/phone-simulator";

// INF-1645 (the captain's "Approve and build the pin"): every Mac's phone check uses the one Xcode and
// iOS simulator phone-pin.json names, and refuses any other. A crewmate's MacBook with Xcode 27.1's real
// simctl list, trimmed to the fields read here and the two gate devices plus iPhone Duo: iOS 26.4, 27.0
// and a 27.1 build, which hosts only iPhone Duo (INF-1552), as Xcode 27.1's own 27.1 does (INF-1653).
const catalog: SimulatorCatalog = JSON.parse(
  readFileSync("tests/fixtures/phone-simulator/xcode-27.1.json", "utf8"),
);

describe("the phone check's pinned simulator", () => {
  it.each(["iphone", "ipad"] as const)(
    "takes the pinned runtime for %s, never a newer one",
    (device) => {
      const { kind, runtime } = phoneSimulator(catalog, device);
      expect(kind.name).toBe(PHONE_PIN.devices[device]);
      expect([runtime.version, runtime.buildversion]).toEqual([PHONE_PIN.ios, PHONE_PIN.iosBuild]);
      // Enumeration order is not installation order or version order.
      expect(
        phoneSimulator({ ...catalog, runtimes: [...catalog.runtimes].reverse() }, device),
      ).toEqual({
        kind,
        runtime,
      });
    },
  );

  it.each(["iphone", "ipad"] as const)(
    "refuses a Mac without the pinned runtime for %s rather than taking another one",
    (device) => {
      const without = {
        ...catalog,
        runtimes: catalog.runtimes.filter((runtime) => runtime.buildversion !== PHONE_PIN.iosBuild),
      };
      expect(() => phoneSimulator(without, device)).toThrow(
        `needs the iOS ${PHONE_PIN.ios} simulator ${PHONE_PIN.iosBuild}`,
      );
      expect(() => phoneSimulator(without, device)).toThrow(
        `xcodebuild -downloadPlatform iOS -buildVersion ${PHONE_PIN.iosBuild}`,
      );
    },
  );

  it("refuses the pinned runtime when it has no supported-device reading", () => {
    const unread = structuredClone(catalog);
    for (const runtime of unread.runtimes) delete runtime.supportedDeviceTypes;
    expect(() => phoneSimulator(unread, "iphone")).toThrow(
      `does not support ${PHONE_PIN.devices.iphone}`,
    );
  });

  it("refuses a missing requested device type rather than substituting another device", () => {
    expect(() => phoneSimulator({ ...catalog, devicetypes: [] }, "iphone")).toThrow(
      `Install the ${PHONE_PIN.devices.iphone} simulator device type`,
    );
  });

  it("refuses any Xcode but the pinned one, naming the reading it found", () => {
    // The Mac mini's own `xcodebuild -version` before its update.
    expect(() => phoneXcode("Xcode 26.4\nBuild version 17E192\n")).toThrow(
      `needs Xcode ${PHONE_PIN.xcode}, not 26.4`,
    );
    expect(() => phoneXcode("")).toThrow("not an unreadable Xcode");
    // A crewmate's MacBook.
    expect(() => phoneXcode(`Xcode ${PHONE_PIN.xcode}\nBuild version 27A9275\n`)).not.toThrow();
  });
});
