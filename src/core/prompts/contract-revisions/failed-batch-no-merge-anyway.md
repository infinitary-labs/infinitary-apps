# A failed batch check gets no Merge anyway

INF-3208, piece 2 of the captain's approved INF-3183 plan: a merge card that goes up after the project's queue sent a change back shows the queue's own words in a Batch check cell, counts only the pull request's own checks, and offers no Merge anyway beside a failed batch check, since no checks override passes the queue.
When the captain's kept merge approval waits on the checks because the queue failed or sent back that version, the first mate is now told so beside the wait (`FAILED_BATCH_NOTE`, carried by `keptNote` through `queueWarning`): never offer or ask for Merge anyway on it, and the crewmate either fixes the cause in a new version or answers a send-back of a version that already holds the fix with check_change's answered verdict, after which the host marks it waiting for the queue again.
The rule's one home is that wait's words; the core and the tool descriptions are unchanged.
The fixed context does not grow: the words ride only that wait's outcome.
