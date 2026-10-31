# Attribute a request to the action it actually concerns

INF-2010, from the captain's report that a card's You asked line quotes unrelated work and their choice “Reproduce it, then fix it”.
The attribution boundary no longer assumes every action in a turn addresses the latest captain message.
The top-level `ask_id` parameter on the first mate's attributing tools names the read message that action addresses, or the empty string for unrelated operational work even when the turn also serves captain words.
Omitting it keeps the latest read message for ordinary direct-request calls.
This rule lives in that parameter's description, shared by both backends; it adds about 600 tokens across the attributing tools, without another prompt paragraph.
The host validates a named message's read witness and pins the action's source through asynchronous work, including its brief's pictures and full text files.
