# A quick answer hands off a reply it cannot solve

INF-4583, building INF-4573's plan; the captain chose "Approve and build" with direction A (change what crewmates and the first mate are told) and yes to one marked sentence from general knowledge.
INF-4573 found that a quick answer met each reply under its card with one more line from the records, and that no served sentence said what to do when a reply asked for more than its sources held: in every thread that went deeper, the captain's own words named the next move.
In the longest such thread the first mate had also added to the brief a limit narrower than the kind's own, confining the answer to restating the records.

What the first mate is now told, in the sequences document's explainer section:

- A reply a retrieval crewmate hands back starts the work the captain's words need, built on its answer, at once, as if the captain had asked.
- It adds no limit narrower than the kind's own unless the captain asked.

What crewmates are now told, in their brief (`renderAnswerShapeSection`):

- Every answer the captain asked for: a reply in the card's thread is the captain still working on their problem; answer what they are trying to get done and put the next move in the card's actions as its default.
- A quick answer: answer a reply from its sources when they hold it, revising the card with any file the reply asks for; when it asks for more - how to do something, what is usual, a source the reach does not cover, or an action - say in one sentence what the sources establish, close the card, and report with needs_firstmate the captain's words, what was read and what the answer needs; never answer it by restating the records. It may add one sentence from general knowledge that begins "Not checked here:", which never replaces the hand-off.

Homes: the first mate's two rules are the sequences document's, and the crewmate's are its brief's; none is said twice.
The explainer section grows by about 40 tokens, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The reply rule's one to three sentences, the quick models and their reasoning, Look deeper, the Quick answer mark and the quick answer's reach stay as they were.
The host adds no parser, timer or hold: whether a reply asks for more than the sources hold stays the crewmate's judgment, and what work to start stays the first mate's.
