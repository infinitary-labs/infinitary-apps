# The first mate's start waits for its own open question card

INF-6091's session audit, finding 1, the captain's pick "Start a task now to build it": the first mate started a task 26 seconds before the captain answered the first mate's own card asking whether to start it.
`update_task start_now`, and `start_policy` when-ready on queued work, are now refused while the first mate's own open decision card still asks the captain about that unstarted task - one kept on the task, or one filed as its own decision that names it in `related` - on a turn that carries no words the captain typed. A click on another card, or a choice the app carried out, is not the captain's answer to this one, so it lifts nothing (the captain's pick on the review: "Only your typed words, or your answer on that card").
The refusal names the card and ends with the new soft hold's sentence, `card-question`, whose own way says what lifts it: the captain answers that card or types their own words, or the first mate withdraws the card, and the first mate starts the task again.
The rule's one home is that refusal; no description changes.
`HOLD_KINDS` gains `card-question`, so `update_task override.holds` and a crewmate's `report recovery_ways.hold` list it; the tool refuses an override naming it, as it does every soft hold with its own way.
The fixed context grows by the one name in each list, about 8 tokens.
