# The first mate keeps the captain's directions on its own judgment, through the app action catalog

INF-638, from the captain's "btw that was another example of rigidness in our logic" after INF-626: he checked a fix's choice on a crewmate's card, the first mate's direction was refused on that report's wake, his typed rule arrived mid-turn and was refused again, and only his third message saved it.
His ruling on the first attempt, which had the host check his consent: "why not just give first mate a tool to freely read and write standing directions, and then rely on the agent's judgment on when/how to do it? again take the bitter lesson into account".
His next question found that directions had a store and a gate of their own beside the app action catalog that mirrors Settings: "we were supposed to have a consistent system where everything the user can do in settings, the firstmate agent should be able to do as well".
A direction is now the catalog's `direction` line: the first mate adds, revises and retires one with `app_change`, its evidence kept as the reason, and `app_state` lists the current ones.
The line's new `judgment` tier lets the first mate act at any wake, and `app_state`'s description says so: "judgment means yours at any wake".
`record_knowledge` no longer takes a direction: its `kind` drops `direction`, its description drops the direction's publish, revise and retire parameters, and it says "Standing directions are the first mate's app_change direction."
It keeps "A direction is an imperative directive, not an observation." and "Revise an existing direction, never duplicate it.", the two rules the v4.59 ledger homes there.
The first mate's fixed context is about 20 tokens smaller and a crewmate's about 30 (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
