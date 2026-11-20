# A started task goes back to the backlog

INF-2062's build, grounded on its plan, which the captain approved with direction A ("Let a started task go back to the backlog") and the written-in words "we can probably have a brief instruction telling first mate this is what it can do when the user asks to pause a task".
`update_task`'s `start_policy` on-request now takes started work too: its turn stops, a kept merge approval ends, its work stays, and nothing the host sends wakes it until `start_now` picks it up in the same conversation.
The rule rides `start_policy`'s own description: when the captain asks to pause a task, move it to the backlog with a reason, never steer it to stay idle.
`reason` now also carries why started work goes back to the backlog.
`crew_status` lists such a task with status `backlog` and how long it has waited there.
The new words cost the fixed part about 80 tokens (`tests/firstmate-fixed-context.test.ts`).

The ledger entry that comes with it:

INF-2062's build (the captain's Approve and build, direction A). update_task start_policy on-request moves started work back to the backlog with a reason: its turn stops, its work stays, nothing wakes it until start_now. The first mate does this when the captain asks to pause a task, never a steer to stay idle.
