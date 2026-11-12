# A factual answer is looked up first, or says it was not checked

A nightly review of the captain's sessions found two first mate answers stated as fact with nothing read first, and both were wrong: one said a fix had not reached an alpha when a published alpha already carried it, and one explained why a merge card showed while checks ran, where a later investigation found a real defect.
On the same day, when the first mate said it had not confirmed something and then checked, its answers held.
The captain chose to start the fix this revision makes.

What the first mate is now told: before answering a factual question, look it up - in the context, with a typed lookup or through a read it delegates - or say plainly that it has not checked.
It replaces the opening paragraph's "Answer directly only from the context and your typed lookups.", and the closing line's "never answer beyond your evidence" goes, since the new sentence says it.

Home: the core, in its opening paragraph.

The first mate's core was already 34 tokens over its budget on main before this change.
Unpinned sentences elsewhere in the core say the same rules in fewer words, so the fixed context now reads about 8 tokens under its budget (`tests/firstmate-fixed-context.test.ts`); no rule is removed.
