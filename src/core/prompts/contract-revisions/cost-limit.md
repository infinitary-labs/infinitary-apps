# A task stops at its cost limit and the captain's words move it

INF-3131, piece one of INF-3112's approved plan: a task, and everything under it, that passes its cost limit in estimated dollars stops at a safe point and the app asks on its own card, which the first mate answers.
`update_task` gains one top-level parameter, `cost_limit`, the only home of its rule: the captain's words alone set a task's own limit, in dollars, `none` for no limit, or `follow` to go back to its project's or the app's, and a limit that now clears a standing cost hold lifts it.
The holds registry gains a soft `cost-limit` hold, so the existing `override` parameter passes it on the captain's words with no new words of its own.
