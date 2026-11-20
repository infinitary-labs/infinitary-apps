# Standing override

INF-1216's accepted plan (direction A1) widens the captain's existing override so one reply carries their intent.
The captain chose: the first mate records it in the turn a crewmate's report starts, citing the reply; the words reach the holds and the crew's own consent asks; only the captain's words take it back; and the first mate may record it before any refusal.
`update_task`'s `override` parameter gains `from`, the card id the captain's reply sits under or `crewmate-tab`, and its description now says the first mate judges which holds the words pass and may record ahead of a refusal; its one home is that top-level parameter.
The host reads a cited message from the steer that carried it and refuses a card on another task, a card with no reply, or a citation in a scheduled check, in words.
The context block's crew line gains `override`, what the standing override passes and for how long, and `crew_status` carries it with the captain's words.
The crewmate side, outside the first mate's contract: the thread-reply preamble and the Crewmate tab lead say to relay such words with `needs_firstmate`, a `task-override-changed` notice serves the standing words to the crewmate's next turn, the brief and the reviewer's brief carry them, and `RIGOR_SAFETY` asks only for what they do not reach.
The longer `override` description costs about 23 tokens of the Firstmate's fixed context, paid back by dropping `start_again`'s and `start_now`'s parameter descriptions, which repeated the tool's own description, so the fixed context stays inside its budget (`tests/firstmate-fixed-context.test.ts`).
