# The personalize feed line is said once

INF-1316: the main line's fixed context counted 19,773 tokens against its 19,772-token boundary, so `tests/firstmate-fixed-context.test.ts` failed there and held every pull request's unit checks.
`personalize`'s description drops its last sentence, "Applied changes leave one feed line, never a card.", which the core's operate case already says: removing a surface is one personalize call, and the feed line is the whole answer - no card.
The core is that rule's one home, and the test's ledger now names it there.
No rule, tool, parameter or wake is added; the fixed context shrinks by about 13 tokens, to 19,760.
