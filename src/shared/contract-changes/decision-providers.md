# Decision models from any signed-in provider

The Decisions view carries `providers`, one row for each enabled, signed-in provider whose catalog lists decision models, such as OpenRouter or OpenCode Go.
The decision model setting may hold a new answerer, `{ kind: "provider", provider, model }`, which a home writes in place of the `openrouter` answerer it still reads.
A home sends both only to a view that lists this change.
To a view from before, it sends the view as that view read it: OpenRouter's row in `openrouter`, an OpenRouter pick as the `openrouter` answerer, and another provider's pick as auto.
A view from before that writes the setting back writes auto for that other provider's pick.
