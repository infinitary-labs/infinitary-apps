# The work a reply started is named under its card

INF-3071's plan, its second change (the captain's pick "Yes, as a second change that starts once this one merges"), from INF-3060's finding 5: three replies on crewmate cards went to the first mate, and nothing in their threads said what became of them.
`spawn_crewmate` takes a top-level `from_card`: the card whose thread holds the captain's reply the new work answers, the first mate's own or one a crewmate's report names.
The app then writes a line in that card's thread naming the task, under an ended card too; its answer says whether it wrote the line, and a card the captain never replied under gets none.
The rule's one home is that parameter's description.
`CARD_REPLY`'s hand-off, which the first mate reads too, now asks a crewmate to name the card's id in `needs_firstmate`, so the first mate has the id to pass.
The fixed context grows by about thirty tokens, the new parameter and the card id in the hand-off.
