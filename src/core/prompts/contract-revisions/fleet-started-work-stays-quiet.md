# Work the first mate started on its own closes without a note

INF-1468, built on the plan INF-1467, which the captain approved with direction A ("your first mate's mark at the start keeps the note off").
The captain's words: "tasks the fleet decided to start that the captain didn't ask for should not report to the captain."
The note that prompted it was "INF-1461 dropped", the closing note of a step the first mate had opened itself for INF-643's crewmate.

`internal_step` now means any work the captain did not ask for: a step of a sequence the first mate runs, a helper another task needs, a crewmate's request, or work it starts unasked.
Its description (`INTERNAL_STEP_DESCRIPTION`, said once on `spawn_crewmate` and pointed to from `create_task` and `update_task`) tells the first mate that such work's drop or finish puts no note up while a merge or release still does, and that work started by the captain's message, card choice or schedule stays theirs.
`update_task` takes `internal_step` on open work before it starts, so a crewmate's filing the first mate starts unasked can carry the mark.
The host honours the mark in `SettleService.leaveClosingNote`: a drop, cancel or finish of marked work leaves its sentence on the record and in Activity only.
The builder's brief for a marked change tells its crewmate to show the captain a card only for what only they can give, or a note for something it found that they should see (the captain's answer "Also a note when it finds something you should see").
The new words cost the fixed part about 87 tokens by the app's count (characters / 4), inside its boundary (`tests/firstmate-fixed-context.test.ts`).

The ledger entry that comes with it:

INF-1467 (the captain's direction A). internal_step covers any work the captain did not ask for; its drop or finish posts no closing note, a merge or release still does; update_task can set the mark before a filing starts.
