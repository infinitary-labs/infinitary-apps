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
/** The same line for one of a panel's cards on the stack (docs/ui-plugins.md, "A panel's cards"). */
export const CARD_STOPPED_LINE = "This card stopped drawing.";
