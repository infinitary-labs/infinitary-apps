# The reviewer raises its own Review finding card

INF-4338's accepted direction D, built by INF-4343: an ask-user finding goes back to the reviewer that read the change, and the reviewer puts it to the captain on its own decision card.
The captain chose a plain seriousness tag (Serious, Worth fixing or Minor), the finding as recorded folded on the card with its file and version, and no first mate read of each finding first.

The review-findings wake (`reviewFindingsNext`) loses the card recipe that `review-finding-attribution.md`, `as-built-option.md` and `review-option-sizes.md` gave it.
It now tells the first mate that an ask-user finding is its reviewer's to put to the captain, with an answer the host sends to the builder, so it raises no card for one; the wake reaches the first mate only for a blocked review or a no-op finding that blocks, which it settles with the reviewer or the builder.
The card's rules move to the reviewer's handoff (`REVIEW_CARD_RULES`), served only to a reviewer whose verdict holds an ask-user finding: the question in plain words with no file or code name, the seriousness tag, one figure of what happens now drawn from the change, one short option per way with its size, the As built and Recommended marks, the reviewer's pick and reason on one line under the options, and a fold titled The finding as recorded.
This amends INF-63's choice to show the reviewer's words in the open.

`review_task_id` stays on the first mate's `emit_card`, unchanged in its one home.
The fixed context does not grow: the wake is operational, and its words shrink.
No tool or card action is added.
