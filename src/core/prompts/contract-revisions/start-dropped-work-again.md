# Start dropped work again

FI3-1253 implements FI3-1251 Piece 2, approved with restart=start-again and pause=no, after Piece 1.
`update_task start_again` replaces dropped work only on the captain's request, copies its specification and policy declarations, transfers outstanding outgoing waits and starts the new record with ordinary fresh routing.
The tool returns the new key and refuses mixed operations before writing anything.
Start and steer refusals point to it; the captain's record click appears in Firstmate's next context with its replacement key.
Replacement briefs carry the old reports and saved work even when no report exists, without changing basis or escalation semantics.
The Firstmate tool set is unchanged.
The new option adds roughly 90 fixed-context tokens; tightening the existing update_task wording preserves its rules without raising the fixed-context budget.
