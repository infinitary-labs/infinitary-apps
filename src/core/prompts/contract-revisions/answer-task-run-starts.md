# A task that only answers starts its own project's runs

INF-729, the captain's way D: the nightly full check and the nightly phone check are tasks that only answer, and each night their run request waited on the captain's click.
`github_write` now sends a start or rerun of a run on the task's own project at once from a task that only answers: a workflow dispatch or a run or job rerun on GitHub, a pipeline start, a pipeline or job retry or a manual job's play on GitLab.
Every other write of such a task still asks, cancelling a run included, and every write through the github.com sign-in still asks.
The rule's one home is the crewmate's `github_write` description; the Firstmate's prompt, tools and wakes are unchanged, so its fixed context does not grow.
