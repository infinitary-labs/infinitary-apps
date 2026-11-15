import { bootUnit, serviceUnit } from "@core/helper/background";
import { describe, expect, it } from "vitest";
import { execStart } from "../../tests/helpers/unitExecStart";
import { runCommand, runOptions } from "./runCommand";
import { workCommand } from "./workCommand";

/** How the app knows it was started to run work for another Mac (docs/helper.md). */

describe("starting the app to run work", () => {
  it("reads the words after work, packaged or not", () => {
    expect(
      workCommand(
        ["/Applications/Firstmate 3000.app/Contents/MacOS/Firstmate 3000", "work", "run"],
        false,
      ),
    ).toEqual(["run"]);
    expect(
      workCommand(
        ["/repo/node_modules/electron/Electron", "/repo/out/main/index.js", "work", "join", "link"],
        true,
      ),
    ).toEqual(["join", "link"]);
    expect(workCommand(["/app/Firstmate 3000", "work"], false)).toEqual([]);
  });

  it("is the app itself for any other start", () => {
    expect(workCommand(["/app/Firstmate 3000"], false)).toBeNull();
    expect(workCommand(["/app/Firstmate 3000", "-psn_0_12345"], false)).toBeNull();
    expect(workCommand(["/electron", "/repo/out/main/index.js"], true)).toBeNull();
    // The entry itself is never read as the word.
    expect(workCommand(["/electron", "work"], true)).toBeNull();
  });
});

// A user's report on Infinitary 0.8.0 under niri, reproduced by INF-4321: Electron picks Wayland
// from the session type niri puts into the user's systemd before any of the app's code runs, finds
// no display and ends. A Linux unit's command names X11, the display the run starts of its own, and
// still reads as the command it starts, packaged or from a development checkout.
describe("the commands a Linux unit starts", () => {
  const packaged = { executable: "/opt/infinitary/infinitary", args: [] };
  const checkout = { executable: "/repo/node_modules/electron/dist/electron", args: ["/repo"] };

  it("starts the run on X11 and reads as run, with the settings file it names", () => {
    const settings = "/home/kai/run 100% $HOME.json";
    for (const [launcher, defaultApp] of [
      [packaged, false],
      [checkout, true],
    ] as const) {
      const argv = execStart(bootUnit({ launcher, settings, env: {} }));
      expect(argv).toContain("--ozone-platform=x11");
      const words = runCommand(argv, defaultApp);
      expect(words && runOptions(words)).toEqual({ settings });
    }
  });

  it("starts the work mode on X11 and reads as work run", () => {
    for (const [launcher, defaultApp] of [
      [packaged, false],
      [checkout, true],
    ] as const) {
      const argv = execStart(serviceUnit({ launcher, dataDir: "/home/kai/work", env: {} }));
      expect(argv).toContain("--ozone-platform=x11");
      expect(workCommand(argv, defaultApp)).toEqual(["run"]);
    }
  });
});
