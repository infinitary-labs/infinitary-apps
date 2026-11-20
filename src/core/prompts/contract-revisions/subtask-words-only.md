# A sub-task's brief carries only the captain's words for it

From a nightly session audit, its fifth friction, and the captain's checked improvement "A sub-task's brief carries only your words for it; an inherited override shows as a labeled fact".
The audit found the captain's instruction to merge one task without asking opening the briefs of two unrelated checks as the user's words, verbatim.

`spawn_crewmate`'s `user_words` is now optional and says "The captain's words for this task or the ask it is a step of, verbatim; outranks every elaboration downstream; else omit".
`create_task`'s `user_words` follows it and is optional too.
A brief with no words opens with the plain host fact that the captain gave no words for the task and its goal stands in; a step of the captain's own ask keeps their words.
A program's parts carry no words: each part's own goal is its ask.
The override standing on the nearest task a part belongs under reaches its crewmate as a labeled inherited fact in the brief, never as its ask, passing no hold and standing in for no consent ask on it.
Where the captain's words cover a part, the first mate records them on it through the ordinary steering path: the answer to `update_task` `override` names the task's open parts, and for its override a part may cite the captain's words on a card of a task it is part of or that task's standing override, where a merge click stays one and is refused.
The answer to a withdrawal names the open parts that carry an override of their own.

The one home of the rule is `spawn_crewmate`'s top-level `user_words` parameter; the open parts ride the situational `update_task` answer, outside the fixed part.
The fixed part grows by about five tokens by the app's count, since both parameters leave their tools' required lists and the description names the step case, and reaches the derived 19,772 boundary without passing it.
