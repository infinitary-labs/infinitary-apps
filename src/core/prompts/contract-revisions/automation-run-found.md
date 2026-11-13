# What an automation run found, and waiting on events

From INF-3926's finding 1, as the captain started it: a promise to tell the captain when something reached a release was kept by an hourly clock rule that checked, and its history showed only that each run was handled, not what it found.

`schedule_prompt`'s description now tells the first mate two things.
When an integration's event announces what the captain asked to hear about, such as a workflow run finishing, it uses `on_event` rather than a clock rule that checks.
A run's history keeps its closing words as what the run found, so those words say what it found.

Home: the `schedule_prompt` tool description, the one place the first mate reads how to make a rule.
The two sentences add about 50 tokens to the fixed context.
