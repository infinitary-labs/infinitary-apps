# A wait chain stays quiet, and a finished task with no card asks for its close

INF-1428, built as piece 2 of INF-1670's plan, which the captain closed with "Approve and build" (question 1: "Build it as piece 2, widened by the wait-chain rule").
INF-785 waited on INF-1659, which starts on request and was itself blocked by INF-1109, whose pull request was up for merge.
Each of INF-785's reports woke the Firstmate as a wait on unstarted work, and the idle ladder nudged its crewmate, woke the Firstmate twice and raised the stuck alert.

What the Firstmate is now told changes in two places, both wakes:

- A report wake's "It waits on ... (not started)" follows the wait chain: a named open task that cannot start until its own blockers close stands for those blockers. A chain that ends in work underway sends no wake at all; a chain that ends in work nobody has started names that work, and an open task a dropped blocker holds is named itself.
- `idle-asked` has a second form: a crewmate that declared its work finished with no card of its own up is never nudged, and each thirty minutes without an act of the Firstmate's on the task bring a reminder, two in all, saying it declared its work finished, is not nudged, and asking the Firstmate to close the task if the record bears that out, or steer the crewmate with what is still missing.

Crewmates also gain `report`'s `waits_on`, recorded as `blocks` links the Firstmate sees like any other, and `github_write` finds a dispatch's run when no run number came back; neither is a Firstmate tool.
The prompt and the Firstmate's tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

INF-1428. A wait through a task that cannot start until its own blockers close reads those blockers; finished with no card up is raised as an idle-asked reminder to close the task, never a crewmate nudge.
