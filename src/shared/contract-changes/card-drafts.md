Adds each open card's unsent draft (`CardDraft`): the picks in its body by question, the words in its own field and its queued notes, kept at the first mate's computer so every window shows the same unfinished card and gets it back after a restart.
`inf:cards:drafts` reads every open card's draft, and `inf:cards:draft` takes what a window changed since the revision it last heard, keeping a part another window changed after that revision.
Each change goes to every view whose hello lists the change as an `inf:cards:draft` `live` frame, outside the numbering; a view or a phone whose hello does not list it is sent none.
A window whose home's welcome does not list the change sends no draft and keeps its picks to itself, as before.
