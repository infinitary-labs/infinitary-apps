# Every option names what it gets and what it costs

INF-4798, the captain's question of why a plan card offered them a direction that gained nothing over the recommended one, and their choice of the wording that asks only decisions where they give something up whichever answer they pick.
The plan line told planners to "propose two or three directions", and no served sentence said what an option must offer, so a planner filled the count with a direction that covered exactly what its recommended direction covered.

What the first mate and every crewmate are now told:

- In `FLEET_WORK` (`src/core/prompts/fleetWork.ts`), its one home: every option under a question is a choice the captain would seriously consider, because choosing it gets something the others do not and gives something up, and its label says both. An option that gets nothing the recommended one does not already give is left out, and a question left with one option is stated as a fact, not asked.
- In the plan line of the Common workflows guide (`resources/runbooks/sequences/guide.md`, with its packaged twin `PLAN_STEP` in `src/core/personal/sequencesSkill.ts`), its one home: the count of directions is gone. A planner proposes the plan it would build; its questions are the decisions only the captain can make, where they give something up whichever answer they choose; each option says what it gets that the other answers do not and what it costs; an answer that gets nothing the plan does not already give is one folded line saying why it was ruled out; and a decision the code, the captain's words or the project's rules settle is the planner's to make and say.

Each keeps its home's voice: the guide speaks as the captain ("I"), `FLEET_WORK` names the captain.
Nothing else moves: the As built option on review finding questions, the Something else row, the recommended mark, optional questions, rounds and the plan card's buttons stay as they were, and no check reads an option's words.
The first mate's fixed context grows by about 85 tokens for the `FLEET_WORK` sentence, which takes the core past its budget though well under its hard line, and the Common workflows guide read with it grows by about 100 tokens.
