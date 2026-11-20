# Tell the first mate when the queue stalls after a merge

INF-2997's review (the finding that a failed start after a merge was lost with the closing task's wakes), under the captain's choice: "retry the start after a mark, and wake the task's crewmate if it still fails. Never swallow the failure."
After a batched change merges, the app starts the project's queue so the next batch forms; a start that fails is tried once more.
When that fails too, the crewmate of a task still waiting in that queue hears it, and with no such task the new `queue-stalled` wake tells the first mate.
The wake owns the rule: the first mate starts one task in that project at once, with no card first, whose brief says to start the queue through the project's API the way the shipped queue starts it, or to report what stops it.
The wake costs about 120 tokens when it fires; the fixed context does not grow.
