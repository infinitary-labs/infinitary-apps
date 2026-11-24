/**
 * The words a model reads about what a card's field sent with a choice
 * (`src/shared/contract-changes/choice-attachments.md`). Served only to a
 * model, so English (docs/i18n.md, "What stays English").
 */

/** Leads what went with a choice in a wake. */
export const CARRIED_WITH_CHOICE_LEAD = "The captain sent this with the choice:";

/** Leads what went with the basis's closing choice in a builder's brief. */
export const BRIEF_CARRIED_LEAD = "What the captain sent with that choice:";

/**
 * What a crewmate reads of a button on the app's own card for its ask, before
 * what the captain wrote with it (`Card.answeredBy`).
 */
export const CARRIED_OUT_ASKER_WORDS =
  "That button is on Infinitary's own card for your ask: the app carries it out, and its outcome reaches you on its own. Read what the captain wrote with it as their words to you about the ask, and act on what it asks.";

/** What a first mate reads of a choice the app already carried out, before what went with it. */
export const CARRIED_OUT_WORDS =
  "The app already carried out this choice, and the card's author hears nothing of what the captain sent with it: read it as their words about this card, and act on what it asks.";
