# The start-at-approval mark can be set after filing

INF-5269's plan, part 1; the captain chose "Approve and build".
A chain filed without the start-at-approval mark could not get it afterwards, so its parts waited for each merge even after the plan was revised.

What the first mate is now told:

- `update_task` takes `start_at_approval`, as `create_task`'s, before the task starts; an empty name clears it. A name that is not one of the task's `blocked_by` (a wait the same call adds counts) is refused in filing's words and nothing changes, and a started task is refused.
- The tasks reader shows the mark as `start_at_approval` in a task's row and its by-key read.

Homes: the parameter is `update_task`'s, and its meaning stays on `create_task`'s; neither is said twice.
The parameter's description costs about 15 tokens; the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host keeps only the typed fact; whether a part needs the earlier one's code or its merge stays the planner's judgment.
