# A task's branch name

INF-4195's approved branch-naming plan, piece 2 (INF-4212), from the captain's ask that the naming runbook define how work branches are named, `inf/` and a short description by default, and that a person's own runbook can change it.
The first mate now writes a task's branch name when it files or starts the task: `create_task` and `spawn_crewmate` take an optional top-level `branch`, and `update_task` takes `branch` before the task starts, an empty one clearing it.
The rule's home is the naming runbook's guide, which the first mate is already served: it says how a branch is named, so a turned-on copy of the runbook serves its own words instead.
The `branch` parameter's description owns only what the app does with the name: it adds a short code from the task, and names a branch left unnamed from the task's title.
A name git would refuse, or one under the app's own batch branches, is refused at the tool call in words.
The fixed context grows by the one parameter on each of the three tools and the runbook's one sentence, about 90 tokens.
