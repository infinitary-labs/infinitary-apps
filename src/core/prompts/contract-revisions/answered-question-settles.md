# An answered question is settled

INF-6523's plan, built by its follow-on task: a reviewer raised a question the captain had already answered on its earlier Review finding card, under a new card id.
Its round's decisions dated from the round's start, the captain's answer went to the builder only, and its read of the earlier card said only that the card was closed.
The captain chose to keep a refusal at `emit_card` as a backstop and to give it a careful review.

- The `tasks` card read of a closed card carries `ended`: how it ended, by whom, when, the choice and the answers.
- The crewmate's card rules gain one sentence: a question the captain answered on a card is settled, so read that card before asking it again and act on its answer.
- The reviewer's Review finding round (`REVIEW_CARD_RULES`) says to read an earlier round's card before asking its question again, that the round's decisions date from its start, and that an answer settles the question.
- A builder's report wake names its reviewer's open Review finding cards, so the first mate asks nobody for a card already up.
- `emit_card` gains `asks_again` `{ card, why }`, served bare in the shared parameters: its refusal of a repeated question says when to pass it, so the first mate's fixed context grows by the parameter's name and shape alone, a few tokens.
