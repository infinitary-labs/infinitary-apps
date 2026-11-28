# A side-effect task starts at its moment: the release or the merge

INF-7198's accepted plan, part 1; the captain chose "Approve and build".
Issue-reply tasks started the moment their last wait merged, found the work in no release yet, asked to be held, and sat held for days, because a hold that waits for a release is refused on a task that has not started.
The captain asked whether they should start only when the release is ready, and noted that the app serves every project, so the moment comes from how that project ships, never from one release host.

What the first mate is now told:

- HANDOFF (the core): when it files a side-effect task, it sets `moment` release when the project ships in releases and the action should follow the work's first release, else merge.
- `create_task` takes `moment` (one parameter description, the rule's home): release keeps the task unstarted until each merge its `blocked_by` shipped, a parent's merged parts included, has a recorded first release; merge, the default, starts it once each closed done.
- `update_task` takes `moment`, as `create_task`'s, before the task starts.
- The tasks reader shows `moment` in a side-effect task's row and its by-key read.

What a crewmate reads: only a side-effect task's own brief changes, naming its moment (the builder's brief).
A wait closed done with no merge of its own names its merged parts with their first releases, and a release-moment task's brief tells its crewmate to act only once every merged wait or part shows its first release, and otherwise to do nothing outside and report the wait, since a start by hand skips the release hold; a merge-moment task keeps the report that asks for a release hold when its words still name a release.

Homes: the choice of moment is said once, in HANDOFF; what the host holds is said once, on `create_task`'s `moment`; `update_task` points to it.
The new words cost about 75 tokens of fixed context (`tests/firstmate-fixed-context.test.ts`).
The host keeps only typed facts: the moment, the waits, whether each merged and whether it has a recorded first release; which moment fits a project stays the first mate's judgment.

Served sentences removed or altered (`node scripts/served-sentences.ts`):

1. prompt
   - Before: When the captain's or a task's words make an outside action wait on work finishing, such as closing a work item, sending a message or posting an update, file the action as its own task with create_task side_effect, blocked by every task doing the work; add each piece filed later to its blocked_by, and give no builder the duty.
   - Mark: kept (says all it did, and adds the moment the first mate sets).
