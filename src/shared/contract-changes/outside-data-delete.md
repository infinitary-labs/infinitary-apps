# Deleting words from outside

Adds the request `inf:retention:delete-outside`, which replaces the Gmail and Calendar content every saved conversation on the home holds with a note, and answers how many conversations changed and how many follow once their work pauses.
Adds the optional field `kept` to `inf:retention:scope`'s answer: each kind of words from outside the home keeps for a while, its days and its name.
An older side never asks the request, and reads a scope with no `kept` as nothing kept, so it shows no delete row.
