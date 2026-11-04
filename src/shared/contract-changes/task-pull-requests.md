# Every pull request on a task

A task record's read adds an optional `pullRequests` list to its delivery: every pull request on the task, in number order, each with its number, its page where the home holds it, the checks last read for it, whether it merged and whether its merge closes the task (INF-2490).
`prNumber`, `prUrl` and `changeLabel` keep naming the task's current pull request, so an older view or iPhone app that reads only them shows what it showed before.
An older home sends no list, and a view reads that as a task whose fact strip names its only pull request.
