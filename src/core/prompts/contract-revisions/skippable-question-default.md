# A question the captain may skip names what a skip sends

INF-4425 builds direction A of INF-4422's plan, the captain's approval with these choices: a cyan ring, direction A, a skip recorded with its default, and a card refused when a skippable question marks no option.
The captain asked that a question they may skip tag its marked option Default rather than Recommended, and that the footer count the defaults a click would send.
`CARD_AUTHORING`'s questions paragraph now says that a question not marked required may be skipped, that a skip sends its `data-inf-recommended` option, which the app tags Default, and that the author leaves a question optional only when it would act on that option without asking, and marks one.
In the host, the card lint refuses a decision whose skippable radio or select question marks no option (`unmarkedSkippableQuestions`), naming both fixes: mark one option, or make the question required.
`cardAnswerLines` words a skipped question's answer `skipped, default "Wide" (wide), as proposed` from the answer's own `skipped` mark, which the frame sets with the Default it sent (`card-answer-skipped`).
The new words cost the fixed part about 45 tokens by the app's count.

The ledger entry that comes with it:

INF-4425's build of INF-4422 direction A.
CARD_AUTHORING: a question not marked required may be skipped and a skip sends its data-inf-recommended option, tagged Default; an author leaves a question optional only when it would act on that option without asking, and marks one.
The lint refuses a skippable radio or select question that marks none.
