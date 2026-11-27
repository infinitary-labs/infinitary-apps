import type { Card } from "@shared/cards";
import { readsSeenUpdate } from "@shared/contractFeatures";
import type { FirstmateApi } from "@shared/windowApi";
import { useEffect, useState } from "react";
import { usePresence } from "../ambient/presence";
import { useShellStore } from "../app/store";

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

/**
 * INF-7038's plan, Part 1: a touch this long before an update drew still
 * counts as someone being there to see it.
 */
export const TOUCHED_BEFORE_MS = 10_000;

/** How often a report that waits for a touch asks the system again. */
export const ASK_IDLE_EVERY_MS = 2_000;

/** How the page learns that this computer was touched. */
export type Touches = {
  now: () => number;
  /** Seconds since this computer's keyboard or mouse was last touched, as the system reads it. */
  idleSeconds: () => Promise<number>;
  /** When this window last heard a key or the pointer, which the page knows before the system's next reading. */
  lastWindowTouch: () => number;
  onWindowTouch: (listener: () => void) => () => void;
};

/**
 * Calls `report` once while someone is at this computer, for an update drawn
 * at `drawnAt` in a visible, focused window (docs/card-authoring.md, "Seen"):
 * never while an away reason holds, and only once the computer was touched
 * in the `TOUCHED_BEFORE_MS` before the drawing or any time after it. A
 * computer that cannot tell (`watched` false) reports at once. Returns a stop.
 */
export function reportWhileHere(
  presence: { away: boolean; watched: boolean },
  drawnAt: number,
  report: () => void,
  touches: Touches,
): () => void {
  if (!presence.watched) {
    report();
    return () => {};
  }
  if (presence.away) return () => {};
  const since = drawnAt - TOUCHED_BEFORE_MS;
  let done = false;
  let asking = false;
  let stopListening = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    done = true;
    stopListening();
    clearInterval(timer);
  };
  const touchedSince = (at: number) => {
    if (done || at < since) return;
    stop();
    report();
  };
  const check = () => {
    if (done) return;
    touchedSince(touches.lastWindowTouch());
    if (done || asking) return;
    asking = true;
    touches.idleSeconds().then(
      (seconds) => {
        asking = false;
        touchedSince(touches.now() - seconds * 1000);
      },
      () => {
        asking = false;
      },
    );
  };
  stopListening = touches.onWindowTouch(check);
  timer = setInterval(check, ASK_IDLE_EVERY_MS);
  check();
  return stop;
}

let lastWindowTouch = Number.NEGATIVE_INFINITY;
const windowTouchListeners = new Set<() => void>();
let followingTouches = false;

/** This window's own keys and pointer, and the system's reading for every other touch. */
const windowTouches: Touches = {
  now: () => Date.now(),
  idleSeconds: async () => (await window.infinitary.app.idle()).seconds,
  lastWindowTouch: () => lastWindowTouch,
  onWindowTouch: (listener) => {
    if (!followingTouches) {
      followingTouches = true;
      const touched = () => {
        lastWindowTouch = Date.now();
        for (const heard of [...windowTouchListeners]) heard();
      };
      for (const type of ["keydown", "pointerdown", "pointermove", "wheel"])
        window.addEventListener(type, touched, { capture: true, passive: true });
    }
    windowTouchListeners.add(listener);
    return () => windowTouchListeners.delete(listener);
  },
};

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

/** Report only the exact released update that actually drew in a foreground view while someone is there. */
export function useSeenReport(card: Card | undefined, drawn: boolean): void {
  const [present, setPresent] = useState(windowPresent);
  const presenceRead = usePresence((s) => s.read);
  const away = usePresence((s) => s.away);
  const watched = usePresence((s) => s.watched);
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
    if (!present || !drawn || !loaded || !reachable || !presenceRead || !id || !offerId) return;
    let cancelled = false;
    // The healthcheck reaches the owner, not this window's build. Older homes omit changes.
    const report = () =>
      void window.infinitary.app
        .healthcheck()
        .then(async (home) => {
          if (cancelled || !windowPresent()) return;
          // INF-4541: the sighting reads at once (the intent table's `seen`), so "N new" walks on
          // before the owner's mark comes back; one the owner did not take leaves the card new.
          const intent =
            readsSeenUpdate(home.protocolVersion, home.changes) && lifecycleId && updateId
              ? useShellStore.getState().seeUpdate({ id, lifecycleId, currentUpdateId: updateId })
              : undefined;
          try {
            await reportDrawnUpdate(
              { id, offerId, lifecycleId, currentUpdateId: updateId },
              home,
              window.infinitary.cards,
            );
          } catch (error) {
            if (intent) useShellStore.getState().unseeUpdate(intent);
            throw error;
          }
        })
        .catch(() => {});
    // Each change to presence or the window's front draws the update anew, from now.
    const stop = reportWhileHere({ away, watched }, Date.now(), report, windowTouches);
    return () => {
      cancelled = true;
      stop();
    };
  }, [
    present,
    drawn,
    loaded,
    reachable,
    presenceRead,
    away,
    watched,
    id,
    offerId,
    lifecycleId,
    updateId,
  ]);
}
