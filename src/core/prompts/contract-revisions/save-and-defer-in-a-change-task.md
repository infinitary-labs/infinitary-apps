# Save and defer on a prototype inside a change task

FI3-784, filed while FI3-777 built Save and defer: a prototype that runs inside a change task, as the prototype-settings journey does, is not an answer, so the captain's click does not close it and reaches its own crewmate instead.
`HANDOFF` told that crewmate only that the choice authorizes no build, so the task sat idle with its working copy.
`HANDOFF` now says that when Save and defer or Abandon reaches a live change-task author, it reports the choice and current settings with needs_firstmate; the Firstmate treats that task as the plan - reusing or filing the saved build with it as basis on Save and defer, filing nothing on Abandon - and then ends it with `interrupt_crewmate` cancel.
That close saves the working copy's unlanded work on the task's kept ref, which the saved build's basis section names beside the prototype card, the choice and the settings.
Nothing in the host changes: the click already reaches the crewmate, the report already wakes the Firstmate, and the cancel, the kept ref and the basis section already exist.
The new words cost the fixed part about 65 tokens by the app's count; with them it measures 17,781, under the 18,000 budget.

The ledger entry that comes with it:

FI3-784. Save and defer or Abandon on a prototype inside a live change task reaches its crewmate, which reports the choice and settings with needs_firstmate; the Firstmate treats that task as the plan and ends it with `interrupt_crewmate` cancel, whose close keeps its work for the saved build.
