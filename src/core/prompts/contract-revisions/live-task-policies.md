# Change policies on named open tasks

FI3-824's approved conversation-first plan lets the captain change delivery, merging and care on named open tasks without starting queued work or restarting its crewmate.
`update_task` gains top-level delivery, autonomy and rigor enums, with omission preserving a value and `project` resetting it; autonomy uses `on|off|project` so both Pi and Claude carry the same closed schema.
Its description is the single instruction home for explicit consent, ambiguous requests, ready-result release, repeated ask-first cancellation, destination changes, sent merges, care changes and preserved history.
The persona is unchanged, and no tool or record control is added.
Task queries, crew context, briefs, completion facts and durable policy notices carry the effective policies rather than dispatch stamps.
A policy notice alone never starts an idle or waiting crew; a self-merging request uses the existing Firstmate and settle paths to recheck a ready result.
Only a routine completion hold can be removed; explicit withdrawals, unrelated decisions, caps and other safety holds remain.
The fixed context grows by roughly 350 tokens; compacting the existing update wording and keeping the instruction in its tool leaves the existing 18,500-token ceiling unchanged.
