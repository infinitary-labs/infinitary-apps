import { describe, expect, it } from "vitest";
import { deviceChipOf, platformProfile } from "./platform";

describe("desktop platform adapters", () => {
  it("keeps Mac shell and native login behavior", () => {
    expect(platformProfile("darwin")).toEqual({
      platform: "darwin",
      mac: true,
      windows: false,
      loginShell: "/bin/zsh",
      nativeLoginItem: true,
      system: "macos",
    });
  });
  it("starts Linux without a Mac shell or unsupported login-item API", () => {
    expect(platformProfile("linux")).toEqual({
      platform: "linux",
      mac: false,
      windows: false,
      loginShell: "/bin/sh",
      nativeLoginItem: false,
      system: "linux",
    });
  });
  it("says no system or chip the device record has no word for", () => {
    expect(platformProfile("freebsd").system).toBeNull();
    expect(deviceChipOf("arm64")).toBe("arm64");
    expect(deviceChipOf("x64")).toBe("x64");
    expect(deviceChipOf("ia32")).toBeNull();
  });
});
