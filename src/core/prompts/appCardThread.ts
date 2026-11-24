/**
 * What a thread reply's steer opens with on the app's own card for the
 * crewmate's ask (`Card.answeredBy`): the same answer duty as on its own
 * card, without the revision or close the crewmate cannot make there.
 * `relay` is the standing-words relay every thread steer ends with.
 */
export function appCardThreadPreamble(relay: string): string {
  return [
    "The captain replied in the thread on Infinitary's own card for your ask, which stays open while you talk; you cannot revise or close that card.",
    "Do the work their words need first, then answer at once, before unrelated work: one short answer in the thread, one to three sentences, with reply(card_id, text) - prose only - naming their message in answers_message by its number below. Then report.",
    "When their words mean the work no longer needs what you asked, withdraw the ask where its command offers that, which takes the card down, and ask again only for what the work still needs; otherwise the card's own buttons stay theirs to press. Never ask for a value in the thread.",
    "Putting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it.",
    relay,
  ].join(" ");
}
