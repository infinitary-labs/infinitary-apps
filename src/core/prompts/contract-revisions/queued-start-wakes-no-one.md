# A queued task whose wait ended starts without waking the first mate

INF-6536's session audit, finding 4, which the captain chose to build: in one day the app told the first mate 40 times that a queued task "started - its wait ended", and 24 of its turns held nothing else.
Each such turn read the whole conversation again and ended with a short line to the captain about the start.

The `queued-started` wake for work whose wait ended now follows the rule INF-5123 set for a start the first mate asked for: it goes out only when the task started on another model than the one named, or with no model recorded to confirm it.
Any other start raises no wake; the next context block's crew rows show the task running and the model it runs on.
The wake's words are unchanged, as are `queued-start-failed`, `asked-start-waits` and `queued-started` with `asked`.

Its home: the wake (`src/core/orchestrator/starts.ts`, `namedModelDiffers` in `namedModel.ts`).
The fixed context does not change.
