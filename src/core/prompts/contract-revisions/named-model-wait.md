# A model the captain named is never swapped in silence

INF-1389's audit found a task the captain asked to run on Fable started on a work computer with no Fable sign-in, on another model, with one line in a reply as the only word of it.
The captain chose to file the fix: a task with a captain-named model is placed on a computer that has that model's sign-in, or the captain is asked, never silently replaced.
The captain then chose that every start waits and asks, not only Automatic.
Automatic placement refuses every computer whose routing does not serve the named model, so neither the ordinary rules nor the decision model starts it elsewhere, and the computer it already chose waits if it stops serving the model.
A start on This computer or a named computer whose routing does not serve the named model waits the same way instead of falling back.
When no computer serves it, the task waits and the new `named-model-wait` wake tells the Firstmate once, naming the model, to ask the captain whether to keep waiting or name another model with `update_task override_model_id`.
Its one home is that wake, sent once per task and model.
A review given a named model routes on it as its pin; when its builder's computer does not serve it, `spawn_crewmate` starts nothing and its refusal tells the Firstmate to ask the captain, since a review has no queue to wait in.
`spawn_crewmate`'s `override_model_id` description, which `update_task` points to, now says the task waits for a computer that serves the named model, adding about a dozen tokens to the fixed context.
