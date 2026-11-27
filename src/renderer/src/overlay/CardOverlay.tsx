import * as m from "@shared/i18n/messages.generated";
import { useCallback, useEffect, useRef, useState } from "react";
import { cardStage } from "../app/cardStage";
import { guardHeldPresses } from "../app/heldKeys";
import { followNotTypingKeys } from "../app/notTypingKeys";
import { followShellCommands } from "../app/shellCommands";
import { shownEntry, stackOf } from "../app/stack";
import { CardLayer } from "../app/stage/CardLayer";
import { useShellStore } from "../app/store";
import { closeCardFind, useCardFind } from "../cards/cardFind";
import { focusWithRing } from "../design/focus";
import { guardFrameActivation } from "../plugins/frames/frameActivation";
import { guardFrameFocus } from "../plugins/frames/frameFocus";
import { settleOverlayDrafts, startOverlayStore } from "./overlayStart";
import { overlayTarget } from "./overlayTarget";
import "./overlay.css";

/**
 * How long the shown card may take to be ready before the panel shows it
 * as it is: the stack's own hold limit (`HOLD_LIMIT_MS` in CardLayer).
 */
const READY_LIMIT_MS = 1_500;

/** The panel's own clear area, where a click belongs to the app behind it. */
const CLEAR = "html, body, #root, [data-card-overlay-root], [data-stage]";

/** What the panel holds: its first reads, a card to answer, or the word that none waits. */
type Phase = "starting" | "cards" | "nothing";

/**
 * The card overlay's page (docs/card-overlay.md): the card stack alone, in
 * a panel over the app in front. It shows the card the newest notification
 * was about, gives the keys back once a choice is made or Escape leaves, and
 * sends its unsent words before it goes.
 */
export function CardOverlay() {
  useEffect(() => guardFrameFocus(), []);
  useEffect(() => guardFrameActivation(), []);
  useEffect(() => guardHeldPresses(), []);
  useEffect(() => followShellCommands(), []);
  useEffect(() => followNotTypingKeys(), []);
  const [phase, setPhase] = useState<Phase>("starting");
  const [revealed, setRevealed] = useState(false);
  const leaving = useRef(false);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    void settleOverlayDrafts()
      .catch(() => {})
      .finally(() => void window.infinitary.cardOverlay.hide());
  }, []);

  useEffect(() => window.infinitary.cardOverlay.onLeave(leave), [leave]);

  // The first reads, then the card to show: the notified one while it asks.
  useEffect(() => {
    void Promise.all([startOverlayStore(), window.infinitary.cardOverlay.start()])
      .then(([, { cardId }]) => {
        const state = useShellStore.getState();
        const target = overlayTarget(stackOf(state), shownEntry(state)?.id, cardId);
        if (target === null) {
          setPhase("nothing");
          void window.infinitary.cardOverlay.ready(false).then(() => setRevealed(true));
          return;
        }
        state.focusCard(target);
        setPhase("cards");
      })
      .catch(() => {
        setPhase("nothing");
        void window.infinitary.cardOverlay.ready(false).then(() => setRevealed(true));
      });
  }, []);

  // The card is ready once its entry is shown and live, or at the hold limit.
  useEffect(() => {
    if (phase !== "cards") return;
    let done = false;
    const tell = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(limit);
      void window.infinitary.cardOverlay.ready(true).then(() => setRevealed(true));
    };
    const check = () => {
      const entry = document.querySelector<HTMLElement>('[data-stage-entry="shown"]');
      if (entry && !entry.inert) requestAnimationFrame(() => requestAnimationFrame(tell));
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const limit = setTimeout(tell, READY_LIMIT_MS);
    check();
    return () => {
      done = true;
      observer.disconnect();
      clearTimeout(limit);
    };
  }, [phase]);

  // A choice made here, or a stack with nothing left, gives the keys back.
  useEffect(
    () =>
      useShellStore.subscribe((state, previous) => {
        if (phase !== "cards") return;
        const answered = Object.keys(previous.pendingCardActions).some(
          (id) =>
            !state.pendingCardActions[id] &&
            !state.cardActionErrors[id] &&
            !state.cards.some((card) => card.id === id),
        );
        if (answered || (state.cardsSnapshotLoaded && stackOf(state).length === 0)) leave();
      }),
    [phase, leave],
  );

  // Escape leaves the control it is in first, then the overlay, answering nothing.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (useCardFind.getState().open) {
        closeCardFind();
        return;
      }
      const stage = cardStage();
      if (stage?.maximized) {
        stage.toggleSize();
        return;
      }
      const card = document.querySelector<HTMLElement>('[data-stage-entry="shown"]');
      const active = document.activeElement;
      if (card && active instanceof HTMLElement && active !== card && card.contains(active)) {
        focusWithRing(card, { preventScroll: true });
        return;
      }
      leave();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [leave]);

  // Off the card, the panel's clear area lets the pointer through to the app behind.
  useEffect(() => {
    let over = false;
    const move = (event: MouseEvent) => {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const now = under !== null && !under.matches(CLEAR);
      if (now === over) return;
      over = now;
      void window.infinitary.cardOverlay.pointer(now);
    };
    const out = () => {
      if (!over) return;
      over = false;
      void window.infinitary.cardOverlay.pointer(false);
    };
    window.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", out);
    return () => {
      window.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", out);
    };
  }, []);

  return (
    <div data-card-overlay-root="" data-revealed={revealed ? "" : undefined}>
      {phase === "cards" && (
        <>
          <button
            type="button"
            data-card-overlay-hide=""
            aria-label={m.cardOverlayHide()}
            title={m.cardOverlayHide()}
            onClick={leave}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <div data-stage="" tabIndex={-1}>
            <CardLayer onEmptied={() => {}} />
          </div>
        </>
      )}
      {phase === "nothing" && (
        <div data-card-overlay-nothing="" role="status">
          {m.cardOverlayNothing()}
        </div>
      )}
    </div>
  );
}
