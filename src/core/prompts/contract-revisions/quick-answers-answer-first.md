# Quick answers answer first, and an unanswerable one goes straight to research

INF-4344, building INF-4341's plan; the captain chose "Approve and build" with direction C (both the app's mark and the crewmate's line), the mark's words "Quick answer", "No" to a quick answer reading a web page, and a written-in addition: a quick answer that cannot give a meaningful answer from its sources goes straight to deeper research instead of showing a card the captain must click Look deeper on.
INF-4341 found that the quick crewmate's brief told it to list what was and was not established and name the missing source, and no sentence asked it to answer the question; in 21 of 38 quick answers that offered Look deeper the captain asked for more.

What the first mate is now told, in the sequences document's explainer section:

- The one drawn card's first sentence answers the captain's question as asked.
- "Not established" follows the answer, naming missing or conflicting evidence, never replacing it.
- A retrieval report that its sources hold no meaningful answer starts the research step built on it at once, as Look deeper does, with no card for the captain, and closes the retrieval as answered.

What the quick crewmate is now told, in its brief (`renderAnswerShapeSection`): it reads only what the app reads now and never the web; its card's first sentence answers the question with how sure it is; it reads every source the goal names inside that reach; a short answer ends with one line beginning "Quick answer." saying what it did not check and what Look deeper would add, with Look deeper the default, and a complete one offers no Look deeper; and when its sources hold no meaningful answer it shows no card and reports with needs_firstmate instead.

Homes: the first mate's two rules are the sequences document's, and the crewmate's are its brief's; none is said twice.
The explainer section grows by about 25 tokens, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host adds no refusal, timer or parser: whether a quick answer is meaningful stays the crewmate's judgment, and starting the research step stays the first mate's.
