import { z } from "zod";
import type { PluginSource } from "./manifest";

/**
 * What the window did with each panel it knows (docs/personal-panels.md,
 * "Placed on the rail"): the one answer a crewmate's `place_panel` and the
 * Firstmate's surfaces list read, instead of guessing from the layout.
 *
 * - `drawn`: on its rail, open, its body drawn;
 * - `collapsed`: on its rail, collapsed to its header, as the captain's
 *   layout has it;
 * - `folded`: on its rail, folded to its header by the window, because the
 *   rail is too short for its body (docs/ui-plugins.md, "When a rail runs
 *   out of room");
 * - `gathered`: in its rail's More row, off the rail itself, because the
 *   rail is too short even for its header;
 * - `loading`: on its rail, its module still importing;
 * - `stopped`: on its rail, its body threw or would not import;
 * - `off`: registered, but nothing on the rail - its presence rule finds
 *   nothing, it has no compiled panel, or its own code has it off;
 * - `hidden`: the captain's layout keeps it off the rails;
 * - `refused`: the window would not mount it (`why` is the refusal).
 */
export const PANEL_MOUNT_STATES = [
  "drawn",
  "collapsed",
  "folded",
  "gathered",
  "loading",
  "stopped",
  "off",
  "hidden",
  "refused",
] as const;
export type PanelMountState = (typeof PANEL_MOUNT_STATES)[number];

/**
 * Whose panel it is: the app's own, the captain's own, or one he added.
 * Two panels may share an id - a panel of the captain's named after one of
 * the app's - and only one of them is on a rail, so every reader matches
 * the kind as well as the id.
 */
export const PANEL_MOUNT_KINDS = ["app", "personal", "installed"] as const;
export type PanelMountKind = (typeof PANEL_MOUNT_KINDS)[number];

/** The kind of a panel from the core's snapshot, by where it came from. */
export function mountKindOf(source: PluginSource): PanelMountKind {
  return source === "installed" ? "installed" : "personal";
}

/** The longest reason the window sends; a longer one is cut at the window. */
export const PANEL_MOUNT_WHY_MAX = 500;

export const panelMountSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(PANEL_MOUNT_KINDS),
  /** The compiled version the window judged; null for the app's own panels. */
  version: z.string().max(200).nullable(),
  state: z.enum(PANEL_MOUNT_STATES),
  /** The rail it is on, or would be on; null when it has none. */
  rail: z.enum(["left", "right"]).nullable(),
  /** Why it is not drawn, in the window's words; null when it is. */
  why: z.string().max(PANEL_MOUNT_WHY_MAX).nullable(),
  /**
   * The runbook whose panel the core left off the rails (docs/runbooks.md,
   * "Panels"), such as for an id another panel holds: listed beside, never
   * as, a panel with the same id. Absent on every other row.
   */
  runbook: z.string().min(1).max(100).optional(),
});
export type PanelMount = z.infer<typeof panelMountSchema>;

/** The most panels one answer names; refused runbook panels past it are left out, never a drawn one. */
export const PANEL_MOUNTS_MAX = 500;

export const panelMountsSchema = z.object({
  panels: z.array(panelMountSchema).max(PANEL_MOUNTS_MAX),
});
export type PanelMounts = z.infer<typeof panelMountsSchema>;
