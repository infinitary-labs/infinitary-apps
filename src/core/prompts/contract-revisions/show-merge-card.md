# show_merge_card

INF-3717 found that a crewmate needs three calls in a fixed order to show a merge card - prepare_change, open_change, then emit_card with presentation - and that each call could refuse for a step another call or another person supplies, so a crewmate could loop for a long time without learning what was missing.
The captain chose direction A: one call that shows the merge card or names the one thing missing.

- A crewmate tool, show_merge_card, served to Pi and Claude crewmates whose task ships a change, on this computer and on a computer that runs work once it lists the `show-merge-card` change. Its description names the steps in order: work committed, story words, branch pushed at that version, review and live proof at this version, pull request open, story published and read back, checks passed, no open waits, card shown. It takes an optional story, the card id, the card's reply and interim, after, asks_first and since_seen, and builds the one merge action itself; it takes no body, risk, required actions or actions.
- The call does the app's own steps - preparing the given story, preparing the same words again once live proof was accepted since, opening the pull request and publishing the story there and reading it back - and stops at the first step someone else supplies. Its answer names what it did, the missing step and who supplies it: the crewmate, the reviewer through the first mate, the first mate, the captain or the checks. Called again it repeats nothing.
- The card goes up under the id given, revising the open card; after the captain answered a card under that id, under a new id with a numbered suffix.
- The builder's brief: the direct-pr and queue-pr delivery lines name show_merge_card after git push, or open_change where it is not served.
- The delivery guidance and the Careful guidance name show_merge_card where they named open_change and emitting the merge card.
- emit_card's presentation parameter: its saved-story rule opens by saying show_merge_card does it all in one call, and that the rest of the rule is for where it is not served.
- The first mate's own tools and prompt are unchanged; its fixed context does not grow. A crewmate's fixed context grows by the new tool's definition, which repeats prepare_change's story parameter.
