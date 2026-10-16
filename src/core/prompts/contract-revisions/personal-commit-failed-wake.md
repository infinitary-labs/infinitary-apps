# A personal workspace commit that fails is the Firstmate's to hear

FI3-1218, filed by the crewmate on FI3-1217 ("Panel follow-up journey loses its second commit on the Mac", which the captain merged).
At the end of a crewmate's turn on the personal workspace the host commits what it changed, and a report with no captain-turn witness closes the task done, "built in place".
When that commit failed, for example on a git lock a crashed git left behind, the host wrote git's words only to the task's timeline and still closed the task done, so nobody learned the work was never committed.
A failed commit now closes nothing: the task stays open with its files uncommitted, and the Firstmate hears a new wake, `commit-failed`.
It names the task and its crewmate, says the task stays open because the changes are saved in the workspace but not committed, and that the crewmate's next report tries the commit again.
It says to steer the crewmate to look into the error and report again, or to tell the captain, and ends with the error's first meaningful line in git's own words.
The task's timeline note says the same in one line, so the record's Now line reads why the task is still open.
The prompt and the tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-1218. A personal workspace commit that fails keeps its task open and wakes the Firstmate with git's words (commit-failed); the crewmate's next report commits again.
