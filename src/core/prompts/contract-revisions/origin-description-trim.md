# The origin description leaves the refusal's rule to the refusal

The prompt-budget check on main failed with the first mate's core 10 tokens over its budget, after the automation-start revision added a sentence to `create_task`'s `origin` description.
That sentence said the same thing as the refusal, which already names each run and says to name one with `origin`.
The description drops it, so the refusal is the one home of that rule.
The first mate's core reads 13 tokens under its budget, about 23 fewer than before this change.
