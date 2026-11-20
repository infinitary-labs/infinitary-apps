import { PANEL_COMMAND_ID_MAX } from "@shared/keyboard";
import {
  type PanelIntegrationsRequest,
  panelIntegrationsRequestSchema,
} from "@shared/personal/manifest";
import {
  PANEL_BODY_ACTION,
  PANEL_INTEGRATIONS_ACTION,
  PANEL_SERVER_ACTION,
  type PanelBodySaid,
} from "@shared/plugins/frameDocument";
import { PANEL_KEY_CLICK_ACTION } from "@shared/plugins/panelActionIds";
import { z } from "zod";
import { remindOfPanelClick } from "../app/keyReminderState";
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
 * Everything a page of a panel may ask the host, declared from what the
 * panel asked for (docs/ui-plugins.md, "A panel's cards"): the card actions
 * every panel has, `card.keep` on a card's own page, the pointing a panel
 * that reads `tasks.board` gets, the draft and the Settings opening every
 * panel has, `tasks.run` for one the captain agreed may move his tasks, the
 * rail actions and `panel.body` on the panel's own page, and
 * `server.invoke` for one with background work of its own,
 * `integrations` for a panel the captain added or made, whose calls the core
 * checks against its own manifest, and `keys.clicked`, a mouse click on one
 * of its controls marked with one of its own commands, for the key reminder
 * (docs/keyboard.md, "The key reminder"). The frame's
 * controller refuses any other id, and each handler checks its value like
 * any input from a panel.
 *
 * A page drawn for a crewmate's build (`draft`, docs/personal-panels.md
 * "Built apart") is declared the same actions bound apart: its rail is its
 * own out-of-sight copy's, its cards reach no stack, and its pointing and
 * moves never count, since no click or key of the captain's is ever on it.
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
  /** Its background work, which `invoke` reaches; absent for a panel with none. */
  server?: (action: string, input: unknown) => Promise<unknown>;
  /**
   * Its calls on the captain's integrations (docs/integrations.md,
   * "Panels"); absent for one of the app's own, which reaches none.
   */
  integrations?: (request: PanelIntegrationsRequest) => Promise<unknown>;
  /** Hears how the panel's body fared on its own page (`panel.body`). */
  onBody?: (said: PanelBodySaid) => void;
  /** Drawn for a crewmate's build, out of the captain's sight, under this id. */
  draft?: { id: string };
};

/** What `panel.body` takes: the body drew, or stopped and why. */
const panelBodySaidSchema: z.ZodType<PanelBodySaid> = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("drawn") }),
  z.strictObject({ state: z.literal("stopped"), why: z.string() }),
]);

/** What `keys.clicked` takes: the command's id in the panel's manifest. */
const keyClickSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(PANEL_COMMAND_ID_MAX);

/** What `server.invoke` takes: the action's name, and its input. */
const serverCallSchema = z.strictObject({
  action: z.string().min(1).max(64),
  input: z.unknown().optional(),
});

/** A draft's cards: what it would put up reaches no stack. */
async function draftCardAction(id: string, value: unknown): Promise<unknown> {
  if (id === "cards.emit") {
    const card = value as { id?: unknown; view?: unknown } | null;
    return typeof card?.id === "string" ? card.id : String(card?.view ?? "");
  }
  if (id === "cards.open") return [];
  return undefined;
}

/** A draft is out of the captain's sight: no click or key of the captain's is ever on it. */
const never = async () => false;

export function framePanelActions(page: FramePanelPage): {
  actions: readonly string[];
  onAction: (id: string, value: unknown) => Promise<unknown>;
} {
  const { panel, frame, card, draft } = page;
  // The captain's own click or key holds this page only while its frame holds the window's focus.
  const gate = draft ? never : () => frameHoldsFocus(frame);
  const cardActions = draft ? draftCardAction : framePanelCardAction(panel.id, frame, card);
  const points = page.reads.includes("tasks.board");
  // Where its rail, pointing and moves are kept: its own panel's, or its draft's copy.
  const drawn = draft?.id ?? panel.id;
  const point = framePointAction(
    panelPoint(drawn, {
      reads: page.reads,
      ...(card === undefined ? {} : { card }),
      gate,
      frame,
    }),
  );
  const tasks = frameTasksAction(panelTasks(panel, gate));
  const rail = frameRailAction(drawn, page.decides);
  const { server, onBody, integrations } = page;
  const onPage = card === undefined;
  const actions = [
    ...(card === undefined ? PANEL_CARD_ACTIONS : PANEL_CARD_VIEW_ACTIONS),
    ...(points ? PANEL_POINT_ACTIONS : []),
    ...(page.reads.includes("feed.recent") ? [PANEL_LINE_PEEK_ACTION] : []),
    PANEL_DRAFT_ACTION,
    PANEL_OPEN_SETTINGS_ACTION,
    ...(page.moves ? PANEL_TASKS_ACTIONS : []),
    ...(onPage ? PANEL_RAIL_ACTIONS : []),
    ...(onPage && onBody ? [PANEL_BODY_ACTION] : []),
    ...(server ? [PANEL_SERVER_ACTION] : []),
    ...(integrations ? [PANEL_INTEGRATIONS_ACTION] : []),
    // A draft is out of the captain's sight: no click of the captain's is ever on it.
    ...(draft ? [] : [PANEL_KEY_CLICK_ACTION]),
  ];
  return {
    actions,
    onAction: async (id, value) => {
      if (id === PANEL_SERVER_ACTION && server) {
        const call = serverCallSchema.parse(value);
        return server(call.action, call.input);
      }
      if (id === PANEL_INTEGRATIONS_ACTION && integrations) {
        return integrations(panelIntegrationsRequestSchema.parse(value));
      }
      if (id === PANEL_KEY_CLICK_ACTION && !draft) {
        const command = keyClickSchema.parse(value);
        // The click was the captain's own only while the page's frame holds the window's focus.
        if (await gate()) remindOfPanelClick(panel.id, command);
        return undefined;
      }
      if (id === PANEL_BODY_ACTION && onBody) {
        onBody(panelBodySaidSchema.parse(value));
        return undefined;
      }
      if (id.startsWith("point.")) return point(id, value);
      if (id.startsWith("tasks.")) return tasks(id, value);
      if (id.startsWith("rail.")) return rail(id, value);
      return cardActions(id, value);
    },
  };
}
