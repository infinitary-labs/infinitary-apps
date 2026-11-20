import { describe, expect, it } from "vitest";
import { appExecutable } from "./appExecutable";

describe("the app's own program", () => {
  it("reads a Mac app's background file as the main executable beside it", () => {
    expect(
      appExecutable("/Applications/Infinitary.app/Contents/MacOS/Infinitary Background", "darwin"),
    ).toBe("/Applications/Infinitary.app/Contents/MacOS/Infinitary");
    expect(
      appExecutable(
        "/Users/a/Applications/Infinitary Dev.app/Contents/MacOS/Infinitary Dev Background",
        "darwin",
      ),
    ).toBe("/Users/a/Applications/Infinitary Dev.app/Contents/MacOS/Infinitary Dev");
  });

  it("leaves every other program as it is", () => {
    for (const [execPath, platform] of [
      ["/Applications/Infinitary.app/Contents/MacOS/Infinitary", "darwin"],
      ["/Applications/Infinitary.app/Contents/MacOS/Infinitary Background", "linux"],
      ["/opt/Infinitary Background", "darwin"],
      ["/Applications/Infinitary.app/Contents/MacOS/ Background", "darwin"],
      ["C:\\Program Files\\Infinitary\\Infinitary.exe", "win32"],
    ] as const)
      expect(appExecutable(execPath, platform)).toBe(execPath);
  });
});
