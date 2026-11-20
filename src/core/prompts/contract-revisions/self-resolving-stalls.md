# Self-resolving stalls

INF-1550 implements B and C approved on INF-1540: a stall is a question for the fleet before it is a question for the captain.
The captain's answers to its review, INF-1554 F1 to F7, shape what the Firstmate is now told.
The first mate core points to the recovery rule on typed stall wakes: try the cheapest consent-free way, write it on the timeline, read the next fact in that same turn, and try another if needed.
When its own ways run out, it commissions one bounded read-only internal step reporting typed recovery ways, not a captain card.
A work wait names its owner, end fact, observation and cheapest alternative through the report tool; unowned waits and repeated unchanged waits produce typed stall facts on the report wake at the turn's end, never mid-turn (F6).
A stall reaches the first mate only when nothing else owns the wait (F3).
The check owner records crew check judgments without refusing them since INF-1688, so a stall is a work wait, never a check refusal.
The crewmate's file_followup description files a host-record takeover as "Take over: my branch in a fresh task"; the first mate core starts it now from the origin's branch, distinct from a must-merge-first "Continue: …" filing (F2).
The spawn_crewmate branch_from parameter describes the existing takeover capability; steer_crewmate files_from hands the old task’s files on.
Each recovery way declares its approach; only a workaround can be consent-free, while passing a hold or choosing a stronger model stays the captain's whatever the hold's basis, and sign-in stays the captain's (F7).
Consent labels describe a move, never bypass a hold.
The core adds roughly 70 tokens and stays inside the fixed-context budget; the detailed procedure lives on stall and recovery-finding wakes, so it does not repeat on every turn.
The crewmate's report tool gains work_wait and recovery_ways inside its fixed-context budget because, on the captain's choice (INF-1641), the delivery guidance and check_change's declaration field drop sentences check_change already says.
Existing host hold ways gain registry-based consent labels, and the idle steer declares itself a workaround.
After two ignored wakes the host's stall card still goes up, now naming the wait and the first mate's recorded attempts, so the idle wake's warning of a card stays true (F1).
Empty recovery findings are absent, recovery facts use the existing declaration/message bands with full overflow retained, and combined stall/findings wakes serve the procedure once (INF-1554 F4/F5).
A check-back with no running job owns nothing anywhere: its report wakes the first mate as a stop and the ladder climbs past its timer to the stall card (INF-1644 R1).
