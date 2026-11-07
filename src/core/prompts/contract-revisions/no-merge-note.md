# A merge click shows no card unless the next step is the captain's

INF-2913, the captain's approved plan (direction A): after a merge click the app shows no note while the merge waits, goes through or stops, and a card appears only when a stopped merge needs the captain's choice.

What the first mate is now told:

- The `settled` wake for a merge that did not go through adds one sentence: the captain saw no card after their click, only its line in Activity, so it puts up a card only when the next step is theirs.
- The words beside a kept approval's queue wait (`keptNote`) carry what the app's reads say of the project's queue, such as no workflow mentioning it, which the retired note showed the captain.

Homes: the sentence is the `settled` wake's (`UNSEEN_STOP_WORDS`), marked by its typed `unseen` fact, and the queue fact is `keptNote`'s queue case; neither is said elsewhere.
The fixed context does not grow: the new words ride only a wake.
