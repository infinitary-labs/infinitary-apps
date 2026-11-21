`inf:session:open` takes an optional `reattach` in its spec: the computer only keeps the conversation it holds, running or idle with the same contract, and otherwise opens nothing and answers `needsOpen` with no `state`.
`inf:session:delete-outside` takes an optional `holdReopen`: the computer lets go of the conversation without opening it again, and answers `reopen` for the home to open it.
A home sends either only to a computer that lists this change, so the home routes a new conversation before the computer opens one (docs/helper.md, "A model that left every level").
An older computer ignores both and opens as before, and an older home never sends them, so it always reads a `state` from an open.
