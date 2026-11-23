# Usage reads what each finished task cost

A new request, `inf:usage:task-costs`, answers each task finished in a Usage period, and in the week before it, with what it and its reviews spent in tokens and estimated dollars (`usageTaskCostsSchema`).
The read catalog serves it as `usage.taskCosts`.
A view talking to an older home gets no answer, so its Cost per task section says it could not be read.
