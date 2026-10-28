import { frameHoldsFocus } from "./frames/frameFocus";
import { framePanelCardAction, PANEL_CARD_ACTIONS, PANEL_CARD_VIEW_ACTIONS } from "./panelCards";
import {
  framePointAction,
  PANEL_DRAFT_ACTION,
  PANEL_LINE_PEEK_ACTION,
  PANEL_OPEN_SETTINGS_ACTION,
  PANEL_POINT_ACTIONS,
  panelPoint,
} from "./panelPoint";
import { frameRailAction, PANEL_RAIL_ACTIONS } from "./panelRail";
import { frameTasksAction, PANEL_TASKS_ACTIONS, panelTasks } from "./panelTasks";

/**
 * Everything a page of a panel from elsewhere may ask the host, declared
 * from what the panel asked for (docs/ui-plugins.md, "A panel's cards"):
 * the card actions every panel has, `card.keep` on a card's own page, the
 * pointing a panel that reads `tasks.board` gets, the draft and the Settings opening every panel has, `tasks.run` for one the
 * captain agreed may move his tasks, and the rail actions on the panel's
 * own page. The frame's controller refuses any other id, and each handler
 * checks its value like any input from a panel.
 */
export type FramePanelPage = {
  /** The panel; `own` for one of the app's own, which names no panel on a task's record. */
  panel: { id: string; title: string; own?: boolean };
  /** The page's frame, found when asked. */
  frame: () => HTMLIFrameElement | null;
  /** Set for a card's own page: the card it draws. */
  card?: string;
  /** The reads the panel was served. */
  reads: readonly string[];
  /** It was granted moves. */
  moves: boolean;
  /** Its own code decides whether it shows (`presence` `{ "code": true }`). */
  decides: boolean;
};

export function framePanelActions(page: FramePanelPage): {
  actions: readonly string[];
  onAction: (id: string, value: unknown) => Promise<unknown>;
} {
  const { panel, frame, card } = page;
  // The captain's own click or key holds this page only while its frame holds the window's focus.
  const gate = () => frameHoldsFocus(frame);
  const cardActions = framePanelCardAction(panel.id, frame, card);
  const points = page.reads.includes("tasks.board");
  const point = framePointAction(
    panelPoint(panel.id, {
      reads: page.reads,
      ...(card === undefined ? {} : { card }),
      gate,
      frame,
    }),
  );
  const tasks = frameTasksAction(panelTasks(panel, gate));
  const rail = frameRailAction(panel.id, page.decides);
  const actions = [
    ...(card === undefined ? PANEL_CARD_ACTIONS : PANEL_CARD_VIEW_ACTIONS),
    ...(points ? PANEL_POINT_ACTIONS : []),
    ...(page.reads.includes("feed.recent") ? [PANEL_LINE_PEEK_ACTION] : []),
    PANEL_DRAFT_ACTION,
    PANEL_OPEN_SETTINGS_ACTION,
    ...(page.moves ? PANEL_TASKS_ACTIONS : []),
    ...(card === undefined ? PANEL_RAIL_ACTIONS : []),
  ];
  return {
    actions,
    onAction: (id, value) => {
      if (id.startsWith("point.")) return point(id, value);
      if (id.startsWith("tasks.")) return tasks(id, value);
      if (id.startsWith("rail.")) return rail(id, value);
      return cardActions(id, value);
    },
  };
}
