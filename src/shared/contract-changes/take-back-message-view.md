# Taking back a message: what a view draws

Each round of the last turn above the input takes a new optional field, `sentAt`, when the core accepted the message, which the one-minute take-back window runs from.
A message round of the conversation takes two new optional fields: `takenBack`, true once the captain took the message back, and `replaces`, the words of the message it replaced.
The `firstmate_reply` push takes a new optional field, `askId`, the message the line stands beside: the newest, or a message the captain took back whose undo the turn did.
An older view ignores the new fields, and draws an undo turn's line beside the newest message.
An older core sends none of them, and a view shows no take-back control for a round without `askId` and `sentAt`.
