# The revision answer keeps one home per part

INF-1656: the main line's fixed context counted 19,786 tokens against its 19,772-token boundary once the answering mark joined `emit_card`, so `tests/firstmate-fixed-context.test.ts` failed there and held every pull request's unit checks.
INF-1623 named the homes of its rule (the rule in `CARD_REPLY`, what the answer holds in the `reply` parameter) but served both parts in both texts.
`CARD_REPLY` drops "saying what changed where", which the `reply` parameter still says, and the `reply` parameter drops "required on every revision while answering", which `CARD_REPLY` still says.
The test's ledger names each part's home, so dropping it there too fails the test.
No rule, tool, parameter or wake is added; the fixed context shrinks by 18 tokens, to 19,768.
