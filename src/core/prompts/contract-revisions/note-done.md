INF-2794, the captain's approved plan: the minus only ever puts a card aside, and every live note gets one button at its foot, "Done" when the click closes the task (the marked answer note of an active answer task) and "Got it" otherwise.
Putting a note aside no longer reads it or reaches its author.
`ORDINARY_NOTE_READ_GUIDANCE` and its acknowledgement clause in `cardContract.ts` now name the captain's Got it as the acknowledgement, and say putting a card aside is not one; a marked saved answer still waits for its Done.
The read wake (`card-closed` with `read`) now says the captain pressed Got it on the note, then carries that guidance; legacy and duplicate-close wakes keep their words.
The crewmate card guidance and the operation brief say a note stays until the captain presses its Got it, instead of until the captain closes it.
The changed words are a few tokens shorter in the guidance and a few longer elsewhere, so the fixed context stays inside its budget.
