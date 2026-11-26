import * as m from "@shared/i18n/messages.generated";

/*
 * The words a panel's boundary and the details of its status mark show, from
 * the catalog (docs/i18n.md). The window words each one when it draws it, by
 * calling its message; the constants below are those words as the process
 * speaks them when this module loads - English for the end-to-end journeys
 * that read them.
 */

/**
 * What a panel shows when its code stopped drawing - a thrown render, or a
 * module that would not load - in the frame realm every panel draws in
 * (src/renderer/src/frameRealm/).
 * One quiet line in the design system's words for a body that stopped
 * answering; the host's chrome around it stays (`panelBoundary.tsx`).
 */
export const PANEL_STOPPED_LINE = m.panelStoppedLine();
/**
 * What the details of a panel's status mark say when the app stopped its
 * background work (INF-2205 piece B, docs/personal-panels.md "A stopped
 * panel"), beside a Retry: the panel may still draw, but what it fetches or
 * computes in the background has stopped until the captain retries it.
 */
export const BACKGROUND_STOPPED_LINE = m.panelBackgroundStopped();
export const BACKGROUND_EXITED_LINE = m.panelBackgroundExited();
export const BACKGROUND_RETRY = m.panelRetry();
/**
 * A panel whose background work the app refused before it ran, because it
 * is written for an earlier panel API (INF-2470): the panel still draws, and
 * Update panel asks the first mate to update its code.
 */
export const BACKGROUND_PAUSED_LINE = m.panelBackgroundPaused();
export const BACKGROUND_UPDATE = m.panelBackgroundUpdate();
/** The same line for one of a panel's cards on the stack (docs/ui-plugins.md, "A panel's cards"). */
export const CARD_STOPPED_LINE = m.panelCardStopped();
/**
 * A panel's integration call that waits on the captain's approval card, or
 * that they turned down (docs/integrations.md, "Panels"): one line each in the
 * details of its status mark, beside Ask again, which shows the card again
 * or raises it anew.
 */
export function integrationAskLine(label: string, place: string, state: "asking" | "declined") {
  const action = lowerFirst(label);
  return state === "asking"
    ? m.panelIntegrationAsking({ action, place })
    : m.panelIntegrationDeclined({ action, place });
}
export const INTEGRATION_ASK_AGAIN = m.panelIntegrationAskAgain();
/** A panel's reads that keep failing (docs/personal-panels.md, "Reads that keep failing"). */
export const FAILING_HEADING = m.panelFailingHeading();
export const FAILING_ASK = m.panelFailingAsk();
export const FAILING_LOOKING = m.panelFailingLooking();
export const MARK_STOPPED = m.panelMarkStopped();
export const MARK_PAUSED = m.panelMarkPaused();

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;
}
