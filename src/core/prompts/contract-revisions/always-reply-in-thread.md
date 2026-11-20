# Always reply in the thread

FI3-1760's accepted plan (way B), built under FI3-1761: every captain reply under a card gets a short thread answer from its author, revised card or not.
`emit_card` gains one top-level parameter, `reply` (one to three sentences), for the Firstmate and every crewmate on both runtimes.
While the captain's reply waits on the author, a revision under that card's id without `reply` is refused as tool text, and the card and thread stay unchanged.
With `reply`, the thread shows the host's `revised:` line and then the author's answer.
`CARD_REPLY`, the thread steer preamble, the idle thread nudge and the `reply` tool description now say to always answer, and also revise when the card should change.
The fixed context grows by about 50 tokens, inside the existing ceiling.
