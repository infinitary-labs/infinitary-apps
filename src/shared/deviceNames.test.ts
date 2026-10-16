import { describe, expect, it } from "vitest";
import { aDevice, COMPUTER, deviceNoun, HERE, HOME } from "./deviceNames";
import type { DeviceSystem } from "./devices";
import { platformProfile } from "./platform";

describe("what a device is called (the captain's computer everywhere)", () => {
  it("calls every computer a computer, Macs included, and a phone a phone", () => {
    const named = (system: DeviceSystem | undefined) => deviceNoun({ system });
    expect(named("macos")).toBe("computer");
    expect(named("linux")).toBe("computer");
    expect(named("windows")).toBe("computer");
    expect(named("ios")).toBe("phone");
    expect(aDevice({ system: "ios" })).toBe("a phone");
    expect(aDevice({ system: "linux" })).toBe("a computer");
  });

  it("calls a device that never said what it is a computer", () => {
    expect(deviceNoun({})).toBe("computer");
    expect(aDevice({ system: undefined })).toBe("a computer");
  });

  it("names this computer the same way on a Mac, on Linux and on Windows", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const system = platformProfile(platform).system ?? undefined;
      expect(deviceNoun({ system })).toBe(COMPUTER.one);
    }
    expect(HERE).toEqual({ this: "this computer", This: "This computer" });
    expect(HOME.the).toBe("the computer where your first mate lives");
    expect(COMPUTER).toEqual({
      one: "computer",
      One: "Computer",
      many: "computers",
      Many: "Computers",
    });
  });
});
