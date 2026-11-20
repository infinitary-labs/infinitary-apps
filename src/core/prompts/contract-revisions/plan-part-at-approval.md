# A plan part can start at its prerequisite's approval

INF-4517's plan, piece 3; the captain chose "Approve and build" with a part starting "When the part before it is approved to merge".
A later part that needs an earlier part's code used to wait until that part merged, though the earlier part is settled once the captain approves its merge.

What the first mate is now told:

- `create_task` takes `start_at_approval`: one `blocked_by` task whose approved merge starts this one, on its approved version, where the plan marks that link. A name that is not one of the task's `blocked_by` is refused in words and nothing is filed.
- The workflows guide's feature section says when a plan marks a piece to start at approval (it needs the earlier piece's code, and that piece is settled once approved) and that filing such a piece names that blocker in `start_at_approval` too.

Homes: the parameter is `create_task`'s, and when to use it is the workflows guide's; neither is said twice.
The parameter's description costs about 25 tokens, and the guide's two sentences about 70 more in a served runbook; the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host keeps only the typed fact: on batched pull requests the later part starts while the named prerequisite's merge approval stands and nothing else holds it, and whether a part needs the earlier one's code stays the planner's judgment.
