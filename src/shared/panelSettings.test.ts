import { describe, expect, it } from "vitest";
import { ACTION_NAMES, ACTIONS } from "./actions";
import { invokeContract } from "./ipc";
import { PANEL_SETTING_NAMES } from "./panelSettingNames";
import { PANEL_SETTINGS, PANEL_UNREADABLE } from "./panelSettings";
import { readCatalog } from "./reads";

/**
 * INF-5326's approved piece 4: every action catalog line has a panel value
 * or a recorded ground, as the parity test asks of changes, and a panel is
 * served exactly the lines with a value.
 */
describe("what a panel may read of the action catalog", () => {
  it("names every catalog line, each with a panel value or a ground from the closed set", () => {
    expect(Object.keys(PANEL_SETTINGS).sort()).toEqual([...ACTION_NAMES].sort());
    for (const name of ACTION_NAMES) {
      const setting = PANEL_SETTINGS[name];
      if ("unreadable" in setting)
        expect(Object.keys(PANEL_UNREADABLE), name).toContain(setting.unreadable);
    }
  });

  it("serves a panel exactly the lines with a panel value, each read from a request a view may ask", () => {
    const readable = ACTION_NAMES.filter((name) => "value" in PANEL_SETTINGS[name]);
    expect([...PANEL_SETTING_NAMES].sort()).toEqual(readable.sort());
    for (const name of PANEL_SETTING_NAMES) {
      const current = ACTIONS[name].current;
      expect(current, name).not.toBeNull();
      expect(invokeContract[current as keyof typeof invokeContract], name).toMatchObject({
        reach: "views",
      });
    }
    const args = readCatalog["settings.current"].args;
    expect(args.safeParse({ names: ["ambient-music"] }).success).toBe(true);
    expect(args.safeParse({ names: ["project-settings"] }).success).toBe(false);
    expect(args.safeParse({ names: [] }).success).toBe(false);
  });
});
