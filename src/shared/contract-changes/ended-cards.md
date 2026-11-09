A card optionally carries `ended`: who ended it, the reason they gave, when, and the thread's app line, on a card its author withdrew after the captain had seen it.
The stack a view reads and is pushed (`inf:cards:list`, `inf:cards`) keeps such a card in its place with no actions, a `noteDone` of Close and a corner whose operation is `read`, until the captain closes it with `inf:cards:note-done` or `inf:cards:close`.
Every other reader of the core's cards reads the card as closed, as before.
A desktop view decodes cards strictly, so the connection sends `ended` only to a desktop whose hello lists `ended-cards`, on list replies, live pushes and replay alike.
An older desktop gets the card without `ended` and draws it as a note whose one button reads Close, which the core takes as closing it.
A phone ignores fields it does not read, so it gets `ended` whatever it lists, and an older phone draws the card as that same note.
A newer view reading an older core never sees an ended card: a withdrawn card leaves the stack at once.
