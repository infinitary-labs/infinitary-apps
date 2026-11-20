# Filing for later records the captain's wait, and a first mate question names its work

INF-4165 finding 3, the captain's pick to start it: the next-move check treated work the captain chose to hold as standing still.
Work the captain filed for later was flagged ten minutes on, because filing could not record their wait and only a later `update_task` could.
And three tasks a first mate card asked about each got the app's own standing-still card, because that card belonged to no task.

What the first mate is now told:

- `create_task` takes `captain_stop`, served bare, as `update_task` does.
  The sentence that says when to add it moves from `update_task`'s `start_policy` to `create_task`'s, which `update_task`'s refers to, and names filing for later as one such wait.
  On filed on-request work it records the captain's stop at filing; on work that does not wait for a start the filing stands and the answer carries the refusal.
- The `next-move` wake names how a card counts as the work's question: a card naming it in `task_id` or `related`.
  An open first mate decision of its own whose `related` names the work now holds it as a card of the task's would, so neither the wake nor the app's card follows.

Homes: when to add `captain_stop` is `create_task`'s `start_policy` sentence; how a card names the work is the wake's own.
The fixed context grows by a few words and one bare parameter, about 15 tokens (`tests/firstmate-fixed-context.test.ts`).
