# The app writes the review history

INF-993, the captain's Approve and build of direction B: "the app writes the history only".
INF-812's reviewer lost the captain's answers on two findings when the first mate's retyped `user_chose_to_ignore` list turned to "none", and it read an approved gap as still unanswered.

The app now writes a "Decided so far" section from the task's record into every reviewer turn and into the findings wake (`review-verdict`): each review round's verdict, head and finding lines, the captain's card answers and replies on the builder's task word for word, and each live-validation answer with whether an approved gap still covers the latest run (`docs/delivery-rigor.md`, "The review history").
Its one home is the wake and the reviewer's brief, never the core.

What the first mate is now told changes in two wakes:

- The findings wake carries the section, so the first mate reads what was decided before it carries a finding to a card.
- A builder report's open-review step (`REVIEW_NEW_HEAD_NEXT`) no longer asks the first mate to list declined findings under `user_chose_to_ignore`: the app writes them into every reviewer turn, so the steer never retypes them.

The core's sentence that carries the captain's latest decision into every fix and review steer is unchanged, and the fixed context does not grow: wakes and briefs cost their words only when they arise.
