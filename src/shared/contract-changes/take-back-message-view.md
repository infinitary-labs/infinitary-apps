# Taking back a message: what a view draws

Each round of the last turn above the input takes a new optional field, `sentAt`, when the core accepted the message, which the one-minute take-back window runs from.
A message round of the conversation takes two new optional fields: `takenBack`, true once the captain took the message back, and `replaces`, the words of the message it replaced.
The `user_turn` push takes the same two optional fields as a round, `askId` and `sentAt`, so a message sent from anywhere can be taken back without a reload.
The `firstmate_reply` push takes two new optional fields: `askId`, the message the line stands beside (the newest, or a message the captain took back, whose undo the turn did or no turn read), and `withdrawn`, true when the captain took the message back before any turn read it.
A reply line, in a round and in the conversation, takes the same optional `withdrawn`; a view words that line in its own language, and its `text` keeps the same catalog words in English for a view that words nothing itself.
An older view ignores the new fields, and draws an undo turn's line beside the newest message.
An older core sends none of them, and a view shows no take-back control for a round without `askId` and `sentAt`.
