import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it, vi } from "vitest";
import { panelSettings, type SettingChanger } from "./panelSettings";

/**
 * Intent: the approved plan's "PanelProps.settings.change gated like task
 * moves with one change per press" (docs/ui-plugins.md, "Changing settings"):
 * a change counts only from the captain's own click or key in the panel's
 * page, and each press makes at most one change.
 */

const heard = async () => {};

describe("settings.change", () => {
  it("changes a setting only from the captain's click or key in the panel", async () => {
    const change = vi.fn<SettingChanger>(async () => ({ ok: true }));
    const away = panelSettings(
      { id: "look-away" },
      async () => false,
      heard,
      change,
      () => 1,
    );
    await expect(away.change("theme", { theme: "light" })).resolves.toEqual({
      ok: false,
      text: m.panelChangeNotAsked(),
    });
    expect(change).not.toHaveBeenCalled();
    const here = panelSettings(
      { id: "look-here" },
      async () => true,
      heard,
      change,
      () => 1,
    );
    await expect(here.change("theme", { theme: "light" })).resolves.toEqual({ ok: true });
    expect(change).toHaveBeenCalledWith("look-here", "theme", { theme: "light" });
  });

  it("makes one change per press, and the next press makes the next", async () => {
    let presses = 3;
    const change = vi.fn<SettingChanger>(async () => ({ ok: true }));
    const settings = panelSettings(
      { id: "look-presses" },
      async () => true,
      heard,
      change,
      () => presses,
    );
    await expect(settings.change("window-size", { size: 110 })).resolves.toEqual({ ok: true });
    // A second change on the same press, even with focus still in the panel.
    await expect(settings.change("theme", { theme: "light" })).resolves.toEqual({
      ok: false,
      text: m.panelChangeNotAsked(),
    });
    expect(change).toHaveBeenCalledTimes(1);
    presses += 1;
    await expect(settings.change("theme", { theme: "light" })).resolves.toEqual({ ok: true });
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("counts a press the panel's page began only once the window heard it", async () => {
    let presses = 0;
    const change = vi.fn<SettingChanger>(async () => ({ ok: true }));
    // The page's press reaches the window after the change asked, before the page answers the ping.
    const late = async () => {
      presses += 1;
    };
    const settings = panelSettings(
      { id: "look-late" },
      async () => true,
      late,
      change,
      () => presses,
    );
    await expect(settings.change("theme", { theme: "dark" })).resolves.toEqual({ ok: true });
  });

  it("answers the core's refusal in its words, and refuses a name that is not a setting's", async () => {
    const refusal = m.panelChangeNotGranted({ setting: "crew-model-names" });
    const settings = panelSettings(
      { id: "look-refused" },
      async () => true,
      heard,
      async () => ({ ok: false, text: refusal }),
      () => 1,
    );
    await expect(settings.change("theme", { theme: "dark" })).resolves.toEqual({
      ok: false,
      text: refusal,
    });
    await expect(settings.change("Theme!" as never, {})).rejects.toThrow("settings.change: action");
  });
});
