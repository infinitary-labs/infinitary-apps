import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSelfSourceDir } from "./resolve";

describe("resolveSelfSourceDir", () => {
  it("points packaged builds at extraResources self-source", () => {
    expect(
      resolveSelfSourceDir({
        isPackaged: true,
        resourcesPath: "/App/Contents/Resources",
        appPath: "/App/Contents/Resources/app.asar",
      }),
    ).toBe(join("/App/Contents/Resources", "self-source"));
  });

  it("points unpackaged / dev at the checkout (app path)", () => {
    expect(
      resolveSelfSourceDir({
        isPackaged: false,
        resourcesPath: "/Electron.app/Contents/Resources",
        appPath: "/src/firstmate-3000",
      }),
    ).toBe("/src/firstmate-3000");
  });
});
