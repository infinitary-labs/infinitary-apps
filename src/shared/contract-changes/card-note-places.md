Adds an optional `place` to a card note (`CardNote`): a box, where a box with no size is a spot, and freehand lines, in the marked picture's own pixels, with the picture's `width` and `height`.
A place whose picture is inside its part also says which of the part's pictures it is (`picture`, counted from 1).
Adds an optional `page` to a card note: the running page the note marks, by its address and title as the crewmate's own reads give them, and what the page's outline names under the mark by role and name.
Both ride `inf:cards:reply`'s notes, a reply's notes in its card's thread and a past card's thread.
Both also ride a card's unsent draft where both sides list card drafts (`card-drafts.md`): the notes of `inf:cards:drafts`, of `inf:cards:draft` and of its `live` frame.
Adds the request `inf:browser:places`: what the outline of a task's browser page names on screen now, each by role, name and box, with the size the page is laid out at and the page's address and title as its crewmate's own reads give them.
Adds the same read to a computer that runs work, as the order `inf:task-browser:places`; one without the change is not asked, and the home answers that the outline could not be read.
Adds an optional third value to `inf:task:steer`: the notes and pictures that leave with a line from the crewmate's message box, whose line may then be empty.
A home without the change reads a note without its place and refuses the new request and the third value, so a desktop view offers Point at on a picture or a page only when the home's welcome lists the change.
A desktop view or a phone whose hello does not list the change reads no place, so a home sends it each such note folded into the line's words: the note's label, its mark number and place, and its comment.
A draft's notes are sent as they are, never folded: a desktop view that lists card drafts and not this change reads a draft's note without its place or page, and once it changes that card's notes the list it writes back holds none, so every window then reads that note with no mark.
