import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { phoneSimulator, type SimulatorCatalog } from "../scripts/phone-simulator";

// INF-1552: the local phone check must start when its newest installed iOS runtime
// cannot host the requested device. Xcode 27.1's real simctl list, trimmed to the
// fields read here and the two gate devices plus iPhone Duo (27.1's only device).
const catalog: SimulatorCatalog = JSON.parse(
  readFileSync("tests/fixtures/phone-simulator/xcode-27.1.json", "utf8"),
);

describe("the phone check's compatible simulator runtime", () => {
  it.each(["iphone", "ipad"] as const)(
    "picks the newest compatible runtime for %s, not the newest installed one",
    (device) => {
      const { kind, runtime } = phoneSimulator(catalog, device);
      expect(kind.name).toBe(device === "ipad" ? "iPad Pro 11-inch (M4)" : "iPhone 16");
      expect(runtime.identifier).toBe("com.apple.CoreSimulator.SimRuntime.iOS-27-0");
      expect(runtime.supportedDeviceTypes).toContainEqual(
        expect.objectContaining({ identifier: kind.identifier }),
      );
      // Enumeration order is not installation order or version order.
      expect(
        phoneSimulator({ ...catalog, runtimes: [...catalog.runtimes].reverse() }, device),
      ).toEqual({ kind, runtime });
    },
  );

  it("uses the next compatible installed runtime when the newer compatible one is unavailable", () => {
    const unavailable = structuredClone(catalog);
    unavailable.runtimes.find((runtime) => runtime.version === "27.0")!.isAvailable = false;
    expect(phoneSimulator(unavailable, "iphone").runtime.identifier).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    );
  });

  it("refuses with the requested device named when none of the installed runtimes supports it", () => {
    const incompatible = {
      ...catalog,
      runtimes: catalog.runtimes.filter((runtime) => runtime.version === "27.1"),
    };
    expect(() => phoneSimulator(incompatible, "iphone")).toThrow(/runtime that supports iPhone 16/);
    expect(() => phoneSimulator(incompatible, "ipad")).toThrow(
      /runtime that supports iPad Pro 11-inch \(M4\)/,
    );
  });

  it("does not assume compatibility when a runtime has no supported-device reading", () => {
    const unread = structuredClone(catalog);
    for (const runtime of unread.runtimes) delete runtime.supportedDeviceTypes;
    expect(() => phoneSimulator(unread, "iphone")).toThrow(/runtime that supports iPhone 16/);
  });

  it("refuses a missing requested device type rather than substituting another device", () => {
    expect(() => phoneSimulator({ ...catalog, devicetypes: [] }, "iphone")).toThrow(
      /Install the iPhone 16 simulator device type/,
    );
  });
});
