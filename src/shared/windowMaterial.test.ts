import { describe, expect, it } from "vitest";
import { windowMaterialArgument, windowMaterialFromArgv } from "./windowMaterial";

describe("windowMaterialFromArgv", () => {
  it("round-trips the material through the preload argument", () => {
    expect(windowMaterialFromArgv(["electron", windowMaterialArgument("translucent")])).toBe(
      "translucent",
    );
    expect(windowMaterialFromArgv(["electron", windowMaterialArgument("opaque")])).toBe("opaque");
  });

  it("is opaque when the argument is missing or unknown", () => {
    expect(windowMaterialFromArgv(["electron"])).toBe("opaque");
    expect(windowMaterialFromArgv(["--fm-window-material=glass"])).toBe("opaque");
  });
});
