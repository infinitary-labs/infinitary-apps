import { describe, expect, it } from "vitest";
import { findChrome, findInstalledBrowser } from "./findChrome";

// Each place is where Google's own installer puts Chrome on that kind of computer.
describe("finding Google Chrome", () => {
  it("finds Chrome where Google's installer puts it on a Mac, in the computer's or the person's Applications", () => {
    const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const own = "/Users/sam/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findChrome("darwin", {}, "/Users/sam", (path) => path === own)).toBe(own);
    expect(findChrome("darwin", {}, "/Users/sam", (path) => path === system || path === own)).toBe(
      system,
    );
  });

  it("finds Chrome on Windows for every user or only the person, from the folders Windows names", () => {
    const env = {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
    };
    const perUser = "C:\\Users\\sam\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    expect(findChrome("win32", env, "C:\\Users\\sam", (path) => path === perUser)).toBe(perUser);
    const x86 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
    expect(findChrome("win32", env, "C:\\Users\\sam", (path) => path === x86)).toBe(x86);
  });

  it("finds Chrome from Google's Linux package, and says none where it is missing", () => {
    expect(
      findChrome("linux", {}, "/home/sam", (path) => path === "/usr/bin/google-chrome-stable"),
    ).toBe("/usr/bin/google-chrome-stable");
    expect(findChrome("linux", {}, "/home/sam", () => false)).toBeUndefined();
  });
});

describe("finding Microsoft Edge", () => {
  it.each([
    [
      "darwin",
      {},
      "/Users/sam",
      "/Users/sam/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    [
      "win32",
      { "PROGRAMFILES(X86)": "C:\\Program Files (x86)" },
      "C:\\Users\\sam",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    ["linux", {}, "/home/sam", "/opt/microsoft/msedge/msedge"],
  ] as const)("finds the stable install on %s", (platform, env, home, executable) => {
    expect(findInstalledBrowser("edge", platform, env, home, (path) => path === executable)).toBe(
      executable,
    );
    expect(findInstalledBrowser("edge", platform, env, home, () => false)).toBeUndefined();
  });
});
