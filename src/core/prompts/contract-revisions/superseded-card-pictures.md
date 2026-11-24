# A revision replaces a picture it says is superseded

INF-3192 fixes what INF-3188 reproduced: a crewmate answered the captain's complaint about a picture by editing only the caption beside it, and its reply said the fix was done while the card still showed the old picture.
Every crewmate, on either backend and at every rigor level, is now told in the shared crewmate prompt that a revision answering a complaint about what a picture shows, or whose reply says a picture is replaced, replaces or removes that picture in the same revision.
A picture a revision keeps still has alt text and a caption true of its file.
The host's half of the fix is in code, not served text: the change bars compare each picture by its verified bytes, so another file under the same words is a change and the same file copied again is not.
The new words cost about 60 tokens of the crewmate prompt; the Firstmate's fixed context does not change.
