import { describe, expect, expectTypeOf, it } from "vitest";
import { PANEL_CHANGES, type PanelChangeName } from "./panelChanges";
import type { PanelChangeSetting } from "./personal/contracts";
import { panelSettingNameSchema } from "./personal/manifest";

/**
 * Intent: the approved plan's "a manifest actions grant under a host
 * allowlist": the setting names a panel's code is typed with
 * (`PanelChangeSetting`, written out for the panel workspace) are the host's
 * allowlist exactly, so a panel is never typed a name the host refuses.
 */
describe("the settings a panel may change", () => {
  it("names the same settings in the panel's types as the host allows", () => {
    expectTypeOf<PanelChangeSetting>().toEqualTypeOf<PanelChangeName>();
    // The manifest check those types describe takes each catalog line the
    // host grants panels and refuses each one it keeps for the captain.
    const lines = Object.entries(PANEL_CHANGES);
    const kept = lines.filter(([, grant]) => grant !== true).map(([name]) => name);
    expect(kept.length).toBeGreaterThan(0);
    expect(lines.filter(([name]) => panelSettingNameSchema.safeParse(name).success)).toEqual(
      lines.filter(([, grant]) => grant === true),
    );
  });
});
