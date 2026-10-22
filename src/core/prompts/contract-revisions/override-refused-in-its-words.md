# An override naming a hold it cannot pass is refused in that hold's words

INF-762, found while running the agent's-reach story (INF-495): `update_task override` listed only the holds the override passes, so a first mate that named a fixed limit, such as `host-rules`, was stopped by the schema check with "must be equal to one of the allowed values" on Pi, or "Invalid option" on Claude, and never read which fact holds it.
`docs/delivery-rigor.md` says every refusal ends with its hold's sentence.
`override.holds` now lists every hold kind, and the tool refuses an override naming a fixed limit, or a soft hold with its own way (`escalation`, `start-waits`), before anything is recorded and before the turn's consent is read.
The refusal says nothing was recorded and ends with each such hold's own sentence (`overrideRefusal`, `src/shared/holds.ts`), so a call that also names soft holds records none of them.
The rule's one home is that refusal; the parameter's description is unchanged.
The fixed context grows by the seven names in the list, 97 characters or about 25 tokens.
