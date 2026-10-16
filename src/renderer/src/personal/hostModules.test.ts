import { OLDER_PERSONAL_HOST_GLOBAL, PERSONAL_HOST_GLOBAL } from "@shared/personal/manifest";
import * as React from "react";
import { describe, expect, it } from "vitest";
import * as design from "../design";
import { hostModules, installHostModules } from "./hostModules";

/**
 * The `@infinitary/ui` boundary (talk-to-personalize Steps 2 and 3): what a
 * personal panel gets from `import { X } from "@infinitary/ui"` is exactly
 * the design library's export surface, and `react` is the app's own
 * instance, so hooks and elements are the renderer's.
 */
describe("host modules", () => {
  it("publishes the whole design library and the app's React on one global", () => {
    expect(Object.keys(hostModules.ui).sort()).toEqual(Object.keys(design).sort());
    expect(Object.keys(design).length).toBeGreaterThan(5);
    expect(hostModules.ui.Badge).toBe(design.Badge);
    expect(hostModules.react.useState).toBe(React.useState);
    expect(typeof hostModules.jsxRuntime.jsx).toBe("function");
    expect(typeof hostModules.jsxDevRuntime.jsxDEV).toBe("function");
    const target: Record<string, unknown> = {};
    installHostModules(target);
    expect(target[PERSONAL_HOST_GLOBAL]).toBe(hostModules);
    // A shim served before the Infinitary rename finds the same modules.
    expect(target[OLDER_PERSONAL_HOST_GLOBAL]).toBe(hostModules);
    // Not reassignable: a panel cannot swap the library out from under its siblings.
    for (const name of [PERSONAL_HOST_GLOBAL, OLDER_PERSONAL_HOST_GLOBAL])
      expect(() => {
        target[name] = {};
      }).toThrow();
  });
});
