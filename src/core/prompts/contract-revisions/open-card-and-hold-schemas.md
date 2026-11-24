# Three nested schemas stay open where a description already says their shape

The prompt-budget check on main failed with the first mate's core and the crewmate's largest row over their budgets.
A merge card's `risk`, its `required_actions` entries, each action's `until` details and `update_task`'s `hold` were each served as a full nested schema beside a description that already names every field.
They are now served as open objects, `until` keeping its `kind`, and the host reads each field with a default or refuses a missing one by name, as it already did for a card's actions.
`risk`'s description now says each dimension is `{level, why}`.
`update_task`'s `hold` also refuses a missing `reason` or a half-named event in its own words.
Every rule the descriptions carried is unchanged, and a few phrases in the `prepare_change` and `show_merge_card` descriptions and the Testing rules runbook read shorter.
