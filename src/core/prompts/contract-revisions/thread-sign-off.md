# A crewmate's line can sign an answer off

INF-2845, the captain's direction A: "the crewmate marks a reply that says you are done, in any words, as closing, and a seen answer is never asked for again".
On INF-2790 the captain wrote under a crewmate's answering decision that they would take it from there and closed the card.
A decision closed without a choice answered nothing, so the crewmate's finished report was refused, its card came back, and once the task ended the first mate was asked for the missing answer and wrote a note of its own.

What the crew is now told:

- The crewmate thread steer's preamble says when to mark a line: when the captain's words, however put, say they need nothing more from the answer and ask, correct or approve nothing, the crewmate answers naming `answers_message` with `signs_off` true.
- The crewmate `reply` tool has a top-level `signs_off` parameter that says only what the mark does: it closes the answer as Done does.
  The host refuses the mark, with its reason and writing nothing, on a merge, a write, a card still asking, an interim line, or anything but the crewmate's own answering card of an answer task.
- `CARD_REPLY`'s "Replies resolve nothing" sentence, read by every persona, now names the `signs_off` exception.
- The `reply` tool's description no longer repeats how to revise a card with the answer as its reply, which `CARD_REPLY` already says to every persona; it keeps only that a line is never a card or actions.

What the host now does without a new word: once a message's work has ended, an answering crewmate card the captain saw since the message is its answer, so the crewmate's finished report is not refused, the first mate's answer-missing wake does not go out and no closing note goes up.

Homes: the judgment is the thread steer's alone, the effect the parameter's, and `CARD_REPLY` only names the exception.
No word, test or rule names a phrase: the crewmate judges what the captain's words mean.

The trim pays for the parameter: the crewmate's fixed context shrinks by about nine tokens net, and the first mate's grows by about three.
