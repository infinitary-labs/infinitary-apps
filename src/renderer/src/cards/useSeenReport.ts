import { useEffect, useState } from "react";

/** Whether the window is in front of the captain: visible, and focused. */
function windowPresent(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Tells the core which version of the shown card the captain has in front
 * of them (docs/card-authoring.md "What changed since you looked"): the
 * card on the stage while the window is visible and focused - focus in a
 * card's own frame counts. The core records it once per version and
 * compares the card's next revision with it, so revisions that land while
 * the window is away accumulate.
 */
export function useSeenReport(cardId: string | undefined, offerId: string | undefined): void {
  const [present, setPresent] = useState(windowPresent);
  useEffect(() => {
    const update = () => setPresent(windowPresent());
    // Focus moving into a card's frame blurs the window before the frame
    // holds it; read again once it has settled.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 0);
    };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", settle);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", settle);
    };
  }, []);
  useEffect(() => {
    if (!present || !cardId || !offerId) return;
    void window.infinitary.cards.seen(cardId, offerId).catch(() => {});
  }, [present, cardId, offerId]);
}
