# A practical wait is a blocked-by link

The captain asked that a wait need not be a hard blocking relationship: whenever one task is in practice waiting on another, such as on its commit or fix, the first mate records it as blocked-by so Tasks draws the arrow.
The core now says: "A practical wait, such as another's commit or fix, is link_tasks blocks from the work waited on to the waiter that turn, even when not a strict prerequisite, so Tasks draws it."
`link_tasks` no longer says to use `related` instead of `blocks` merely to keep track: `related` is work neither task is waiting on.
A blocks link still holds start and, once the waiter is under way, its merge.
HANDOFF's hold line no longer says to chain only real prerequisites; it says to record waits and never invent one.
The new words cost the fixed part 34 tokens by the app's count, from 19,736 to 19,770.
The budget rises to 19,770, inside the 19,772 hard boundary.
The shorter related-link sentence pays for part of that.
