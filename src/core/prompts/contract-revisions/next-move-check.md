# Begun work with no next move is told once, then shown to the captain

INF-3846, the captain's ask to find why a workstream paused half way and broke continuity, and to fix it by design rather than with a patch.
Its second piece widens the idle ladder's pass to the parts of begun work it never read: open work waiting on request, and started work back in the backlog.
Each such part is moving, waiting on the captain with a card up, or stopped by the captain; a part that is none of these gets one typed wake, and if it still stands once that news is handled, the captain gets one host card.

What the first mate is now told:

- A `next-move` wake names the task, why it counts as begun work (a part of work that started, waited on by started work, or started itself), how it waits and for how long, and the four ways to answer it: a start, a card to the captain, a drop, or the captain's own stop.
  It goes once per stay in that state and says that the captain gets one card if the state still stands after the turn.
- `update_task` takes `captain_stop`, served bare, and its `start_policy` description says to add it when the captain asked for the wait.
  It records one timeline line, and until the task starts again the check counts it as stopped by the captain; a part under a stopped parent is stopped too.

Homes: the rule and the ways out are the wake's own; what `captain_stop` records is `start_policy`'s one added sentence.
The fixed context grows by that sentence and the bare parameter, about 30 tokens (`tests/firstmate-fixed-context.test.ts`).
