import * as m from "@shared/i18n/messages.generated";
import { holdsWords } from "@shared/overlayDraft";
import { useCallback, useEffect, useRef, useState } from "react";
import { cardStage } from "../app/cardStage";
import { focusLanding } from "../app/focusLanding";
import { guardLostFocus } from "../app/focusRecovery";
import { guardHeldPresses } from "../app/heldKeys";
import { mainDraftOf } from "../app/lendDraft";
import { followNotTypingKeys } from "../app/notTypingKeys";
import { followShellCommands } from "../app/shellCommands";
import { shownEntry, stackOf } from "../app/stack";
import { CardLayer, HOLD_LIMIT_MS } from "../app/stage/CardLayer";
import { useShellStore } from "../app/store";
import { closeCardFind, useCardFind } from "../cards/cardFind";
import { focusWithRing } from "../design/focus";
import { guardFrameActivation } from "../plugins/frames/frameActivation";
import { giveHandedFocusBack, guardFrameFocus } from "../plugins/frames/frameFocus";
import { OverlayMessage } from "./OverlayMessage";
import { settleOverlayDrafts, startOverlayStore, takeLentDraft } from "./overlayStart";
import { overlayTarget } from "./overlayTarget";
import "./overlay.css";

/** The panel's own clear area, where a click belongs to the app behind it: the page and the stack's empty boxes around the card and its pager. */
const CLEAR =
  "html, body, #root, [data-card-overlay-root], [data-stage], [data-card-layer], [data-card-layer-leaving], [data-card-envelope], [data-card-slot], [data-card-pager]";

/**
 * What the panel holds: its first reads, the cards and the message box, or
 * the word that the first reads failed, so nothing can be shown.
 */
type Phase = "starting" | "cards" | "nothing";

/**
 * The card overlay's page (docs/card-overlay.md): the card stack and the
 * first mate's message box, in a panel over the app in front. It shows the
 * card the newest notification was about, or the box alone when no card
 * waits; stays while cards wait or the box holds words; gives the keys back
 * once the last card closes or Escape leaves; and sends its unsent words,
 * and the window's message, back before it goes.
 */
export function CardOverlay() {
  // A card that closes here takes focus with it: it lands on the next card, as in the window.
  useEffect(() => {
    const landing = focusLanding();
    const stopGuard = guardLostFocus(giveHandedFocusBack, landing);
    return () => {
      stopGuard();
      landing.stop();
    };
  }, []);
  useEffect(() => guardFrameFocus(), []);
  useEffect(() => guardFrameActivation(), []);
  useEffect(() => guardHeldPresses(), []);
  useEffect(() => followShellCommands(), []);
  useEffect(() => followNotTypingKeys(), []);
  const [phase, setPhase] = useState<Phase>("starting");
  const [revealed, setRevealed] = useState(false);
  // No card on the stack: the message box stands alone (the captain's pick on INF-7222's plan).
  const alone = useShellStore((s) => stackOf(s).length === 0);
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
      .then(([, { cardId, lent }]) => {
        takeLentDraft(lent);
        const state = useShellStore.getState();
        const target = overlayTarget(stackOf(state), shownEntry(state)?.id, cardId);
        if (target !== null) state.focusCard(target);
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
      // With no card, the box alone is ready once drawn.
      const entry = useShellStore.getState().cardsSnapshotLoaded
        ? stackOf(useShellStore.getState()).length === 0
          ? document.querySelector<HTMLElement>("[data-overlay-message]")
          : document.querySelector<HTMLElement>('[data-stage-entry="shown"]')
        : null;
      if (entry && !entry.inert) requestAnimationFrame(() => requestAnimationFrame(tell));
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    // The stack's own hold limit: past it the stack shows the entry as it is, so the panel does too.
    const limit = setTimeout(tell, HOLD_LIMIT_MS);
    check();
    return () => {
      done = true;
      observer.disconnect();
      clearTimeout(limit);
    };
  }, [phase]);

  // Only a stack with nothing left gives the keys back: a card that closes
  // here brings up the next by the stack's own rule (the captain, INF-7222).
  // The last card closing leaves only while the box holds nothing unsent, so
  // the overlay never goes while words wait; it then stays as the box alone,
  // as when the key opened it with no card.
  useEffect(
    () =>
      useShellStore.subscribe((state, before) => {
        if (phase !== "cards" || !state.cardsSnapshotLoaded) return;
        const emptied = stackOf(state).length === 0 && stackOf(before).length > 0;
        if (emptied && !holdsWords(mainDraftOf(state))) leave();
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

  // A card made large takes the display's width, the plan's deliberate expansion of wide content;
  // the stack marks it on the page's root (CardLayer).
  useEffect(() => {
    const root = document.documentElement;
    let wide = false;
    const follow = () => {
      const now = root.hasAttribute("data-card-maximized");
      if (now === wide) return;
      wide = now;
      void window.infinitary.cardOverlay.wide(now);
    };
    const observer = new MutationObserver(follow);
    observer.observe(root, { attributes: true, attributeFilter: ["data-card-maximized"] });
    follow();
    return () => observer.disconnect();
  }, []);

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
          <div data-stage="" tabIndex={-1}>
            <CardLayer onEmptied={() => {}} />
          </div>
          {/* After the stage, so Tab reaches it after the card's controls, and the
              card and pager, its anchors (overlay.css), come first in the page. */}
          <OverlayMessage alone={alone} />
          {/* After the stage and the box: the card, or the box alone, is the hide
              button's anchor, and an anchor must come first in the page. Tab
              reaches it last. */}
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
