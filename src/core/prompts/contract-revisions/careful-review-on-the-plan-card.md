# A plan card asks which parts get a careful review, the recommended ones ticked

Piece 4 of the smoother-delivery plan; the captain chose "Approve and build" with careful review chosen "On the plan card, as a list you can change", and wrote in: "when there are pieces that are recommended to do careful review, their checkbox should be checked by default."
The plan's audit found that six parts of two multi-part plans had Review carefully pressed only after they were built, each adding a second merge card 51 minutes to 4 hours later.

What the crew is now told, in the handoff text (`HANDOFF` in `../cardContract.ts`, crew half):

- A plan card with more than one part asks one optional checkbox question listing every part for a careful review, with a reason beside each recommended part.
- The recommended parts arrive checked and marked `data-inf-recommended`: the one exception to choices arriving unpicked (contract 4.56), which the lint already allows because the question is optional.
- Its fieldset is marked `data-inf-options-only`, since ticking none means none.

What the first mate is now told, in the same text (first mate half), beside filing every piece in the approval's turn: a part the submitted careful-review answer ticks is filed with `rigor_ask` reviewed, and an unticked part keeps the project's default.

Homes: both rules are the handoff text's, and neither is said elsewhere; Review carefully on merge cards is unchanged.
The host adds no refusal or parser: which parts to recommend stays the planner's judgment, and the rigor each part is filed at is read from the captain's submitted answer by the first mate.
The fixed context grows by about 30 tokens for the first mate.
