# Decision model uses

The Decisions view adds optional `approvalVersion`, the approval screen this home shows, and optional `uses`, every way the home asks a decision model a question with its switch.
A new request, `inf:decisions:use:set`, switches one use, optionally with the approval the person just gave in the consent dialog.
The view's existing `stateVersion` and the key call keep the first approval screen's meaning, so an older view that turns Jev or OpenRouter on records an approval that still counts as old.
A newer view approves the lower of the home's `approvalVersion` and its own screen, never a newer number it merely read from another computer.
A view without `uses` draws no list, so a newer view never sends the new request to an older home, and an older view ignores both fields.
