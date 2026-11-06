import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHONE_PIN,
  phoneSharedCacheFolder,
  phoneSimulator,
  phoneXcode,
  removeEmptyPhoneSharedCache,
  SIMULATOR_CACHES,
  type SimulatorCatalog,
} from "../scripts/phone-simulator";
import { scratchDir } from "./helpers/scratchDirs";

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

// INF-2445: the phone check's virtual Mac (macOS 26.6.2, build 25G83) holds a folder for the pinned runtime that an
// obsolete cache build left with only its two output files. CoreSimulator named it as the simulator's cache folder, and
// the simulator's kept log wrote 14,586 of 21,017 SpringBoard records as `<compose failure [shared UUID]>`; after
// `simctl runtime dyld_shared_cache remove` took it away, the next simulator used the runtime's own cache and its kept
// log spelled out every SpringBoard record, the appearance line among them.
const OBSOLETE_BUILD =
  "update_dyld_sim_shared_cache: warning: This tool is obsolete. Simulator runtimes now have a prebuilt dyld cache\n";

describe("the pinned runtime's shared-cache folder on the Mac", () => {
  const pinned = phoneSimulator(catalog, "iphone").runtime;
  const cacheFolder = (contents: Record<string, string>) => {
    const folder = phoneSharedCacheFolder("25G83", pinned, scratchDir("phone-shared-cache-"));
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(contents)) writeFileSync(join(folder, name), text);
    return folder;
  };
  // A stand-in for `simctl runtime dyld_shared_cache remove`, which removed the folder on the virtual Mac.
  const simctlRemove = (folder: string) => {
    const calls: string[] = [];
    return {
      calls,
      remove: async () => {
        calls.push(folder);
        rmSync(folder, { recursive: true });
      },
    };
  };

  it("is the folder CoreSimulator named as the virtual Mac's simulator cache folder", () => {
    // The simulator's launchd_sim environment on the virtual Mac, without its trailing slash.
    expect(phoneSharedCacheFolder("25G83", pinned)).toBe(
      "/Library/Developer/CoreSimulator/Caches/dyld/25G83/com.apple.CoreSimulator.SimRuntime.iOS-27-0.24A434",
    );
    expect(SIMULATOR_CACHES).toBe("/Library/Developer/CoreSimulator/Caches/dyld");
  });

  it("removes the folder an obsolete cache build left, once, and says the kept log reads the cache's words", async () => {
    const folder = cacheFolder({
      "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD,
      "update_dyld_sim_shared_cache-stdout.txt": "",
    });
    const simctl = simctlRemove(folder);
    const line = await removeEmptyPhoneSharedCache(folder, simctl.remove);
    expect(simctl.calls).toEqual([folder]);
    expect(existsSync(folder)).toBe(false);
    expect(line).toBe(
      `Removed ${folder}, which held no shared cache, so the simulator uses its runtime's own cache and its kept log spells out that cache's words`,
    );
    // The next start finds nothing to remove.
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([folder]);
  });

  it("removes an empty folder too", async () => {
    const folder = cacheFolder({});
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toMatch(/^Removed /);
    expect(simctl.calls).toEqual([folder]);
  });

  it("keeps a folder that holds a cache this Mac built, as for an iOS 26 runtime", async () => {
    const folder = cacheFolder({
      dyld_sim_shared_cache_arm64: "cache",
      "dyld_sim_shared_cache_arm64.map": "map",
      "update_dyld_sim_shared_cache-stderr.txt": "",
    });
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([]);
    expect(existsSync(join(folder, "dyld_sim_shared_cache_arm64"))).toBe(true);
  });

  it("does nothing on a Mac with no folder for the runtime, as on a Mac whose system knows the runtime's own cache", async () => {
    const folder = phoneSharedCacheFolder("26B123", pinned, scratchDir("phone-shared-cache-"));
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([]);
  });

  it("names a removal that failed or left the folder, and what the kept log then cannot read", async () => {
    const failed = cacheFolder({ "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD });
    expect(
      await removeEmptyPhoneSharedCache(failed, async () => {
        throw new Error("xcrun failed (1)");
      }),
    ).toBe(
      `Could not remove ${failed}, which holds no shared cache, so the simulator's kept log cannot spell out messages whose words live in its shared cache: xcrun failed (1)`,
    );
    expect(existsSync(failed)).toBe(true);
    const kept = cacheFolder({ "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD });
    expect(await removeEmptyPhoneSharedCache(kept, async () => {})).toBe(
      `Removing ${kept}, which holds no shared cache, left it in place, so the simulator's kept log cannot spell out messages whose words live in its shared cache`,
    );
  });
});
