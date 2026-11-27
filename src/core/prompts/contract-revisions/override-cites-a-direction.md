# An override may cite a heard direction

INF-6987's approved plan, piece A2: a standing direction the captain was heard giving for a project already approves a check, but the holds its words reach could pass only once the captain said the same thing again on the task.
`update_task`'s `override` now takes a heard, current direction of the task's project as `from`, by its `d:` id, on any turn, a scheduled check included, since the direction's words are recorded and need no message of this turn.

What the first mate is now told:

- The `override` parameter's description names the new citation and says the override ends when the direction is revised or retired.
  The host checks only closed facts: the direction is current, belongs to the task's project, and its current revision was heard from the captain; anything else is refused in words, with nothing recorded.
- The answer to a recorded one names the direction and its revision, says the host ends the override when that direction is revised or retired, and says the captain's own words stand over it: words of theirs the first mate records replace it, and citing a direction never replaces theirs, which is refused in words naming `standing`.
- `standing` on an override that cites a direction carries the direction with it, and is refused in words once that revision is no longer current; the `direction` line of `app_change` and `settle_task` done's `captain_words` refuse `standing` there, since those words are a direction's, not the captain's on the task: a close on them would pass every hold.

Homes: the citation is the `override` parameter's; its refusals and the replacement rule are the refusal's and the answer's words.
The crewmate side, outside the first mate's contract: the `task-override-changed` notice adds a sentence naming the direction and revision the standing words come from, and, when the host ends the override because the direction changed, says so in its own sentence.
The fixed context grows by the longer `override` description, 101 characters or about 25 tokens, inside the budget (`tests/firstmate-fixed-context.test.ts`).
The host reads none of the words: it ends each override citing a direction on the knowledge store's change hook, and once at start for a change made while the app was closed.

Served sentences removed or altered (`node scripts/served-sentences.ts`):

1. tool update_task · override
   - Before: Captain's words (this turn's; or from: a card id, their reply or click there; crewmate-tab; or standing, the recorded words, to add holds) pass soft holds you judge, until as they mean, even unrefused; empty holds takes it back.
   - After: Captain's words (this turn's; or from: a card id, their reply or click there; crewmate-tab; standing, the recorded words, to add holds; or a heard direction of the task's project by d: id, on any turn, ending when it is revised or retired) pass soft holds you judge, until as they mean, even unrefused; empty holds takes it back.
   - Mark: kept (says all it did, and adds the direction citation).
