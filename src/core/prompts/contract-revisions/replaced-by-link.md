# A drop names the task that does its work

FI3-1209, rule 1 of the plan the captain approved on FI3-1189 ("Make a task's Activity complete: record for every task concerned, and fold instead of hiding"; Approve and build).
Firstmate dropped FI3-1187 for FI3-1188, which merged the fix, but that fact lived only in the drop's reason, so FI3-1188 was linked to nothing and FI3-1094, which filed FI3-1187, never heard of the merge.
A task's events now name the other tasks they concern, read from the typed links, and a replacement is one of those links.
`update_task` gains a top-level `replaced_by` beside `drop`: the task (key or id) doing the dropped one's work, linked `replaced-by` before the close, so the drop and that task's milestones reach whatever the dropped one concerned.
Its description says "If another task does its work, also pass replaced_by."
`link_tasks` takes type `replaced-by` too ("`from` was dropped for `to`, which does its work") for work dropped some other way, such as a discard.
The new words cost the fixed part about 57 tokens by the app's count: it measures 19,578, up from 19,521, under the 19,600 ceiling.

The ledger entry that comes with it:

FI3-1209 (FI3-1189's rule 1, the captain's Approve and build). update_task takes replaced_by with drop, and link_tasks takes the replaced-by type, so a replacement is a typed link that carries the dropped task's news to its replacement and back.
