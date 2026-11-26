# An outside action that waits on work is its own task

INF-6776's approved plan, part 1; the captain chose "Approve and build" with the answer "Its own task, waiting on every task that does the work".
An outside action, such as closing a work item, rode a builder's change as the app's own closing line, and which piece was last was the first mate's guess, so an issue could close early or never.

What the first mate is now told:

- HANDOFF (the core): when the captain's or a task's words make an outside action wait on work finishing, such as closing a work item, sending a message or posting an update, it files the action as its own task with `create_task` `side_effect`, blocked by every task doing the work, adds each piece filed later to its `blocked_by`, and gives no builder the duty; words that only mention an item ask for nothing; when that task reports waiting for a release, it holds it with `update_task` `hold` on `tasks/task_released` naming that work.
- `create_task` takes `side_effect` (one parameter description, the rule's home): each `blocked_by`, a wait added later too, holds until merged, never at approval, and the task's brief says how each wait closed.
- `update_task` takes `side_effect`, as `create_task`'s, before the task starts.
- The tasks reader shows `side_effect` in a task's row and its by-key read.
- The app's own events gain "Work ships in a release" (`tasks/task_released`), which the integrations roster names beside "A task closes".
- `spawn_crewmate`'s shape loses `closes_issue`: the app no longer writes Closes #N or Part of #N where a change is published, so no piece is marked as an issue's closer.

What a crewmate reads: only a side-effect task's own brief carries its rule, in a section naming each wait and how the record says it closed (the builder's brief); no other crewmate's prompt grows.

Homes: the filing rule is said once, in HANDOFF; what the host holds is said once, on `create_task`'s `side_effect`; `update_task` points to it.
The new words cost about 130 tokens of fixed context and `closes_issue`'s removal gives back about 35; the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host keeps only typed facts: the mark, the waits, that each needs the merge, and how each closed; whether words ask for an outside action stays the first mate's judgment.

Served sentences removed or altered (`node scripts/served-sentences.ts`):

1. tool spawn_crewmate · shape
   - Before: closes_issue: True only on a plan's last piece, when its basis answers an outside issue: its change closes that issue.
   - Mark: dropped ("closes_issue: True only on a plan's last piece, when its basis answers an outside issue: its change closes that issue."): no change closes an issue by an app-written line any more.
2. tool spawn_crewmate · shape
   - Before: A fix on a reproduce step closes it unmarked.
   - Mark: dropped ("A fix on a reproduce step closes it unmarked."): the same removal.
