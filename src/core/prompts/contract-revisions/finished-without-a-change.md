# Work that delivered no change closes as finished

INF-2971's audit found nine finished tasks in one day recorded as discarded.
Each was a work task with a working copy of its own that delivered no change, such as a triage whose fix landed on another task's branch.
`settle_task finished` refused it for having a working copy, `answered` told the first mate to merge, land or discard it, and the first mate discarded it.

`settle_task finished` now closes such a task: the host reads its working copy where it ran, as a discard does, and closes it `done/finished` with the completion evidence only when that copy holds no commit or edit and the task has no pull request of its own.
A copy that holds work refuses, naming `merge-pr` or `land` by the task's delivery.
Every settle refusal now names the one mode that would close the task instead of "its delivery path" or a list of modes.
The settle description adds this case to `finished`, and the core's settle line adds "or work that changed nothing" and drops "or discard" from what closes reported finished work, so finished work is not routed to a discard.
The two edits cost about ten tokens of fixed context.
