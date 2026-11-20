# The served prompts come back under their budgets after the careful-review rule

The prompt-budget check on main failed after the plan card's careful-review question was added to the handoff text: the first mate's core read 19,802 tokens against its 19,772 budget, and a crewmate on Claude at the reviewed tier read 26,705 against 26,624.
Rules added to the crewmate's text after that, about what a crewmate leaves open before a card, what the captain is asked for, and what a step after a merge may use, brought a crewmate on Claude to about 26,960.

What changed: wording only.
The handoff's careful-review rule says the same thing in fewer words in both halves, and the `ask_id` parameter, served on 16 first mate tools, drops its list of where an id comes from.
`close_card` says its rule about this turn's answer note in fewer words, and `create_task` and `update_task` point their branch parameter at `spawn_crewmate`'s.
For crewmates, `show_merge_card` points five parameters at `emit_card`'s and the merge effect's, `report` says its autonomy rule in one sentence, and a picture's faults field keeps only what each cause means, since the story's rules say the rest.
Also for crewmates, the rule about what is left open, the card-authoring passages on what the captain is asked for, the reply field, pictures, a preview's look and the project's language, and the guidance on saving a source say the same in fewer words.
The tool descriptions of `check_change`, `read_workflow`, `github_read`, `prepare_change`'s after-merge `uses` and map view, `browser_page`, `note_progress` and `report`'s `first_release` are shorter, and the saved-story rule leaves which hosts upload media to `open_change`, which now also says when media stay on the card.
After the card-authoring rule for questions the captain may skip was added, both prompts were over again, so the trim also says these in fewer words for every reader: the skip rule, the draft button, the strip on a card with a merge or settle effect, and a runbook's precedence; the time-zone and language rules become one sentence.
For the first mate, the handoff's filing of a plan's pieces, the open-thing hand-off after a crewmate's `needs_firstmate`, and `create_task`'s `origin` say the same in fewer words.
No rule is removed, and no test is weakened, skipped or deleted; the handoff's and the card-authoring text's word-for-word pins now pin the shorter text.

Home: unchanged for every rule except the media-upload rule, which moves from the saved-story rule to `open_change`.
The fixed context shrinks enough to bring both back under their budgets (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
