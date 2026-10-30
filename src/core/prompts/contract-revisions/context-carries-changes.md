# A context carries what changed, and a fold reads open work back

INF-1712 implements the captain's accepted plan on INF-1699's finding 1 ("a wake carries only what changed; the roster lists running and idle tasks with the backlog reachable by lookup; directions and projects go once per conversation; after a fold the first mate re-reads open asks and cards from the app"), with changed facts sent directly.
The first context of a conversation is complete and says so in its `delivery` line; each later context carries only the sections and rows that changed since the model read them, with removed ids and emptied sections named.
The context's `crew` lists every started task, and unstarted work is a `backlog` count per project; the task index is gone, and the `tasks` query, now with paging (`next` continues a list from one cut, `skip` reads the live list from an offset) and `projects`, reads the backlog.
`open_cards` lists every open card, task or not.
Rows carry the times their facts run from, never elapsed times, so a row moves only with its fact.
After a fold the next context carries a `recovery` line, and the new `open_work` tool reads every open message of the captain's and every open card from the app, or one whole by `ask` or `card`, pictures included; a long read comes in parts the tool names with `next`.
A `tasks` list that stops short reads its later pages from the list as it stood at the first page.
Homes: the delta rules are the context's own `delivery` line; the fold rule is the `recovery` line; how open work reads is `open_work`'s description; the core's "find the task first" sentence names the crew, open cards and the tasks query.
The new tool's description and the `delivery` and `recovery` lines cost roughly 250 tokens, against the task index and model buckets no longer resent on every input.
