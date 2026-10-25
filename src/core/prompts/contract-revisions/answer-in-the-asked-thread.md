# Answer in the thread that asked

INF-1273, the captain's "Approve and build": answers to thread questions arrived on other cards, one 22 minutes after it was written, because a crewmate card waits for its turn to end.
The existing `reply` already accepts any card on the crewmate's task, including a first mate card, and paints the line at once, so the fix is instructions only.
The first mate is now told that when the answer under a card of its own on a task needs that task's crewmate, it steers the crewmate with the card's id to reply there, instead of having it show the answer on a card of its own.
`CARD_REPLY` no longer says the captain sees answers when the author's turn ends: a thread answer shows as soon as it is sent, so the author answers once the research it needs is done, before unrelated work.
The crewmate's thread steer preamble says the same, and the `reply` description names a first mate card on the crewmate's task as one it may answer.
No tool, parameter, wake or runtime rule is added; the first mate's and the crewmate's fixed contexts stay inside their budgets (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
