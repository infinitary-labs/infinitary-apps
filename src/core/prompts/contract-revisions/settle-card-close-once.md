# Closing a settle card is said once

INF-1386: the main line's fixed context counted 19,776 tokens against its 19,772-token boundary after the direction lifecycle rule grew, so `tests/firstmate-fixed-context.test.ts` failed there and held every pull request's unit checks.
`settle_task`'s description drops "Closing the captain's settle card keeps an idle task resumable.", which the core already says: closing a card is keep, and an idle crewmate that finished its work stays resumable until you merge or discard it.
The core is that rule's one home, and the test's ledger now names it there.
No rule, tool, parameter or wake is added; the fixed context shrinks by 16 tokens, to 19,760.
