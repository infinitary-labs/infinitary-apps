import { describe, expect, it } from "vitest";
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
