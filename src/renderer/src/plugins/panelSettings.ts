import * as m from "@shared/i18n/messages.generated";
import type { PanelMoveResult, PanelSettingChanges } from "@shared/personal/contracts";
import { actionNameSchema } from "@shared/plugins/manifest";
import { z } from "zod";

/**
 * Changing a setting from a panel, the window's side (docs/ui-plugins.md,
 * "Changing settings"): `PanelProps.settings`, for a panel whose manifest
 * names settings in its `actions` grant and that the captain agreed to when
 * he added it. A change counts only while his own click or key is in that
 * page (`gate`, as a task move does): the panel's frame holds the window's
 * focus. Focus is the gate, not a count of presses, because a panel's own
 * script can post the window's press notice itself. The core reads
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

/**
 * `PanelProps.settings` for one page of `panel`. `gate` says the captain's
 * own click or key is on this page now.
 */
export function panelSettings(
  panel: { id: string },
  gate: () => Promise<boolean>,
  change: SettingChanger = changeForReal,
): PanelSettingChanges {
  return {
    change: async (action, value) => {
      const parsed = changeSchema.safeParse({ action, value });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`settings.change: ${issue?.path.join(".") || "change"}: ${issue?.message}`);
      }
      if (!(await gate())) return { ok: false, text: m.panelChangeNotAsked() };
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
