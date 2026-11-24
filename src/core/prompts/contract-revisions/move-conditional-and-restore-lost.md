# Move what only some work needs, and restore lost instructions

Part 3 of an approved plan from an audit of recent prompt-budget trims: the first trim under "How a trim works" (`docs/orchestrator-contract.md`).
The captain chose to keep both budgets for now and raise them only if the rules every task needs do not fit.

Moved to pages read when needed:

- `report`'s `validation` (crewmate): the typed shape of a validation record, about 1,300 tokens, moves to `validation-shape.json` in the careful-change skill, generated from the schema the host parses with. The field keeps its rules and says "Before writing one, read its JSON Schema, validation-shape.json in the careful-change skill."
- `lint_panel`, `place_panel` and `capture_panel` (crewmate): what each answer means and asks moves to the personal-panel skill's "Before you report", which each tool now names. The compiler's verdict, the rail keeping the last commit, the answer words and the running dot are new lines there; the not-drawn and folded cases were already said there ("never collapse, move or hide his other panels", "with `waiting_on_captain`, so the task waits for him instead of closing as done").
- `check_change`'s `batch` (crewmate): what happens after each declaration moves to the batch-repair skill, which the field tells the repairer to read first; the skill already says each outcome.

Removed as repeats:

- `correction_case` (first mate): what each op does, which the correction-review wake's words say for each case ("Use correction_case inspect with inputId to read the source-time text", "use correction_case offer with the exact proposed text and intended project", "Keep the offer separate from the original task's approval and merge", "use correction_case ignore with a reply telling the captain why it was not kept", "After Keep, use the existing app_change direction writer with the offered stable identifier, exact wording and scope", "Read before retrying an uncertain write"). The description keeps what the wakes do not say: recover confirms only a matching saved revision, and guide with no task ids interrupts no one.
- `link_tasks` and `create_task`'s `needs_merge` (first mate): when a batched pull request starts a waiter, which the core's wait rule says ("on batched pull requests the start comes at that task's merge approval: when the waiter needs it merged, such as for a release, add that wait with update_task blocked_by and needs_merge in one call instead").

Restored, from the wording a trim removed:

- First mate: "here or on a work computer" on a quit, restart or update; "a one-project skill stays in that project", which had come to point at the personal workspace; "Policy edits never start/restart work."; "reported crew need".
- Crewmate: "baggage" in a purchase review; "never omit evidence" on a failed upload; "explain renamed jobs" when settling a check; and the pull request comments guide's reply sentence, mended to "what you changed or what was chosen, written for a stranger".

Not restored, because the first mate's text has no room left under its budget: the eight clauses an earlier first mate trim dropped (the list of what saved knowledge holds; "portability"; "on an available model"; "Refusals name blockers."; "Hold keeps work started;"; "eligible" and "current work"; how to add a wait when linking tasks, which the core's wait rule already says), kept files "as the captain or its crewmate named them", "First mate/Decisions stay Standard.", and the other first mate losses the audit lists.

The crewmate's largest reading goes from 27,191 to 25,664 tokens on today's main, 96% of its 26,624 budget. The first mate's falls by about 90 tokens but stays over its 19,772 budget at 19,846, after changes merged since the trim began.
What only some work needs and is still served is held word for word by tests, or has no page the first mate reads, so the trim stops and the captain is asked about the budget.
