# A start names its automation when a turn read several runs

From INF-6250's finding 5, as the captain started it: at 3:00 AM one first mate turn read two automation runs due at the same time and started a task for each without naming either run.
The host accepted both starts, so neither task was tied to its automation: neither run's history listed its task, and the crewmate got no notes from its rule's earlier runs and could not keep new ones.

`create_task` and `spawn_crewmate` now refuse a call that names no `origin` when the turn read more than one automation run and the call answers no captain message.
The refusal names each run's automation id and name, so the retry names one.
`create_task`'s `origin` description, which `spawn_crewmate`'s points at, adds that it is required in that case.

Home: the `origin` parameter's description and its refusal.
The added sentence costs about 8 tokens of fixed context.
