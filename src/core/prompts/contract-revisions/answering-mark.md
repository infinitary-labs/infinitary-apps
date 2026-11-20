# The answering mark

INF-1610 piece 1, from the captain's Approve and build on the plan for robust answer delivery: every card about one of the captain's messages shows that message, drawn by the app from the saved message rather than from how an author wrote its Why.
`emit_card` gains a top-level `answering` parameter, the author's mark that the card answers the captain's message it is about, repeated on each revision because a revision without it removes it.
Its one home is that parameter's description, which the first mate and crewmates read alike.
The new parameter costs the fixed part about 20 tokens by the app's count, which keeps it inside its budget.
