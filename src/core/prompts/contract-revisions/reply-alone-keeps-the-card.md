# A first mate answer that leaves the body out keeps the card

INF-6128, from the captain asking why a card's body had been turned empty.
The first mate answered the captain under its own card, and `emit_card` required a body, so it resent one to carry the answer: it sent a placeholder, and the placeholder replaced the card's own body.
The first mate's `body` is now optional: a call that leaves it out writes `reply` alone in the thread of the card `id` names, through the same reply primitive a crewmate's `reply` tool uses, and the card stays as it is.
A call with no body that also leaves out `reply` or `id` is refused naming the fix, and nothing is shown.

The one home of the rule is the first mate's `body` parameter description: "Leave it out to write only reply; the card stays as it is."
The refusal holds the rest: it names `id` and `reply` as what a body-less call needs.
`CARD_REPLY` and the about line still say how to answer, unchanged.
The first mate's fixed context grows by 17 tokens, to 20,401 (`tests/firstmate-fixed-context.test.ts`); main already read 20,384 against its 19,772 budget, which a running trim task owns.
