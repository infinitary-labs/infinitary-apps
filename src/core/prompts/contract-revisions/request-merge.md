# request_merge

FI3-1543, the captain's choice of direction A.

The agent-facing pull-request merge is a request, not a merge.
`check_change` may take `pull`, a pull request number in the task's project, and returns a review id.
That call grants no approval and merges nothing.
`emit_card` may declare `request_merge` with that review id.
With autonomy off, only the captain's button authorizes execution.
An owned review finishes the task through the existing completion rules.
A referenced review, such as a release tool's pull request, keeps the task and its working copy and wakes the crew once.
Dropping that task does not close the referenced pull request.

The Firstmate's fixed context grows by about 52 tokens for the new effect on emit_card.
The ceiling moves to 18,302, the measured count, and the local-window room still holds.
