# What reaches the captain leaves only the captain's part

INF-4186, the captain's question of why a review card offered the captain a step the crew could do, and the captain's choice of the shorter, outcome-stated version over four case-by-case rules.
A reviewer wrote a way forward as a captain-only step without checking it, and the first mate quoted it as an option; the shared rule said "never ask" and "check first if it is done", which neither read as covering an option or a step they wrote.

What the first mate and every crewmate are now told, in `FLEET_WORK` (`src/core/prompts/fleetWork.ts`), its one home:

- Whatever reaches the captain - a question, an option, a step - leaves them only what the fleet cannot do.
- Everything else is done or checked first, by the agent or through a crewmate, and the agent looks for a way that needs nothing from the captain.

The captain-only list is unchanged word for word, so consent, sign-in and signing boundaries do not move.
No recipe, tool description or wake changes; the review card recipe keeps quoting the reviewer, and the outcome now governs what the quoted option may hand the captain.
The fixed context grows by about 10 tokens.
