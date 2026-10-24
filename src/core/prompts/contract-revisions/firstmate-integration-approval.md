# The first mate's integration calls ask on the app's card

INF-1108, the second piece of INF-950, built on the captain's Approve and build from INF-1092 (q1 "Yes, like any action, but its card highlights Only this time, so Always allow takes a deliberate click"; q2 "Like a new connection: every action asks until you choose Always allow").
The first mate no longer starts a crewmate for an action at Asks you.
`use_integration` now runs an Always allowed action of any effect from its seat; any other call needs its `reason`, and the app holds the exact call on a row it files for the app's own approval card, naming the first mate as the one who asks.
The first mate emits no card of its own, does not repeat the call, and hears the outcome once as a `write-answered` wake; a refusal's wake tells it to call the integration again with a reason to ask again.
The rule's one home is the `use_integration` description; the wake carries the outcome.
The `integration-add-mcp` catalog line no longer says a server's read-only tools run: each asks until the captain chooses Always allow, as INF-950 made it.
The new words cost the fixed part about 20 tokens by the app's count, under the 19,772 boundary.
