import * as m from "@shared/i18n/messages.generated";
import { RAIL_SLOTS } from "@shared/panelArrangement";
import type { RailSide, RailY, SidePanelPlacement } from "@shared/plugins/manifest";
import type { PanelArrangement } from "@shared/preferences";

/**
 * Settings → Panels' words and rows (INF-2344; design skill
 * `components/core/PanelsSettings.prompt.md`): where each panel sits on the
 * rails, in order, and whether it shows.
 */

export const PANELS_WORDS = {
  get heading() {
    return m.settingsPanelsHeading();
  },
  get intro() {
    return m.settingsPanelsIntro();
  },
  get noPanels() {
    return m.settingsPanelsNone();
  },
  get reset() {
    return m.settingsPanelsReset();
  },
  get confirmReset() {
    return m.settingsPanelsResetConfirm();
  },
  /** A row's Show switch, naming its panel. */
  show: (title: string) => m.settingsPanelsShow({ title }),
  /** The key legend under the rails, one piece after each key pair. */
  keys: {
    get move() {
      return m.settingsPanelsKeysMove();
    },
    get otherRail() {
      return m.settingsPanelsKeysOtherRail();
    },
    get showOrHide() {
      return m.settingsPanelsKeysShowOrHide();
    },
    get openOrCollapse() {
      return m.settingsPanelsKeysOpenOrCollapse();
    },
  },
} as const;
export const RAIL_WORDS: Record<RailSide, string> = {
  get left() {
    return m.settingsPanelsLeftRail();
  },
  get right() {
    return m.settingsPanelsRightRail();
  },
};
export const GROUP_WORDS: Record<RailY, string> = {
  get top() {
    return m.settingsPanelsTop();
  },
  get bottom() {
    return m.settingsPanelsBottom();
  },
};

/** A group's list name: its rail, then its end. */
export function groupLabel(side: RailSide, y: RailY): string {
  if (side === "left")
    return y === "top" ? m.settingsPanelsLeftTop() : m.settingsPanelsLeftBottom();
  return y === "top" ? m.settingsPanelsRightTop() : m.settingsPanelsRightBottom();
}

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
  get shown() {
    return m.settingsPanelsShown();
  },
  get collapsed() {
    return m.settingsPanelsCollapsed();
  },
  get hidden() {
    return m.settingsPanelsHidden();
  },
  get nothing() {
    return m.settingsPanelsNothing();
  },
  get more() {
    return m.settingsPanelsMore();
  },
  get "waits-for-rule"() {
    return m.settingsPanelsWaitsForRule();
  },
  get "waits-for-knowledge"() {
    return m.settingsPanelsWaitsForKnowledge();
  },
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
