# The served prompts come back under their budgets

The prompt-budget check on main failed after two small additions: the first mate's core read 19,923 tokens against its 19,772 budget, and a crewmate on Claude at the reviewed tier read 26,688 against 26,624.

What changed: wording only.
Unpinned sentences in the first mate's core, the crewmate prompt and several tool descriptions are shorter, and the `ask_id` parameter, served on 16 first mate tools, says its one rule in fewer words.
No rule is removed, and every string the tests and the ledgers pin is untouched.

Home: unchanged for every rule.
The fixed context shrinks by about 215 tokens for the first mate and about 120 for a crewmate on Claude (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
