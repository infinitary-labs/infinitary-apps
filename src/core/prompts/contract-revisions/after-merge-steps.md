# After-merge steps

INF-2796, the captain's Approve and build of direction A, with the written-in rule that a merge may end with nothing to continue.
A crewmate lists the work its own merge must come before as optional `afterMerge` steps on its change's story (`prepare_change`'s `story` parameter is their one home), instead of filing a `Continue: …` task, ending a turn without a card and waiting for the first mate's link.
The merge card draws them, and a merged or landed close files each as a `Continue: …` task that starts on its own.
The first mate is now told, in its core's triage line, that a merge names the steps it filed in the settled wake or its own `settle_task` result, and to drop one only when another task already does that work; the settled wake carries the filed keys and titles.
The core keeps a shorter line for a `Continue: …` filing made during the work under older instructions.
The emit_card `required_actions` description no longer says post-merge fleet work is a `Continue: …` filing; it keeps only that required actions are captain-only parts.
The crewmate card addendum no longer asks the body to name a continuation and say it starts once merged; `prepare_change`'s description says the card draws the steps and prose never repeats them.
A step may name an unstarted open task (`task`) in place of a new one, the project a new one is filed in (`project`), and the tasks whose merge it also waits for (`blockedBy`); the delivery line for direct-pr and queue-pr says such work goes in the story's `afterMerge`.
