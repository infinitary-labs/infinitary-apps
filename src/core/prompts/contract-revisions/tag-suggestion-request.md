# A Suggest tags press carries a typed note into the first mate's turn

The approved Suggest tags plan, with the captain's answers: the person reviews and adjusts the suggestions on the first mate's card, changed by reply, and there is no trial on sample tasks before the card.
A captain turn sent by the Suggest tags button in Settings → Projects (`inf:projects:suggest-tags`) now carries one added note after the words, `[tag suggestion request]` (a wake: the `tagSuggestion` fact of the captain turn, worded by `tagSuggestionNote`, `src/core/orchestrator/tagSuggestionNote.ts`).
The press adds it, never the words: typing the same words adds nothing.
The note names the project's name, key and id; how many tasks each check reach holds; whether Tag tasks automatically asks now and who answers, or that it is off and the card leaves the check question out; and the steps: read the open tasks with the tasks tool, propose 8 to 14 described tags with example keys, put up one decision card, revise it by reply, add the ticked tags with `project-tags` and start `project-tag-check` on the click, never tag a task itself.
The note is the one home of these steps; nothing is added to the prompt, a tool description or a runbook.
It costs about 500 tokens on a Suggest tags turn only, and nothing in the fixed context.
