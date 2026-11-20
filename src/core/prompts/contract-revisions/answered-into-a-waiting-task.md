# A finished step closes as answered into the task waiting on it

FI3-422, filed from FI3-420, whose answer the captain closed with "Fix the card check and guidance" after PR #514's merge needed two clicks.
A live-check step reported a pass, but the task it was run for had its own basis, so `settle_task answered` was refused ("no planned or started task names it as its basis"), and the step's blocks link kept holding that task's merge until Firstmate removed the link and later closed the passing run as discarded.
`settle_task` mode `answered` now also closes an idle answer task opened as an internal_step when a planned or started task waits on it through a blocks link: the close is `done/answered`, the feed names the waiting task as where its answer carries on, and because the step is done the wait clears.
A task that names the step as its basis is still preferred, and every other refusal stands.
The tool's description says so: "once a planned or started task names it as its basis or waits on it through a blocks link (the close clears that wait)", and "when nothing builds on or waits on a step".
The new words cost the fixed part about 20 tokens by the app's count: it measures 18,058, up from 18,038.

The ledger entry that comes with it:

FI3-422, filed from FI3-420 (the captain's Fix the card check and guidance). settle_task answered also closes an idle internal step that a live task waits on through a blocks link, into that task, which clears the wait; a basis still comes first, and the other refusals stand.
