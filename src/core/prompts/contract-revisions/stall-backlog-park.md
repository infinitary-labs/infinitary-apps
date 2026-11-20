# A stalled task parks in the backlog

INF-3143's build, grounded on its investigation, which the captain approved with direction A ("Park it where it shows up").
A blocked task whose blocker has not changed parks where its wait shows, instead of the idle ladder starting over on every steer.
The idle stall wake now carries a fourth way, between the steer and the drop: park it in the backlog with `update_task` `start_policy` on-request, its work kept and no consent asked.
`start_policy`'s description on `update_task` now says the move takes the stuck card down, that the first mate hears once if news reaches the task there, and that it parks a task on its own when a stall wake shows a blocker no steer will change, as well as when the captain asks.
This revises INF-2062's rule that the first mate parks only on the captain's ask.
A new wake, `backlog-news`, tells the first mate once per stay in the backlog that the app's news - a job's end, a check's result, a closed dependency - reached a parked task, with the news itself, so it can start the task or leave it.
The new words cost the fixed part about 40 tokens (`tests/firstmate-fixed-context.test.ts`).
