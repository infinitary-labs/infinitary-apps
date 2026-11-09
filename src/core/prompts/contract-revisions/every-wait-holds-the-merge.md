# Every wait holds the start and the merge

The captain chose, for INF-3167, that every wait between tasks holds both the waiter's start and its merge until the other task closes, after INF-3140 found a loop that a parent's wait on its own part had closed.
The core's practical-wait sentence is replaced: "Record every wait between tasks that turn as link_tasks blocks from the task whose close gives what the waiter needs: it holds the waiter's start and merge until that close. When only part of a task would, split that part into its own step or fold the waiter into it."
`link_tasks` says a blocks link holds the start and the merge until `from` closes, and the circular-wait guidance says the loop is repaired by split or fold, with two repairs of failing checks keeping one existing owner.
The report wake from a task that started work waits on says every wait holds that work until this task closes, names `settle_task` done, why `answered`, for a step whose report was all that work needed and `link_tasks remove` when only the finding was needed of a task that goes on, and says any other wait ends at the close.
The start-wait refusal says the task starts when that work closes and names split, fold and removing a wait that names the wrong task, never dropping the blocker.
The loop refusal counts a parent's open parts among its waits and says the same repair.
The new words cost the fixed part 1 token by the app's count, from 19,759 to 19,760, inside the 19,772 budget; the shorter circular-wait guidance pays for the longer wait sentence.
