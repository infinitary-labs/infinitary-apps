# A card button carries the field's notes, files and pictures

A footer click's value on `inf:cards:act`, and a note's own button's value on `inf:cards:note-done`, may carry optional `notes`, `files` and `images` beside `answers` (`cardChromeValueSchema`, `src/shared/choiceCarried.ts`).
They are what waits in the card's one field: its queued notes, its pasted files and its pictures, marked ones drawn at the press, in one request with the choice.
The home sends them where that button's words go, and keeps what went on the choice's `action` record as `carried`.
A request card's open-browser press that leaves the card docked beside the page answers nothing: the home's browser effect then says `docked`, and the window gives the field back what the press took.
An older home reads the value strictly and refuses a press that carries them, so a window asks its home's healthcheck first and, against a home that does not list this change, keeps the buttons waiting while a file, picture or note waits, as before.
A window that does not have this change sends only `answers`, which every home still takes.
A past card (`PastCard`, on `inf:cards:show`, `inf:cards:past` and `inf:cards:show-past`) may carry `carried`: the notes and picture names that went with its closing choice; a home leaves it out for a reader that does not list this change.
