import { ACTIONS } from "@shared/actions";
import { englishOf, said } from "@shared/i18n/said";
import { isPanelChange } from "@shared/panelChanges";
import type { CoreDispatch } from "../dispatcher";
import { actionRequest } from "../pi/appTools";
import { errorText } from "./errorText";

/** The project fields that say where its code lives or goes, never a panel's to change. */
const PLACE_FIELDS = ["origin", "path", "contributionDestination"] as const;

/** The value fields of an allowed line that delete something of the captain's, never a panel's to send. */
const DELETING_FIELDS: Partial<Record<string, readonly string[]>> = {
  "ambient-own-style": ["remove"],
};

/** What a panel's settings change answers (`inf:plugins:settings:change`). */
export type PanelChangeAnswer = { ok: true } | { ok: false; text: string };

/**
 * A panel's change of one setting (docs/ui-plugins.md, "Changing settings"):
 * the window already held it to the captain's focus in the panel, so here
 * the core reads the panel's grant again, builds the request the first mate's
 * own would be built from, and runs it as the captain, the panel named on the
 * feed. A refusal is an answer, never a thrown error, so the panel shows it.
 */
export async function panelChange(
  dispatch: CoreDispatch,
  grantOf: (extensionId: string, action: string) => string | null,
  extensionId: string,
  action: string,
  value: Record<string, unknown>,
): Promise<PanelChangeAnswer> {
  const refused = (text: string): PanelChangeAnswer => ({ ok: false, text });
  // The grant is read again on every change: one turned off since the frame
  // drew, or a name the host never allows, changes nothing.
  const panel = isPanelChange(action) ? grantOf(extensionId, action) : null;
  if (!isPanelChange(action) || panel === null)
    return refused(englishOf(said("panelChangeNotGranted", { setting: action })));
  // Where a project's code lives and where it is pushed stay on the app's
  // exact-change card: its folder, its git address, and whether new work goes
  // to the original project or a fork.
  if (action === "project-settings") {
    const changes = (value as { changes?: unknown }).changes;
    if (changes && typeof changes === "object" && PLACE_FIELDS.some((field) => field in changes))
      return refused(englishOf(said("panelChangeOrigin")));
  }
  // A panel never deletes: a line that saves and removes keeps only its save.
  if (DELETING_FIELDS[action]?.some((field) => field in value))
    return refused(englishOf(said("panelChangeNoDelete")));
  const actor = { kind: "captain", panel } as const;
  const asked: CoreDispatch = (channel, rawArgs) => dispatch(channel, rawArgs, actor);
  try {
    const line = ACTIONS[action];
    const args = await actionRequest(asked, action, value);
    const refusal = line.refuses?.(args) ?? null;
    if (refusal) return refused(refusal);
    if (!line.change) return refused(englishOf(said("panelChangeNotGranted", { setting: action })));
    await dispatch(line.change as Parameters<CoreDispatch>[0], args, actor);
    return { ok: true };
  } catch (error) {
    return refused(errorText(error));
  }
}
