# One answer for each reply under a card

INF-5202, the plan the captain approved after the first mate answered one reply under its own card three times: twice in the thread and once more in the card's body.
Its first answer was right and named the message, but the answer-delivery check counted the write as a card shown again, found nothing new shown, and sent the answer-missing wake.
That wake offered two places to answer, and the first mate used both.

What the first mate is now told:

- The `emit_card` receipt for a write on its own card that adds a thread line keeps "Card shown: title (id)" and says what the line did: it answers the captain's message N; it is a comment because someone had already answered N (who, and their opening words); or the captain's message N is still open because the line named no message.
  Its one home is the receipt (`cardMutationText.ts`, the words the shared-card receipt already uses).
- The answer-missing wake for a reply under the first mate's own card names one place: that card's thread, with the card's id and the captain's message number, and says to change the card only when the answer changes what it says.
  A wake about a refused card, or about a message not under a card, says what it said before.
  Its one home is the `answer-missing` wake in `captainWakes.ts`.
- `CARD_REPLY`, read by every persona, gains one sentence: the thread line is the answer, the card's body never repeats it, and one answer is written once.

What the host now does without a new word: a write on the first mate's own card that leaves the card as it was and adds a thread line is counted as a reply on that card, named or not, as a line on someone else's card already is, so the answer-missing wake does not go out after it.

The fixed context grows by about eighteen tokens, the `CARD_REPLY` sentence; the receipt and wake words are served only with their write or wake.
