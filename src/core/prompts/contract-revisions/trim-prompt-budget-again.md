# The served prompts come back under their budgets again

The prompt-budget check on main failed after the first trim merged: more additions to the served text pushed the first mate's core past 19,772 tokens and a crewmate on Claude at the reviewed tier past 26,624.

What changed: wording only.
Card authoring, the handoff, the care guidance, the validation resource rule and several tool descriptions say the same rules in fewer words, and the tests that pinned a sentence now pin its shorter form.
No rule is removed, and no test is weakened, skipped or deleted.

Home: unchanged for every rule.
The fixed context shrinks by about 170 tokens for the first mate and about 360 for a crewmate on Claude (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
