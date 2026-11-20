# Every dependency starts at approval unless it needs the merge

INF-5269's plan, part 2; the captain chose "Approve and build" with the answer "Every dependency starts the later task at approval, unless the filer says it needs the merge".
A chain whose dependencies were filed without the start-at-approval mark waited for each batch to merge, so later parts sat idle for hours after the captain approved the part under them.

What the first mate is now told:

- `create_task` takes `needs_merge`: the `blocked_by` tasks this task needs merged, not only their code, such as for a release. On batched pull requests every other dependency starts the task at its approval. A name that is not one of its `blocked_by`, or the one `start_at_approval` names, is refused and nothing is filed.
- `update_task` takes `needs_merge`, as `create_task`'s, before the task starts; it replaces the list and an empty list clears it.
- `start_at_approval` now says it names which wait the start follows, when several could.
- The tasks reader shows `needs_merge` in a task's row and its by-key read.
- `link_tasks`'s blocks, the core's rule for recording waits, and the refusal when a task cannot start yet say that on batched pull requests the start comes at the other task's merge approval unless `needs_merge` names it.
- The report wake that names work held on a task says that on batched pull requests work built on that task stops waiting once it is approved to merge, and merges after it.
- A merge wait moves with its wait when either task is replaced or an after-merge step carries the wait on.
- The sequences guide's feature section says how to choose: a later piece of the same work needs only the earlier piece's code; a task that needs the earlier one live on the default branch needs its merge.

Homes: the rule is said once, on `create_task`'s `needs_merge`; `update_task` points to it, and the guide says how to choose.
The new and revised words cost about 120 tokens; the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host keeps only the typed fact; whether a dependency needs the code or the merge stays the filer's judgment.
