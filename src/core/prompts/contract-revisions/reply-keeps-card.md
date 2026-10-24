# A reply never moves a card

INF-770's approved direction A, with the captain's answers: a reply never moves a card, Put aside and Close are the only ways a card leaves, and each says what it does.
`CARD_REPLY` now tells every author that the captain's reply keeps the card on his screen beside its thread, instead of taking an unmarked card off the stack until the answer.
The thread steer's preamble (`THREAD_STEER_PREAMBLE`) says the same to a crewmate.
The `holds_place` parameter now only brings a marked card forward when it arrives, since every card keeps its place on a reply.
The fixed context shrinks by a few tokens; no tool, action or wake is added.
