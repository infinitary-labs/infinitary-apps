/**
 * The action ids a panel's frame asks its host through (`inf.action`), shared by every host that answers one: the
 * desktop window (`framePanelActions`, src/renderer/src/plugins/panelActions.ts) and the phone's panel page
 * (ios/Infinitary/CardRuntime/panelHost.ts). Data only, so a host imports the names without the window's own code.
 */

/** The ids a panel's or a card's frame raises its cards through (docs/ui-plugins.md, "A panel's cards"). */
export const PANEL_CARD_ACTIONS = ["cards.emit", "cards.close", "cards.open"] as const;

/** A card's own page also keeps its place (`card.keep`). */
export const PANEL_CARD_VIEW_ACTIONS = [...PANEL_CARD_ACTIONS, "card.keep"] as const;

/** The ids a panel's or a card's frame points through, for a panel that reads the board. */
export const PANEL_POINT_ACTIONS = [
  "point.openTask",
  "point.openRecord",
  "point.peekTask",
  "point.showCard",
  "point.aim",
  "point.focusProject",
] as const;

/** A feed reader's rest, independent of task-board pointing. */
export const PANEL_LINE_PEEK_ACTION = "point.peekLine";

/**
 * A mouse click on one of the page's controls marked with one of its own commands (`data-key-command`, which
 * `PanelProps.keys` carries), so the window shows that command's key reminder (docs/keyboard.md, "The key reminder").
 */
export const PANEL_KEY_CLICK_ACTION = "keys.clicked";
