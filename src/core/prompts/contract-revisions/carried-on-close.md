# Work carried on closes done

INF-1825, Finding 3 of INF-1810 (the captain's "File it and start now"), built on the captain's Approve and build of the plan "Plan closing carried-on work as done, not dropped", direction A.
Six of ten "dropped" notes in one day were for work another task carried on, because started work could end only by a discard or a cancel, and neither could name the task carrying it.
`settle_task` gains mode `carried_on` and a top-level `carried_by`, the task carrying the work.
The close writes the replaced-by link, so the waits on the old task move to that task, keeps the old task's commits, closes its own pull request unless the other task carries that same one, and closes it done, never dropped; no note goes up.
It is refused for the task itself, a task under it, a dropped task, and while a card of the old task waits on the captain.
`update_task` drop with `replaced_by` on unstarted work closes the same way, done through that task.
A closing sentence is not required for `carried_on`, so `closing_sentence`'s description names it beside answered.
Its home is `settle_task`'s description; the new words cost about 130 tokens of fixed context (`tests/firstmate-fixed-context.test.ts`).
