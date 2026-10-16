# The idle ladder names a note that is up

FI3-438, discovered from FI3-435's look at FI3-434, a finished release that stayed open.
That crewmate reported with its outcome note up and declared no wait, so the idle ladder nudged it with "no card up ... emit your completion card", and it posted the same note again and reported again.
The Firstmate's stall wake then said "no card up" while its own context block listed the note.
A note still holds no turn, so the ladder still climbs; only what it says changes.
The `idle-stall` wake now carries the newest note up on the task as a typed fact, and says "only the note "…" (card id) up, which asks the captain nothing" in place of "no card up", then tells the Firstmate: if that note is its outcome, steer it to report waiting on the captain naming the note, never to post it again.
The crewmate's nudge, and the stall card's Continue, name the same note and ask it to declare its wait with `waiting_on_captain` instead of posting it again; with no note up the nudge no longer mentions an outcome card at all.
The prompt and the tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-438. The idle-stall wake names the newest note up on the task instead of "no card up", and says to steer a crewmate whose outcome it is to declare its wait rather than post it again; the nudge and Continue name the same note.
