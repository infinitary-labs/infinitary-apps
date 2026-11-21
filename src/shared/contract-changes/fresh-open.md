`inf:session:open` takes an optional `fresh` in its spec: the computer opens a new conversation and never answers the one it holds.
An idle conversation it holds is let go of first; one still in a turn fails the open, which opens nothing, and the home asks again later.
A home sends it for a restart that replaces the conversation, at the model's context limit or after repeated refusals, only to a computer that lists this change; a start asked again after a lost answer is not sent it, so it keeps the conversation that start opened.
An older computer ignores it, and the home refuses an answer that names the conversation the restart replaces (docs/helper.md, "A model that left every level").
