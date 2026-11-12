# show_merge_card

A crewmate on a computer that runs work may show its merge card in one call, `show_merge_card`, through the new order `inf:work:show-merge-card`.
The order carries the story staged there, when the crewmate gave one, and the merge card's id and the crewmate's own words beside it.
The home walks the steps up to the card - the story, the push, the live proof, the pull request and its published story - shows the card, and answers what it did or the one thing missing and who supplies it.
A home serves the tool to a computer only when that computer lists this change; one that does not keeps `prepare_change`, `open_change` and `emit_card`.
A computer whose home does not list it refuses the call before sending anything.
