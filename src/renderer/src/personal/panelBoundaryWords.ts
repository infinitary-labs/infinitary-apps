/**
 * What a panel shows when its code stopped drawing - a thrown render, or a
 * module that would not load - in the frame realm every panel draws in
 * (src/renderer/src/frameRealm/).
 * One quiet line in the design system's words for a body that stopped
 * answering; the host's chrome around it stays (`panelBoundary.tsx`).
 */
export const PANEL_STOPPED_LINE = "This panel stopped drawing.";
/**
 * What the host draws above a panel whose background work it stopped
 * (INF-2205 piece B, docs/personal-panels.md "A stopped panel"), beside a
 * Retry: the panel may still draw, but what it fetches or computes in the
 * background has stopped until the captain retries it.
 */
export const BACKGROUND_STOPPED_LINE = "This panel's background work stopped responding.";
export const BACKGROUND_EXITED_LINE = "This panel's background work stopped.";
/** The button beside either line that starts the background work again. */
export const BACKGROUND_RETRY = "Retry";
/**
 * A panel whose background work the app refused before it ran, because it
 * is written for an earlier panel API (INF-2470): the panel still draws, and
 * Update panel asks the first mate to update its code.
 */
export const BACKGROUND_PAUSED_LINE =
  "This panel's background work is paused: it was made for an earlier version of the app.";
/** The button beside it that starts the update. */
export const BACKGROUND_UPDATE = "Update panel";
/** The same line for one of a panel's cards on the stack (docs/ui-plugins.md, "A panel's cards"). */
export const CARD_STOPPED_LINE = "This card stopped drawing.";
/**
 * A panel's integration call that waits on the captain's approval card, or
 * that he turned down (docs/integrations.md, "Panels"): one line each above
 * the panel, beside Ask again, which shows the card again or raises it anew.
 */
export function integrationAskLine(label: string, place: string, state: "asking" | "declined") {
  return state === "asking"
    ? `This panel asks to ${lowerFirst(label)} on ${place}. Its approval card is up.`
    : `You chose Not now when this panel asked to ${lowerFirst(label)} on ${place}.`;
}
/** The button beside it. */
export const INTEGRATION_ASK_AGAIN = "Ask again";

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;
}
