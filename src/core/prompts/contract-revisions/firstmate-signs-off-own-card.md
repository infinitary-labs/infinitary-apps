# The first mate can sign off its own card

INF-6317 part 1, from the captain's ask to "figure out why it didn't count the earlier card interactions as answer to my message".
The first mate showed an answering decision for a cut-off message.
The captain never pressed its buttons; they wrote under it, and later wrote that it could close.
The first mate answered in the thread and called `close_card`, which records its own withdrawal and answers nothing, so the message the card was shown for read as missing and the app raised its "has not answered your message" notice.
A crewmate already had `signs_off` for this case (INF-2845); the first mate had no such mark on its own cards.

What the first mate is now told:

- `emit_card` has a top-level `signs_off` parameter for the first mate alone, which says only what the mark does: with a reply alone and `answers_message` on its own card it ends the card as read, as Done does, so the message it answers counts it; `close_card` withdraws a card and answers nothing.
  The host refuses the mark, with its reason and writing nothing, on anyone else's card, a card no longer on the stack, a card still asking or continuing, one carrying a merge, a settle, a write request or a browser hand-off, or a line not naming the captain message the card waits on.
  A mark beside a body is refused: it goes on a reply alone.
- The `about:` line of a turn the captain wrote under the first mate's own card adds when to mark the answer: when their words, however put, say they need nothing more from the card and ask, correct or approve nothing, it passes `signs_off` true with that reply instead of `close_card`.
- `close_card`'s answer about a message left with no answering card adds what follows: unless it gets an answer this turn, the app asks the first mate once more when the turn ends, or shows the captain its notice if it already asked.

Homes: the judgment is the `about:` line's alone, served only on a turn about the first mate's own card; the effect is the parameter's; the consequence is `close_card`'s answer, served only when a close leaves a message without an answer.
No word, test or rule names a phrase: the first mate judges what the captain's words mean.

The parameter adds about forty tokens to the first mate's fixed context; the other words are served only on the turns they apply to.
