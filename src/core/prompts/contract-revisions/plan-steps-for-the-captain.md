# A plan's steps for the captain become their own tasks

INF-7250's finding 3, which the captain chose to start ("i assume this just means every user step is its own task, with the right dependency chain setup?").
A plan whose second part was the captain's own request to Google kept that part only as a line in the first mate's chat: no record held it and no card asked for it until the captain asked why.
A merge card already declares the steps only the captain can do, and its merge makes each one its own task with its own card (`docs/required-actions.md`); a plan card had no such declaration.

What the first mate is now told:

- `emit_card`'s `required_actions` says a plan card declares its steps only the captain can give the same way, and that they wait for approval, not a merge.
- HANDOFF tells the planner to name each step only the captain alone can give there, never one the crew can do, and to put up no card of its own for one.
- HANDOFF tells the first mate, in the approval's turn and before filing the pieces, to call `update_task start_steps` on the plan and to file each piece that waits on a step blocked by that step's key; a saved plan starts its steps only when its build starts, and Abandon starts none; it puts up no other card for a declared step.
- `update_task`'s new `start_steps` parameter says what the call does and that it answers the steps' keys, with a second call filing nothing new.
- HANDOFF's sentence on a captain-only action now leaves out a plan's step already its own task, so its builder does not ask for it again.

Homes: the declaration's shape is `emit_card`'s `required_actions`; the call is `update_task`'s `start_steps`; when to call it, and what the planner names, are HANDOFF's; none is said twice.
The host decides nothing about approval: it keeps the declaration on the plan and starts the steps only on the first mate's call, which reads whether the captain's choice approved the plan.

The altered sentence, marked:

1. prompt
   - Before: At a captain-only action, its crewmate asks on a card; design-only limits even a filed build.
   - After: At a captain-only action, its crewmate asks on a card, unless it is a plan's step already its own task; design-only limits even a filed build.
   - Mark: kept (says all it did, and leaves out a step the plan's approval already made a task).

The new words cost the first mate's fixed context about 170 tokens, inside its boundary (`tests/firstmate-fixed-context.test.ts`).
