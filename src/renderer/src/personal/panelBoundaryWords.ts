/**
 * What a panel shows when its code stopped drawing - a thrown render, or a
 * module that would not load - in either realm: the app's own window
 * (PersonalPanelBody) and the frame realm (src/renderer/src/frameRealm/).
 * One quiet line in the design system's words for a body that stopped
 * answering; the host's chrome around it stays (`panelBoundary.tsx`).
 */
export const PANEL_STOPPED_LINE = "This panel stopped drawing.";
/** The same line for one of a panel's cards on the stack (docs/ui-plugins.md, "A panel's cards"). */
export const CARD_STOPPED_LINE = "This card stopped drawing.";
