import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";

/** Whether this page is the card overlay's, as its preload marked it (src/preload/index.ts). */
export function isCardOverlayPage(): boolean {
  // Read where no page draws too, such as a card action's unit test.
  return (
    typeof document !== "undefined" && document.documentElement.hasAttribute(CARD_OVERLAY_ATTRIBUTE)
  );
}
