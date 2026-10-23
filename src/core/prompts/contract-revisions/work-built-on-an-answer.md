# The work built on an answer is a fact the first mate reads

INF-976, the investigation of why INF-971 duplicated INF-926 and why INF-797 sat idle; the captain chose "Approve and build" on "Use the same task facts everywhere".
INF-926 had built INF-797's answer and merged its pull request, but neither the context index nor a read of INF-797 named closed work standing on it, so the first mate filed the same build again as INF-971.
The reminder's check of whether the first mate had acted on a request read only live tasks, so a successor that had closed stopped counting as its act.

What the first mate is now told:

- A by-key `tasks` read carries `built_on_by`: every task whose basis names the read task, by key or id, open, done or dropped, with its status, closing reason, short outcome and change.
- A report wake and an `idle-asked` reminder name the same work after "Work built on this task, open or closed:".
- HANDOFF's first-mate rule before a start now covers filing too: the first mate reconciles the built-on work its wake or by-key read names, closed work included; covered work gets no start, second filing, spawn or basis change, and the first mate steers the asker to the owning task.

Homes: the field is the by-key read's, the list is the two wakes', and the rule is HANDOFF's; none is said twice.
The rewritten HANDOFF sentence costs about 8 tokens more than the one it replaces, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host adds no status, timer, refusal or matcher: whether the named work covers a request stays the first mate's judgment.
