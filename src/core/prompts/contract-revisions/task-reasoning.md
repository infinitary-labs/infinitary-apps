# A task's own reasoning effort

FI3-1812, filed on the captain's words "file a task to allow overriding reasoning effort level at task level", and started again as its replacement: the captain can name the reasoning effort for one task the way he names its model, and the model's choice in Settings → Models stays as it was.
`spawn_crewmate`'s `shape` group gains `override_reasoning`, and `update_task` gains a top-level `reasoning`: low, medium, high or xhigh, and on `update_task` null, which follows Models again.
The rule rides the new parameter's own description, which the shape group's rule points at: only the captain names it, it applies when the open task starts, and the host refuses it once a crewmate holds the task.
The host opens that task's crewmate at it in place of the Settings choice and the level's default, capped to what the model offers, and Quick care does not step it down.
So that `direction`'s shorter words stay true, the record now names the standing direction behind a crew speed or reasoning edit too, as it does for a model, Runs on or policy edit.

The new words cost about 81 tokens.
They are paid for by saying four rules once: `update_task`'s delivery, autonomy and rigor no longer repeat the description's "project resets overrides", its `direction` no longer repeats the core's list of the edits a direction applies through, the shape group's `override_speed` rule points at `update_task.crew_speed` the way `runs_on_ask` points at `runs_on`, and `personal_ui` points at the tool description that already says what it is for.
The fixed context went from 19,741 to 19,740 (`tests/firstmate-fixed-context.test.ts`), and its budget is unchanged.
