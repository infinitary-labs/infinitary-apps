# The Anything else? box

INF-680, built on the captain's Approve and build: every decision card whose author can read a reply carries the app's own Anything else? box, pinned between the body and the buttons.
Its words ride whichever footer button the captain clicks as the answer named `anything_else`, marked written in, on the path answers already take: the author's wake, the card row, the task's `card_resolved` event and the Firstmate's resolved-card line.

A crewmate's card authoring text (`CARD_AUTHORING`) gains one sentence after the paragraph on questions in the body: the app adds the box, its answer is called `anything_else`, and an author never names a control that or adds a box of its own for further comments.
The Firstmate's fixed context stays as it was, at its budget (`tests/firstmate-fixed-context.test.ts`): it reads the box's answer by the rule it already has for an answer marked written in, and the card lint names the reserved name if it ever uses it.
The card lint refuses a decision whose body names a control, or stages a setting, `anything_else`, with the fix named.
