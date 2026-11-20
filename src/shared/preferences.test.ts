import { describe, expect, it } from "vitest";
import {
  appearanceSchema,
  DEFAULT_LAYOUT,
  effectivePlacement,
  isPanelHidden,
  layoutSchema,
  personalPanelsSchema,
  shellPreferencesSchema,
  UI_SIZES,
} from "./preferences";

/**
 * The persisted preference shapes (Step 0 and talk-to-personalize Step 1):
 * a layout row written before the hidden and placement records still
 * parses, every record is a deviation, and the helpers read them the way
 * the rails and the Firstmate both must.
 */
describe("the layout record", () => {
  it("parses a Step 0 row with the newer records defaulted", () => {
    expect(layoutSchema.parse({ collapsedPanels: { activity: false } })).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: {},
      placements: {},
    });
  });

  it("stays strict about unknown keys and malformed placements", () => {
    expect(layoutSchema.safeParse({ collapsedPanels: {}, pinned: {} }).success).toBe(false);
    expect(
      layoutSchema.safeParse({ collapsedPanels: {}, placements: { now: { x: "left" } } }).success,
    ).toBe(false);
    expect(
      layoutSchema.safeParse({ collapsedPanels: {}, placements: { now: { x: "up", y: "top" } } })
        .success,
    ).toBe(false);
  });

  it("reads hidden and placement as deviations from the panel's own defaults", () => {
    const layout = {
      collapsedPanels: {},
      hiddenPanels: { now: true, activity: false },
      placements: { activity: { x: "right" as const, y: "top" as const } },
    };
    expect(isPanelHidden(layout, "now")).toBe(true);
    expect(isPanelHidden(layout, "activity")).toBe(false);
    expect(isPanelHidden(DEFAULT_LAYOUT, "now")).toBe(false);
    const preferred = { x: "left" as const, y: "bottom" as const };
    expect(effectivePlacement(layout, "activity", preferred)).toEqual({ x: "right", y: "top" });
    expect(effectivePlacement(layout, "now", preferred)).toBe(preferred);
  });

  it("wraps every preference as the one shell.preferences value, panels defaulted on", () => {
    // A value written before Step 5 carries no `panels` row; it parses as
    // on, which is what the app did before the switch existed.
    expect(
      shellPreferencesSchema.parse({
        appearance: { theme: "light" },
        layout: { collapsedPanels: {} },
      }),
    ).toEqual({
      appearance: { theme: "light" },
      layout: { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      panels: { enabled: true, offReason: null },
    });
    expect(
      shellPreferencesSchema.parse({
        appearance: { theme: "dark" },
        layout: { collapsedPanels: {} },
        panels: { enabled: false, offReason: "safe-mode" },
      }).panels,
    ).toEqual({ enabled: false, offReason: "safe-mode" });
    // The reason is bounded: a row naming one the app does not write is refused.
    expect(personalPanelsSchema.safeParse({ enabled: false, offReason: "whatever" }).success).toBe(
      false,
    );
  });
});

describe("whole-window sizes", () => {
  it("accepts older records and only the four offered sizes", () => {
    expect(appearanceSchema.parse({ theme: "dark" })).toEqual({ theme: "dark" });
    for (const size of UI_SIZES)
      expect(appearanceSchema.parse({ theme: "light", size }).size).toBe(size);
    for (const size of [0, 90, 120, 200, "125"])
      expect(appearanceSchema.safeParse({ theme: "dark", size }).success).toBe(false);
  });
});
