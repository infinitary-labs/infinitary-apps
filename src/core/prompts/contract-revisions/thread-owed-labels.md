# Thread activity says what each card waits on now

FI3-359, filed by the crewmate that repaired FI3-355: the Firstmate's "thread activity since your last turn" section still labelled a line "awaiting the author" whenever the captain wrote last, even when that card had been withdrawn and raised again under its id, or closed.
FI3-355 had already moved the whose-turn rule and the idle ladder onto the card's current `answer` hold; this section was the one reader left inferring an obligation from historical messages.
Each line of the section now ends with who owes an answer now, from `CardService`'s typed `ThreadOwed` over the same hold: `awaiting the author`, `awaiting your answer` when the Firstmate is the one that answers (its own card, or a note a done task kept), `no answer owed` on an open card without the hold, or `card closed, no answer owed`.
The old `answered` ending is gone: who wrote last is already on the line.
The section's heading adds that each line ends with what its card waits on now, not who wrote last.
The fixed part of the contract is unchanged; by the app's count a context block that carries the section grows by about 17 tokens for the heading and up to 5 for each line that changed ending.

The ledger entry that comes with it:

FI3-359. The context block's thread activity lines end with who owes an answer now (awaiting the author, awaiting your answer, no answer owed, card closed, no answer owed), read from the card's current answer hold, never from who wrote last.
