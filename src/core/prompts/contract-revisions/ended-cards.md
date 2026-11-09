# An ended card stays up for the captain

INF-3071, the captain's approved plan: a card its author ends after the captain has seen it stays on their screen, marked ended, with the author's reason in its thread and one Close, for crewmates and the first mate alike.
The record still ends the card at once, so nothing else the first mate reads changes.
`close_card`'s `reason` now asks why the author ended the card, in one plain line for the captain, since a card they have seen shows that line in its thread.
Its answer, for a card the captain had seen, adds that the card stays on their screen marked ended, with that reason, until they close it (`ENDED_STAYS`).
The rule's one home is that parameter's description; the answer only reports what happened.
The fixed context grows by about ten tokens, the longer parameter description.
