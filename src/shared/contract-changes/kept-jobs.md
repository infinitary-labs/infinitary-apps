A crewmate on a computer that runs work may keep a job the captain asked for running past its task's close, with the stops command's new `keep`.
A placed task's spec gains the optional `keeps`, which the home sends only to a computer that lists this change and does not run as another user on the home's own computer; without it, that computer refuses a keep.
The close order `inf:session:close` gains the optional `keeps`, `keep` for a merged or answered close and `remove` for any other; absent, as from a home without the change, the computer runs each keep's remove.
The close order's report gains the optional `kept`, the jobs left running there, which the home records, `removed`, how each keep's remove went, and `handedKeeps`, how many keeps went to the task that carries the work on.
An older home ignores the new report fields, and an older computer ignores `keeps` and has no `keep` to refuse.
