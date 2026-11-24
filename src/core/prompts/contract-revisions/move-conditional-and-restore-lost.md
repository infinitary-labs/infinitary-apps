# Move what only some work needs, and restore lost instructions

Part 3 of an approved plan from an audit of recent prompt-budget trims: the first trim under "How a trim works" (`docs/orchestrator-contract.md`).
The captain chose to raise only the first mate's budget, by half, once its always-needed rules no longer fit, and to keep a crewmate's.

Moved to pages read when needed:

- `report`'s `validation` (crewmate): the typed shape of a validation record, about 1,300 tokens, moves to `validation-shape.json` in the careful-change skill, generated from the schema the host parses with. The field keeps its rules and says "Before writing one, read its JSON Schema, validation-shape.json in the careful-change skill."
- `lint_panel`, `place_panel` and `capture_panel` (crewmate): what each answer means and asks moves to the personal-panel skill's "Before you report", which each tool now names. The compiler's verdict, the rail keeping the last commit, the answer words and the running dot are new lines there; the not-drawn and folded cases were already said there ("never collapse, move or hide his other panels", "with `waiting_on_captain`, so the task waits for him instead of closing as done").
- `check_change`'s `batch` (crewmate): what happens after each declaration moves to the batch-repair skill, which the field tells the repairer to read first; the skill already says each outcome.

Removed as repeats:

- `correction_case` (first mate): what each op does, which the correction-review wake's words say for each case ("Use correction_case inspect with inputId to read the source-time text", "use correction_case offer with the exact proposed text and intended project", "Keep the offer separate from the original task's approval and merge", "use correction_case ignore with a reply telling the captain why it was not kept", "After Keep, use the existing app_change direction writer with the offered stable identifier, exact wording and scope", "Read before retrying an uncertain write"). The description keeps what the wakes do not say: recover confirms only a matching saved revision, and guide with no task ids interrupts no one.
- `link_tasks` and `create_task`'s `needs_merge` (first mate): when a batched pull request starts a waiter, which the core's wait rule says ("on batched pull requests the start comes at that task's merge approval: when the waiter needs it merged, such as for a release, add that wait with update_task blocked_by and needs_merge in one call instead").

Restored, from the wording a trim removed, for every loss the audit lists that part 1 did not restore:

- First mate: "here or on a work computer" on a quit, restart or update; "a one-project skill stays in that project", which had come to point at the personal workspace; "Policy edits never start/restart work."; "reported crew need"; the eight clauses an earlier first mate trim dropped (the list of what saved knowledge holds; "portability"; "on an available model"; "Refusals name blockers."; "Hold keeps work started;"; "eligible" and "current work"; "Ask only unclear task/scope/consent"); kept files "as the captain or its crewmate named them"; "First mate/Decisions stay Standard."; "Unavailable: explained Standard, same model/account."; "never steer it to stay idle"; a schedule's "Closing words are its found line. Draft if details open." and its event screen's skipped turns; a replaced-by link as the record of every move of work to another task (drop, takeover, fresh task); "checks/reviews" among a task's reads; an ask_id named "at any step" from a card's click or a work's report; the window's Mac "that controls this one"; a reply that ends a card "so the message it answers counts it"; a batch's repair task that "the host records"; a moved task "on the same model".
- Crewmate: "baggage" in a purchase review; "never omit evidence" and "even a draft" on a failed upload; "Held writes are read first; a closed story PR stops publication."; "explain renamed jobs" and "Facts list absent repair checks without guessing replacements." when settling a check; a review of a pull request "in the project your current change is in"; "logs over 8 MiB are refused. offset and limit need jobId."; a story's "Omit empty sections and boilerplate.", its drawn figures' raster exports and the host's kept copies; a first release's "or call unknown unshipped" and "evidence explains the correction"; a page button's "with the captain in control"; an optional improvement's examples; "To the captain a level is the task's difficulty"; "nothing outside it is your concern"; "a scratch signing folder"; a picture gap "not a claim it proves the result" and a revision answering a picture complaint; "equivalent" disposable data and "the named sign-in through the app or program that holds it"; the testing guide's "request its prescribed sweep" with "any missing coverage" and "name its source in the test"; and Default rigor's "whether a person will see the change", "state" and retakes after "updates"; and the pull request comments guide's reply sentence, mended to "what you changed or what was chosen, written for a stranger".

Two restored sentences decide what reaches the captain or consent, so each fixed-context test's protected list gains its entry: update_task's "Ask only unclear task/scope/consent; refusals name blockers." and the crewmate's "Use the named sign-in through the app or program that holds it."

Not restored, because today's text says them:

- How to add a wait when linking tasks: the core's wait rule, "add that wait with update_task blocked_by and needs_merge in one call instead".
- "never use this for progress or news" on asking the first mate: its description says "not progress or news".
- "check may name a renamed job, explained by evidence": check_change says "explain renamed jobs".
- "On ignore of a chosen instruction, explain why it cannot be saved.": the correction-review wake says "use correction_case ignore with a reply telling the captain why it was not kept".
- "A parent holds its steps and never builds": create_task says "Leave a parent on request: its children do its work."

Not restored here, because a test holds the text word for word and only the captain's approval changes it, in a change of its own:

- The plan hand-over's "Read-only limits the planner, not its authorized successor.", "Record their facts if needed, then stop; a closed answer is acknowledgement, not build permission.", "Start bounded work only when the settled scope authorizes it.", "the last included" and "a child task delivers what its goal names": the hand-over's digest in `piResources.test.ts`.
- A preview's "The card's own answer, explanation and questions keep the app's look." and a plan card "with more than one part" for "several parts": the card authoring digest in `piResources.test.ts`.
- "Name patterns elsewhere in your report": `piResources.test.ts` holds "Name patterns in your report, never fixing or copying them."

The first mate's budget becomes 29,658, half again the 19,772 derived from the 64K window, with its hard line a quarter over it at 37,072, so that window still promises a 23,590-token conversation at the budget.
The crewmate's budget stays 26,624 and its largest reading goes from 27,191 to 25,906 tokens with the restorations, 97% of it; the passages it still serves that only some work needs are held word for word by tests and move in a change of their own.
The first mate's reading is 20,045 tokens with the restorations, 68% of its raised budget.
