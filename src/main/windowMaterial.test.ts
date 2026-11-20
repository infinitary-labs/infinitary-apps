import { describe, expect, it } from "vitest";
import { mainWindowMaterial, OPAQUE_VOID, windowMaterialOptions } from "./windowMaterial";

describe("mainWindowMaterial", () => {
  it("makes a shown macOS window the system material, lit while unfocused, and tells the page", () => {
    const material = mainWindowMaterial({ platform: "darwin", hidden: false });
    expect(material.kind).toBe("translucent");
    expect(windowMaterialOptions(material)).toEqual({
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "active",
      additionalArguments: ["--fm-window-material=translucent"],
    });
  });

  it("keeps a hidden window opaque so pixel probes read the void", () => {
    const material = mainWindowMaterial({ platform: "darwin", hidden: true });
    expect(material.kind).toBe("opaque");
    expect(windowMaterialOptions(material)).toEqual({
      backgroundColor: OPAQUE_VOID,
      additionalArguments: ["--fm-window-material=opaque"],
    });
  });

  it("keeps every other platform opaque", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(mainWindowMaterial({ platform, hidden: false })).toEqual({
        kind: "opaque",
        backgroundColor: OPAQUE_VOID,
      });
    }
  });
});
