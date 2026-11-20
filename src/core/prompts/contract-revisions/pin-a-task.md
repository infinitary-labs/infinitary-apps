# The first mate pins and unpins a task

INF-3127, the captain's "Approve and build" on the pin plan with the choice "The first mate pins and unpins by your words": piece one gave every Tasks row a pin button, and this piece gives the same pin to the first mate.
`update_task` gains a bare boolean parameter, `pinned`: true pins the task to the top of the Tasks panel whatever its state, false unpins it.
It goes with `task` alone; a call that pairs it with another edit is refused in words that say so, so the rule lives in that refusal and nowhere in the served text.
The host writes the same dated fact on the task as the row button does, with the record's Activity naming the first mate, and the reply line says which task was pinned or unpinned; pinning a pinned task, or unpinning one that is not, changes nothing and announces nothing.
The new parameter costs the fixed part about 7 tokens by the app's count; with it the fixed part measures 19,764, under the 19,772 budget.
