# A side-effect task with nothing merged stays unstarted

INF-7198's approved plan, part 3; the captain chose "Approve and build".
A side-effect task started as soon as every wait closed done, so one waiting only on a plan or a reproduce step started, found nothing shipped, said so and was held or dropped, and a build filed on the plan's answer a few seconds later never became its wait.

What the first mate is now told:

- `create_task`'s `side_effect` (the rule's one home) adds two sentences: a wait on an answer moves to the work whose basis names it, and when every wait closes with nothing merged the task stays unstarted and the first mate hears once, to link the work that ships it, drop it, or `start_now` on the captain's word.
- A new wake, `nothing-merged`, names the queued side-effect task and each wait with how it closed, once for that set of waits. It carries the fact only; the ways out are on `side_effect`.

What a crewmate reads: nothing new. A side-effect task's brief is unchanged; it simply no longer starts with nothing merged unless the first mate starts it.

The host keeps only typed facts: whether each wait closed done and merged (`TaskGraph.workMerged`), and the basis links that say which work carries an answer on. Whether to link, drop or start stays the first mate's judgment.
The new words cost about 45 tokens of fixed context (`tests/firstmate-fixed-context.test.ts`).

Served sentences removed or altered (`node scripts/served-sentences.ts`): none; two sentences added on `create_task` · `side_effect`.
