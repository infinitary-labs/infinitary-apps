# A crewmate can ask the Firstmate to act

FI3-710, grounded on FI3-703 (the captain's "Build the handoff fix").
A captain decision only the Firstmate can carry out - a build he approved by reply, a merge, a discard, a stronger model, unrelated work - reached it only when the whose-turn rule happened to wake it, and a Claude crewmate's report with its card withdrawn sorted `cannot-tell` and sat.
`report` now takes a top-level `needs_firstmate`: what the Firstmate must do, in a few words.
That report wakes the Firstmate on any backend, whatever card is up (`rule:needs-firstmate`, `docs/report-sort.md`), and its wake says the ask authorizes nothing by itself.
`CARD_REPLY`'s settle hand-off and `HANDOFF`'s answer-task relay after a reply name it.
The crewmate's report receipt no longer promises a wake the sort may not send.
The two named relays cost the fixed part about 15 tokens by the app's count; with them it measures 17,500, under the 17,503 budget.

The ledger entry that came with it:

FI3-710, grounded on FI3-703 (the captain's Build the handoff fix).
A crewmate's report may declare needs_firstmate - what the Firstmate must do - and that report wakes it on any backend, whatever card is up, once the captain's reply under the card has its answer.
CARD_REPLY's settle hand-off and HANDOFF's answer-task relay after a reply name it; the report wake says the ask authorizes nothing by itself.
The crewmate's report receipt no longer promises a wake the sort may not send.
