import { RAIL_SLOTS } from "@shared/panelArrangement";
import type { RailSide, RailY, SidePanelPlacement } from "@shared/plugins/manifest";
import type { PanelArrangement } from "@shared/preferences";

/**
 * Settings → Panels' words and rows (INF-2344; design skill
 * `components/core/PanelsSettings.prompt.md`): where each panel sits on the
 * rails, in order, and whether it shows.
 */

export const PANELS_INTRO = "Where each panel sits on your rails, in order.";
export const RAIL_WORDS: Record<RailSide, string> = { left: "Left rail", right: "Right rail" };
export const GROUP_WORDS: Record<RailY, string> = { top: "Top", bottom: "Bottom" };
export const NO_PANELS = "No panels";
export const RESET_PANELS = "Reset to defaults";
export const CONFIRM_RESET_PANELS = "Confirm reset";

/** What a row says about its panel. */
export type PanelRowState =
  | "shown"
  | "collapsed"
  | "hidden"
  | "nothing"
  | "more"
  | "waits-for-rule"
  | "waits-for-knowledge";

export const PANEL_STATE_WORDS: Record<PanelRowState, string> = {
  shown: "Shown",
  collapsed: "Collapsed",
  hidden: "Hidden",
  nothing: "Nothing to show right now",
  more: "In the More row",
  "waits-for-rule": "Shows when a rule is saved",
  "waits-for-knowledge": "Shows once there is knowledge",
};

/** What the window knows of one panel, for its row. */
export type PanelRowFacts = {
  /** Kept off the rails by the captain's Hide. */
  hidden: boolean;
  /**
   * Registered here, or the gate an app panel waits on: Automation until a
   * rule is saved, Knowledge until there is some to show.
   */
  present: true | "automation" | "knowledge";
  /** Its own code has nothing on its rail now. */
  empty: boolean;
  /** Gathered into its rail's More row for room. */
  gathered: boolean;
  collapsed: boolean;
};

/** A row's state, the captain's Hide first, then why the rail does not show it, then its collapse. */
export function panelRowState(facts: PanelRowFacts): PanelRowState {
  if (facts.hidden) return "hidden";
  if (facts.present === "automation") return "waits-for-rule";
  if (facts.present === "knowledge") return "waits-for-knowledge";
  if (facts.empty) return "nothing";
  if (facts.gathered) return "more";
  return facts.collapsed ? "collapsed" : "shown";
}

/** One group's rows: the panels the tab lists, in the arrangement's order. */
export type PanelGroup = { slot: SidePanelPlacement; ids: readonly string[] };

/** The four groups in reading order, each listing only the panels the tab shows. */
export function panelGroups(
  arrangement: PanelArrangement,
  listed: (id: string) => boolean,
): PanelGroup[] {
  return RAIL_SLOTS.map((slot) => ({
    slot,
    ids: arrangement[slot.x][slot.y].filter(listed),
  }));
}

/** The row a plain arrow, Home or End moves focus to, or null for a key that moves nothing. */
export function rowStep(key: string, ids: readonly string[], at: string): string | null {
  const index = ids.indexOf(at);
  switch (key) {
    case "ArrowUp":
      return index > 0 ? (ids[index - 1] ?? null) : null;
    case "ArrowDown":
      return index >= 0 && index < ids.length - 1 ? (ids[index + 1] ?? null) : null;
    case "Home":
      return ids[0] ?? null;
    case "End":
      return ids[ids.length - 1] ?? null;
    default:
      return null;
  }
}
