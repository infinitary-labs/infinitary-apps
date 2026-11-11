import type { Card } from "@shared/cards";
import { readsSeenUpdate } from "@shared/contractFeatures";
import type { FirstmateApi } from "@shared/windowApi";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";

/** Whether the window is in front of the captain: visible, and focused. */
function windowPresent(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Whether `event` is a frame's bridge saying its own window gained or lost
 * the focus (frameScript.ts). The window coming back to the front while the
 * focus sits inside a card's body gives that frame the focus, and the
 * window's own page hears no focus of its own.
 */
function frameFocusNotice(event: MessageEvent): boolean {
  const data: unknown = event.data;
  return typeof data === "object" && data !== null && "type" in data && data.type === "focused";
}

/** Choose only a request the home advertised; legacy reports keep their two arguments. */
export async function reportDrawnUpdate(
  card: Pick<Card, "id" | "offerId" | "lifecycleId" | "currentUpdateId">,
  home: { protocolVersion?: string; changes?: readonly string[] },
  reporter: Pick<FirstmateApi["cards"], "seen" | "seenUpdate">,
): Promise<void> {
  if (readsSeenUpdate(home.protocolVersion, home.changes)) {
    if (card.lifecycleId && card.currentUpdateId)
      await reporter.seenUpdate(card.id, card.lifecycleId, card.currentUpdateId);
  } else if (card.offerId) {
    await reporter.seen(card.id, card.offerId);
  }
}

/** Report only the exact released update that actually drew in a foreground view. */
export function useSeenReport(card: Card | undefined, drawn: boolean): void {
  const [present, setPresent] = useState(windowPresent);
  const loaded = useShellStore((s) => s.cardsSnapshotLoaded);
  const mac = useShellStore((s) => s.thisMac);
  const reachable = mac?.role !== "view" || mac.contact === "in-reach";
  useEffect(() => {
    const update = () => setPresent(windowPresent());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 0);
    };
    const notice = (event: MessageEvent) => {
      if (frameFocusNotice(event)) settle();
    };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", settle);
    window.addEventListener("message", notice);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", settle);
      window.removeEventListener("message", notice);
    };
  }, []);
  const id = card?.id;
  const offerId = card?.offerId;
  const lifecycleId = card?.lifecycleId;
  const updateId = card?.currentUpdateId;
  useEffect(() => {
    if (!present || !drawn || !loaded || !reachable || !id || !offerId) return;
    let cancelled = false;
    // The healthcheck reaches the owner, not this window's build. Older homes omit changes.
    void window.infinitary.app
      .healthcheck()
      .then(async (home) => {
        if (cancelled || !windowPresent()) return;
        await reportDrawnUpdate(
          { id, offerId, lifecycleId, currentUpdateId: updateId },
          home,
          window.infinitary.cards,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [present, drawn, loaded, reachable, id, offerId, lifecycleId, updateId]);
}
