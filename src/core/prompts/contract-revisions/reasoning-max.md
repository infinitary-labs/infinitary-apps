# Max reasoning

INF-7003 found that a model whose top reasoning level is Max, such as GLM-5.3, was held at High, because the app's reasoning levels stopped at Extra high.
The captain chose Max as its own reasoning choice above Extra high, offered only where the model lists it.
`spawn_crewmate.shape.override_reasoning` and `update_task.reasoning` now take `max` beside low, medium, high and xhigh; their descriptions are unchanged, and a model without Max caps it to the most it offers, as with any level.
