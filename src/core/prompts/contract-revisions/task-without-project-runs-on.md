# A task with no project runs on another computer

FI3-1495, built on FI3-1496's plan, which the captain approved with direction A: a task with no project can run on a computer that runs work when he asks, as a task in a project can.
The words Firstmate is told do not change: `spawn_crewmate`'s `shape.runs_on_ask` and `update_task`'s `runs_on` take the same values.
What changes is the host's refusal list: a task with no project is no longer refused ("has no project, so it runs on this computer"), and the other refusals keep their words.
The task's working copy there starts at the newest commit of this computer's default workspace, and merging its change merges into that workspace.
A computer on an older Firstmate makes the task wait with one feed line, and it starts by itself once the computer is updated.
No tool name, description or parameter changes, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-1495. A task with no project runs on a computer the captain names (`runs_on_ask`, `runs_on`): its working copy starts from this computer's default workspace, which is sent first, and its merge lands there.
