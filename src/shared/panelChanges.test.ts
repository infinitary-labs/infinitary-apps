import { describe, expectTypeOf, it } from "vitest";
import type { PanelChangeName } from "./panelChanges";
import type { PanelChangeSetting } from "./personal/contracts";

/**
 * Intent: the approved plan's "a manifest actions grant under a host
 * allowlist": the setting names a panel's code is typed with
 * (`PanelChangeSetting`, written out for the panel workspace) are the host's
 * allowlist exactly, so a panel is never typed a name the host refuses.
 */
describe("the settings a panel may change", () => {
  it("names the same settings in the panel's types as the host allows", () => {
    expectTypeOf<PanelChangeSetting>().toEqualTypeOf<PanelChangeName>();
  });
});
