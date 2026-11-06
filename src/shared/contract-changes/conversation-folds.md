# Conversation folds

A conversation a computer that runs work holds may tell its home that it folded its context, as the new placed event `context_compacted`.
The home then serves the crewmate's standing directions again on its next turn, since the summary that replaced the older context may have dropped them (`docs/knowledge.md`, "Standing directions").
A computer sends the event only to a home that lists this change, so an older home never reads a member it does not know.
A home serves the directions on every turn of a conversation held on a computer that does not list this change, since it cannot hear that conversation fold.
