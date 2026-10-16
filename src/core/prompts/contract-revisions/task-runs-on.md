# A task's own Runs on

FI3-1345, built on FI3-1344's plan, which the captain approved with direction A ("Ask Firstmate; the record shows it") and each part taking its parent's Runs on unless it has its own: the captain can tell the Firstmate where one task runs, apart from its project's Runs on.
`spawn_crewmate`'s `shape` group gains `runs_on_ask`, and `update_task` gains a top-level `runs_on`: a computer that runs work by its deviceId, or `this-mac`, and on `update_task` `project`, which follows the parent's or project's Runs on again.
The rule says the Firstmate passes it only on the captain's words, before the task starts, and that device ids come from `device-remove`'s read value, as for `project-runs-on`.
The host refuses, in plain words, a started task, the personal workspace, a project kept on this Mac only, a review, a task with no project, and a device id that is not a computer that runs work; a refused spawn starts nothing.
The rules ride the new parameter's own description, which the shape group's rule points at, so `update_task`'s description does not grow.
The new words cost about 65 tokens; `update_task`'s `start_policy` now points at `create_task`'s, which says what each policy means, and its `basis` no longer repeats the description's start_now rule, so the fixed context went from 19,700 to 19,676 (`tests/firstmate-fixed-context.test.ts`).

The ledger entry that comes with it:

FI3-1345. spawn_crewmate shape.runs_on_ask and update_task runs_on (a deviceId, this-mac, or project) set where one task runs on the captain's words, before it starts; parts follow their parent's unless they have their own.
