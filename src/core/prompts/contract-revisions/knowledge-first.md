# Knowledge first, in alpha and development builds

FI3-1141 builds the knowledge primitive the captain approved on FI3-1110 ("can you properly design the verified findings thing? i feel we need a new primitive that models knowledge", Approve and build), gated to alpha and development builds (`docs/knowledge.md`).
Where knowledge is on, the Firstmate holds two more tools, `knowledge` to read and `record_knowledge` to write, and its context block carries `knowledge`: the entries the captain's words match, by id, name, revision and check, never a finding's statement.
Its notes section keeps preference notes only, and `older_notes` counts the facts and lessons behind `source: legacy`.
`remember` keeps its words and adds one sentence: new facts and lessons go to `record_knowledge`, and one already noted may still be revised there; the tool refuses a new or restored fact or lesson.
`record_knowledge` is refused on the output-only retry, and only a write that changed the collection is the turn's action.
The rules the tools carry are in their own descriptions and top-level parameters, so a Claude seat reads what a Pi seat reads, and a stable build is served exactly the contract it was before.
The pair adds about 950 tokens to the alpha and development fixed context (19,446 in the census); the ceiling in `tests/firstmate-fixed-context.test.ts` moves from 18,500 to 19,600, still inside the room the smallest local window must keep for a working conversation.

The ledger entry that comes with it:

FI3-1141. Alpha and development builds serve the knowledge pair, a per-turn knowledge shortlist from the captain's words, preference-only notes in view, and remember's refusal of new facts and lessons; stable builds are unchanged. Fixed context ceiling 18,500 to 19,600.
