# A zod-owned parameter serves its shape, and its owner keeps the limits

INF-2441's review of a day's development found the crewmate's fixed context at 26,621 of its 26,624-token boundary on Claude Careful pull-request work, and two repairs that day had trimmed words to fit.
The captain chose "Win back room in the crewmate's fixed instructions" on its card.
`zodParameter` (`src/core/session/tools.ts`) now leaves out a string's length, an array's item count and an object's closed flag, the limits only a validator reads.
Each tool parses such an argument with the same zod schema, which refuses a value past one and names its path, so no limit stops being enforced; `open_change` now parses its whole input that way too.
A pattern, a number's bound, an enum, a constant and the required fields stay, since a model writes a value from them, and the counts that matter for a change story stay in the `story` description.
No rule leaves any text: the five parameters are `report`'s `validation`, `emit_card`'s `required_actions`, `prepare_change`'s `story`, and `open_change`'s `recovery` and `around`.
The first mate's `emit_card` `required_actions` is one of them, so its fixed context shrinks by 110 tokens, to 19,114 (`tests/firstmate-fixed-context.test.ts`).
A crewmate's shrinks by 1,104 or 1,105 tokens for every runtime and kind of work, to 25,517 at its largest (Claude, Careful pull-request work), 1,107 under the unchanged boundary (`tests/crewmate-fixed-context.test.ts`).
