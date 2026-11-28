Fix 4 of INF-7116, which the captain chose to start: a Careful task sat idle 31 hours after its report because a leftover notice in its inbox made every watcher read it as still moving, and no heartbeat listed it.

- The heartbeat's `standing_work` block gains a fifth row kind, `idle`: a started task, out of the backlog and with no gate, idle for at least two hours, that nothing runs, watches or ends. Its fields are the common ones (task, title, since, waited, new). The host reads only typed witnesses for it, never whether its inbox still holds a row, so a leftover row cannot hide it. The block's `note` names the new kind.
- The Heartbeat runbook's guide, its one home, names the `idle` row beside the others and says under Act that it is work nothing will move: read its newest report and make its next move, such as the review it waits for.

The fixed context does not grow: the wake adds one row per idle task, and the guide's words cost only while the runbook is on.

Served sentences altered (`node scripts/served-sentences.ts` lists none, since the guide and the wake are served only while the runbook is on):

1. runbook heartbeat · guide
   - Before: It carries the standing list (`standing_work`): waiting work that no other wake reports, every hold set more than a day ahead (`held`) and every wait on work nobody has started (`linked-wait`).
   - After: It carries the standing list (`standing_work`): waiting work that no other wake reports, every hold set more than a day ahead (`held`), every wait on work nobody has started (`linked-wait`) and every started task idle for hours that nothing runs or watches (`idle`).
   - Mark: kept (names the new row kind).
2. wake heartbeat · standing_work note
   - Before: Waiting work: parked parts, waits nothing ends, holds over a day and waits on unstarted work, rows marked new first, then oldest first.
   - After: Waiting work: parked parts, waits nothing ends, holds over a day, waits on unstarted work and work idle over 2 hours that nothing runs or watches, rows marked new first, then oldest first.
   - Mark: kept (names the new row kind).
