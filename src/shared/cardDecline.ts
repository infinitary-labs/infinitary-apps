import { DECLINE_ACTION_ID, DECLINE_LABEL } from "./cardLeave.ts";
import { type Card, type CardAction, cardPresentation, mergeEffectOf } from "./cards.ts";

/**
 * The app's Decline on a decision (INF-3108): a first mate's or crewmate's
 * decision with no choice marked as its way to say no gets one more
 * action, drawn quiet at the footer's left, that answers no to every
 * choice. A merge card keeps its own buttons, and the app's own cards are
 * attentions, never decisions. The core adds it to the card it shows, so
 * every view draws the same thing; the saved card never holds it.
 */
export function appDeclineOf(card: Pick<Card, "author" | "actions">): CardAction | undefined {
  if (cardPresentation(card) !== "decision") return undefined;
  const ownWayOut = card.actions.some(
    (action) => action.declines || action.id === DECLINE_ACTION_ID || mergeEffectOf(action),
  );
  if (ownWayOut) return undefined;
  return { id: DECLINE_ACTION_ID, label: DECLINE_LABEL, variant: "ghost", declines: true };
}

/** The card as shown, with the app's Decline when it takes one (`appDeclineOf`). */
export function withAppDecline<C extends Pick<Card, "author" | "actions">>(card: C): C {
  const decline = appDeclineOf(card);
  return decline ? { ...card, actions: [...card.actions, decline] } : card;
}
