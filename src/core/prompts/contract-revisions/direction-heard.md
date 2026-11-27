# Where a direction was heard from the captain

INF-6987's approved plan, piece P; the captain picked "Confirm today's directions once, on one card" for the directions saved before this.
A standing direction a captain-origin record holds could pass consent although nothing showed the captain had said it: the first mate wrote it on its own reading of a click or a report.
Each revision of a direction now records whether the captain's own words for it were heard, and from where, and only a heard current revision is a yes.

What the first mate is now told:

- The `direction` line of `app_change` takes `from`: `turn` for this turn's words, a card's id for the captain's reply or click there, or `crewmate-tab` or `standing` with `task`.
  The host checks the citation by the rule an override's citation keeps and refuses one it cannot find, saving nothing; with no `from` the change saves on the first mate's judgment, not heard, and is no yes.
  Its current value lists each direction's `heard`.
- The `directions` context block's heading says the no-consent rule holds only for a direction whose `heard` names where the captain's words for its current revision were heard, and each served row carries `heard`, where or `false`.
- A `directions-to-confirm` notice wake, sent once ever at the first start that finds directions saved before the marks, asks for one card listing them as checkboxes valued by `d:` id, none ticked, and a same-text revision citing that card for each ticked one.

Homes: the citation and its refusal are the `direction` line's and its refusal's; the served mark and its rule are the `directions` block's; the one-time ask is its wake's, and its consent sentence joins the protected list.
A crewmate is told the same through its own served directions and the validation refusals, which name a direction heard from the captain.
The fixed context does not grow: the line, the block and the wake are served only where they apply.
The host reads none of the captain's words: it checks only that the cited place holds them, and that a click on a card offering directions named the one revised.
