# Taking back a message

A new request, `inf:conversation:take-back` with `{ askId }`, takes back the captain's newest message to the first mate within one minute of sending it, and answers `withdrawn`, `stopping`, `undoing` or a refusal naming why (`not-newest`, `past-window`, `taken-back` or `unknown`).
`inf:converse` takes a new optional field, `replaces`, naming the newest message the new one replaces: the core takes that message back and opens the new one as its correction in one write.
Each round of the last turn above the input takes two new optional fields: `askId`, the message's id a take back names, and `takenBack`, true once the captain took it back.
An older home has no such request and drops `replaces`, so a view sends either only to a home that lists this change.
A view written before the change ignores `askId` and `takenBack`.
