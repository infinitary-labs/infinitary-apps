import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it, vi } from "vitest";
import { panelSettings, type SettingChanger } from "./panelSettings";

/**
 * Intent: the approved plan's "PanelProps.settings.change gated like task
 * moves", with the captain's later choice to rely on focus as task moves do
 * (docs/ui-plugins.md, "Changing settings"): a change counts only while the
 * captain's own click or key is in the panel's page.
 */

describe("settings.change", () => {
  it("changes a setting only while the captain's click or key is in the panel", async () => {
    const change = vi.fn<SettingChanger>(async () => ({ ok: true }));
    const away = panelSettings({ id: "look-away" }, async () => false, change);
    await expect(away.change("theme", { theme: "light" })).resolves.toEqual({
      ok: false,
      text: m.panelChangeNotAsked(),
    });
    expect(change).not.toHaveBeenCalled();
    const here = panelSettings({ id: "look-here" }, async () => true, change);
    await expect(here.change("theme", { theme: "light" })).resolves.toEqual({ ok: true });
    expect(change).toHaveBeenCalledWith("look-here", "theme", { theme: "light" });
  });

  it("answers the core's refusal in its words, and refuses a name that is not a setting's", async () => {
    const refusal = m.panelChangeNotGranted({ setting: "crew-model-names" });
    const settings = panelSettings(
      { id: "look-refused" },
      async () => true,
      async () => ({
        ok: false,
        text: refusal,
      }),
    );
    await expect(settings.change("theme", { theme: "dark" })).resolves.toEqual({
      ok: false,
      text: refusal,
    });
    await expect(settings.change("Theme!" as never, {})).rejects.toThrow("settings.change: action");
  });
});
