# Work names every message it answers, and a mid-turn relay says its card is still coming

INF-7157 traced a duplicate answer card, and the captain chose to start its fix.
The first mate answered a question on its own card, then started a task for that question and its correction while naming only the correction, and closed its card.
The question was left with no work running, so the app asked for an answer once more and the first mate showed a second card.
A crewmate's relay (`needs_firstmate`) then woke the first mate 20 seconds before the crewmate showed its own card, and the first mate rewrote its second card with the crewmate's finding ahead of the crewmate's card.

What the first mate is now told:

- `spawn_crewmate`'s and `create_task`'s `ask_id` take a list, as `emit_card`'s does: the open_asks ids of every message the work answers, such as a question and its correction. Each named message counts the work as running for it. The other tools keep one id.
- A report wake sent when a relay is made, while its crewmate's turn goes on, says so, and when no card of the crewmate's is on the captain's screen yet, that its card is still coming. The rule this fact serves is already in the core ("Act on crewmate reports, not relay them"), so it is not said again.

Considered and not built: refusing a first mate card that names a running task whose crewmate has shown no card yet. The app's answer check asks the first mate for a holding answer on exactly such a task, so the refusal would block that answer; with work counted for every message it names, the forced answer this case needed no longer comes.

Homes: the list's rule is `spawn_crewmate`'s and `create_task`'s `ask_id` parameter; the mid-turn fact is the report wake.
The first mate's fixed context grows by about sixty tokens for the two parameter descriptions.
