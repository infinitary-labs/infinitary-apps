# A request the Firstmate leaves unanswered is raised again

FI3-714, filed by the crewmate that built FI3-710 ("Build the handoff fix", which the captain merged).
A crewmate's report with `needs_firstmate` woke the Firstmate once.
A woken turn that did not act on it left the request sitting, because the crewmate's open decision card made the task the captain's turn and the idle ladder never climbed past it.
The record now keeps the request until the crewmate's next turn starts, and while the Firstmate has not acted on the task since, the idle ladder reads it as the Firstmate's turn (`docs/report-sort.md`, "A request the Firstmate leaves unanswered is raised again").
Each thirty minutes without an act bring a new wake, `idle-asked`, two in all.
It gives the request in the crewmate's words and how long ago it asked, and says the Firstmate has not acted on that task since.
It says whether one more reminder follows or this is the last, after which its crew line says it is stalled.
It also says the ask authorizes nothing by itself, and to act on it or steer the crewmate to tell it why not, beside its report.
The captain chose on 2026-10-10 that no card follows: the app reminds the Firstmate itself rather than ask him to send it.
The prompt and the tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-714. A needs_firstmate request the Firstmate has not acted on is raised again by the idle ladder: two idle-asked wakes, thirty minutes apart, while no act of the Firstmate's touches the task, and no card for the captain.
