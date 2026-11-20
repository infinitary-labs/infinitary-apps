# The captain's override

INF-473 builds INF-242's saved plan as the captain answered it: one registry of holds with levels, one recorded override that his words pass, and five fixed limits.
`update_task` takes `override` (`holds`, `until`): in a turn that carries the captain's own words, the first mate declares which soft holds those words pass, for this version or the task's life, and empty `holds` takes it back.
The host keeps his words from the turn as the override's reason and refuses one in any other turn; only the first mate records, so a crewmate's refusal tells it to report his words.
Every soft refusal now ends with its hold's sentence, which names the override to the first mate, or names its own way for the stronger-model limit and a start's waits; every fixed limit's refusal says no one's word passes it.
Those sentences are the hold's one home, written by `src/shared/holds.ts` beside each refusal, so the prompt says nothing new about holds.
The repair, re-review and rerun limits are soft: an override that names one reopens it at once.
The first mate's own cards no longer hold its own merge (the captain's answer to the plan's question 9).
The fixed context grows by about 103 tokens, from 19,644 to 19,747, all of it the new parameter.
