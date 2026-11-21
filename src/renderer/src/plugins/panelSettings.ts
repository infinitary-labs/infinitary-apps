import * as m from "@shared/i18n/messages.generated";
import type { PanelMoveResult, PanelSettingChanges } from "@shared/personal/contracts";
import { actionNameSchema } from "@shared/plugins/manifest";
import { z } from "zod";
import { pressesSoFar } from "../app/presses";

/**
 * Changing a setting from a panel, the window's side (docs/ui-plugins.md,
 * "Changing settings"): `PanelProps.settings`, for a panel whose manifest
 * names settings in its `actions` grant and that the captain agreed to when
 * he added it. A change counts only from his own click or key in that page
 * (`gate`, as a task move does), and one press makes one change: a second
 * change before his next press writes nothing and says so. The core reads
 * the grant again and runs the setting's own catalog line as the captain,
 * naming the panel on the feed.
 */

/** The id a panel's frame changes a setting through (`inf.action`). */
export const PANEL_SETTINGS_ACTION = "settings.change";

/** What `inf:plugins:settings:change` needs from the window. */
export type SettingChanger = (
  extensionId: string,
  action: string,
  value: Record<string, unknown>,
) => Promise<PanelMoveResult>;

const changeForReal: SettingChanger = (extensionId, action, value) =>
  window.infinitary.plugins.changeSetting(extensionId, action, value);

const changeSchema = z.strictObject({
  action: actionNameSchema,
  value: z.record(z.string(), z.unknown()),
});

/** The press each panel last spent on a change, by its id: one press, one change. */
const spent = new Map<string, number>();

/**
 * `PanelProps.settings` for one page of `panel`. `gate` says the captain's
 * own click or key is on this page now; `heard` resolves once every press
 * begun in the page has reached the window, so the count it reads is whole.
 */
export function panelSettings(
  panel: { id: string },
  gate: () => Promise<boolean>,
  heard: () => Promise<void>,
  change: SettingChanger = changeForReal,
  presses: () => number = pressesSoFar,
): PanelSettingChanges {
  return {
    change: async (action, value) => {
      const parsed = changeSchema.safeParse({ action, value });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`settings.change: ${issue?.path.join(".") || "change"}: ${issue?.message}`);
      }
      if (!(await gate())) return { ok: false, text: m.panelChangeNotAsked() };
      await heard();
      const press = presses();
      if (press <= (spent.get(panel.id) ?? 0)) return { ok: false, text: m.panelChangeNotAsked() };
      spent.set(panel.id, press);
      try {
        return await change(panel.id, parsed.data.action, parsed.data.value);
      } catch (caught) {
        return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
      }
    },
  };
}

/** The host's answer to a frame's `settings.change`: the value carries the call's arguments. */
export function frameSettingsAction(
  settings: PanelSettingChanges,
): (value: unknown) => Promise<PanelMoveResult> {
  return (value) => {
    const arg = (value ?? {}) as { action?: unknown; value?: unknown };
    return settings.change(arg.action as never, arg.value as Record<string, unknown>);
  };
}
