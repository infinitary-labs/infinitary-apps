# Start applies standing directions

Task FI3-1718, from the plan FI3-1717 and the captain's choice "Plan making Start apply directions".
A task started from the captain's Start, a drag to Working or a drag to Queued never met his standing directions, because the host started it without the Firstmate ever hearing of it.

- New wake `captain-start`: the captain pressed Start (move `start`) or queued a task (move `queue`).
  The Firstmate applies every standing direction that bears on the task with `update_task`, passing `direction` with the direction's id, then `start_now` for a Start.
  It never declines his Start and starts it when no direction applies.
- `update_task` gains an optional top-level `direction`: the id behind the model, Runs on and policy edits of the call, shown on the history line ("Merging: Merges on its own, from d:...").
- A task that merges on its own is merged by the Firstmate without a merge card: the crewmate reports `needs_firstmate` at green, and the Firstmate runs `settle_task merge-pr`.
  When a direction's exception covers the final change, the usual completion decision comes to the captain and the Firstmate sets the task to ask first.
  The completion rule in `CREWMATE_CARD_ADDENDUM` and the `needs_firstmate` description say so.
- Cost: about 150 tokens in the Firstmate's fixed instructions, plus the wake text when it is served.
