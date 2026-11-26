INF-6853's fix, option C as the captain chose it, with the no-hold change: a wait on another task's end is a link alone, and the Heartbeat lists every hold and every wait on unstarted work.
The captain's rule: when a task's start depends only on another task's end, a `blocks` link models it alone, never a link plus a hold saying the same thing; a hold is only for a time, an outside event or an app update.

- `update_task`'s `hold` description (its home) now says a hold is for a time, an outside event or an app update, and that a wait on another task's end, or on the captain's go for it, is a `link_tasks` blocks link from that task alone, filing that task first if needed, with `captain_stop` when it waits on their word.
- The core's triage bullet, beside "Record every wait that turn with link_tasks blocks", adds: when you file work whose close ends held work's wait, link it that turn and lift the hold that named it; a hold's reason wakes nothing.
- A hold's reply now names each task a link already holds the task on (`TaskGraph.waitingOn`), so the first mate sees a hold that would repeat one; the host judges nothing about the hold's words.
- The heartbeat's `standing_work` block gains two row kinds: `held` (the first mate's hold set more than a day ahead, with its time, reason and what ends it sooner) and `linked-wait` (an idle task whose waits end only in work nobody has started, each with `stopped_by_captain`). A parked part also reads new when its last prerequisite closes. The Heartbeat runbook's guide, its one home, gains the matching Act and Ask once cases and says to replace a hold that names another task's end with a link.
- A report from a task whose waits end only in work the captain stopped sorts `waits-stopped` and wakes no one, so a link alone keeps such a wait quiet without a hold.

The fixed context grows by about 60 tokens: about 25 in the hold description and 35 in the core bullet; the guide's words cost only while the runbook is on.

Served sentences altered (`node scripts/served-sentences.ts`):

1. tool update_task · hold
   - Before: Hold started idle work for time or an outside event no message can speed.
   - After: Hold started idle work for time, an outside event or an app update no message can speed.
   - Mark: kept (says all it did, and names the app update its `on_update` already took).
