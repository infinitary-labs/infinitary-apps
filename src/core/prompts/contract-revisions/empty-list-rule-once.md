# What an empty blocked_by declares is said once

INF-461, from the captain's choice on the audit assessment (INF-460).
Piece I said that `[]` declares no prerequisites in one place, and piece K said it again on `update_task`'s `blocked_by` and in the queued-work refusal.
The first mate is again told it once.

- That `[]` declares none is `create_task`'s `blocked_by` parameter.
- `update_task`'s `blocked_by` parameter is "As create_task's blocked_by", and the refusal of an undeclared queued call says to declare it "as create_task's blocked_by says".
- That a queued update must carry `blocked_by` stays on `update_task`'s own parameter, since piece K's first live run omitted it when that parameter only pointed to `create_task`'s.

The fixed context shrinks by 2 tokens, to 19,735 (`tests/firstmate-fixed-context.test.ts`), which now also checks that no other text served about a tool taking prerequisites says what `[]` declares.
