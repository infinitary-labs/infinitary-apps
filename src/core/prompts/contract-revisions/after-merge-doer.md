# After-merge steps name their doer

INF-3060's product audit, finding 4, the captain's "Start now: an after-merge step names its doer, and app changes go to the first mate".
A step on a change's story now says who does it (`doer`): a crewmate, the default, or the first mate, for a change in the app itself such as an Automation rule, a setting or a direction, which no crewmate can reach.
A first-mate step files no task, so no crewmate starts only to report it has no access.
The settled wake, and the first mate's own `settle_task` result, now hand such steps to the first mate by title, goal and why, and tell it to do each with its own tools; a merge with such a step wakes the first mate even when nothing else would.
The rule's one home is that wake sentence (`afterMergeWords`); `prepare_change`'s story rule tells the crewmate when to name the first mate.
The fixed context does not grow: the words ride the wake only when a merge has such a step.
