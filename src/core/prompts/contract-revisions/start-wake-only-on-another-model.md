# A start on the model asked for wakes no one; the crew list names each task's model

INF-5123's session audit, finding 3, which the captain chose to build: after the first mate started a task with a named model, the app woke it again to say the task was running and on which model.
In one day 57 of these wakes reached the first mate, 51 of its turns held nothing else, and only 2 said something new: that the model asked for was not available.

The `queued-started` wake with `asked` - for work `spawn_crewmate` or `update_task start_now` started behind its answer - now goes out only when the task started on another model than the one named, or with no model recorded to confirm it.
A start on the named model raises no wake.
The `crew` rows of the context block gain `model`, the model each started task runs on, so the first mate reads it there without a turn of its own.
The wake's words are unchanged, as are `queued-started` for work whose wait ended, `queued-start-failed` and `asked-start-waits`.

Its homes: the wake (`src/core/orchestrator/starts.ts`, `namedModelDiffers` in `namedModel.ts`) and the context block's crew rows (`firstmateContext.ts`).
The fixed context does not change.
