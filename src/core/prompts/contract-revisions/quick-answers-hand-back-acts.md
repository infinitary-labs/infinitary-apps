# A quick answer hands back a goal that asks for something done

INF-6952 part B; the captain chose "Approve and build" with the scope answer "Also every quick answer: any ask to publish or merge goes back to be done".
INF-6952 found two outside-contribution reviews, filed as follow-ups, that the kind classifier sorted as retrieval: each ran as a quick answer with no delivery tools, and each showed a status card with Look deeper where its goal asked for a published review and a merge card.
No served sentence told a quick answer what to do with a goal that asks for something done, and the retrieval boundary named no such ask.

What the first mate is now told, in the sequences document's explainer section:

- A goal that a retrieval hands back as asking for something done starts at once as that change or action, never as research or another lookup; one asking for something merged or a merge card shown starts as a change, never read-only or as an operation, which has no pull request tools or merge card.

What crewmates are now told, in their brief (`renderAnswerShapeSection`, `QUICK_ANSWER_ACT_WORDS`, after the reach):

- A quick answer whose goal asks for something done rather than known - a comment or story published, something sent, merged, built or changed, or a merge card shown - shows no card, even when the goal names it as the state it wants, and reports with needs_firstmate what the goal asks done and what it read.

What the kind classifier is now told, in its retrieval boundary (`RETRIEVAL_BOUNDARY`): such a goal is never retrieval, research, plan or reproduce, even when reading comes first or the goal names the state it wants: it delivers a change. The captain chose this wider line over ruling out retrieval alone, so a goal that asks for something done is never left as a read-only answer that can neither hand back nor do the work.

Homes: the first mate's rule is the sequences document's, the crewmate's is its brief's, and the classifier's is the boundary's; none is said twice.
The explainer section grows by about 45 tokens, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host adds no parser or refusal: whether a goal asks for something done stays the crewmate's and the classifier's judgment, and what to start stays the first mate's.
Look deeper, the Quick answer mark, the reach and every other answer shape stay as they were.
