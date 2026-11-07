# An answer is the first mate's own card

INF-2714; the captain chose "Approve and build" on direction A ("answers are mine, filed as my own answer"), scope all (notes and decisions) and record related.
The first mate had been answering a question under the task it was about, so the card's head, its asked line and its record all claimed the task's metadata for an answer that only related to it.

What the first mate is now told:

- Every turn is about a task: it passes that task's `task_id` to a tool that acts on it - a steer, a settle, a decision's buttons - and names it on an answer only in words and in `related`.
- `emit_card` passes `task_id` only when the buttons act on that task, as a settle effect needs, or with `review_task_id`; its cards are headed first mate.
- The new top-level parameter `related` names the tasks a card mentions, by id or key; each one's record links to the card's own record.
- A note with `task_id` and no `review_task_id` is refused, and the refusal says the way out: drop `task_id`, name the tasks in words and pass them in `related`.
  An unknown `related` task is refused as an unknown `task_id` is.
- The `standalone` parameter and its refusal are retired: a note with no task is the first mate's own answer, filed as a `question` task.

Homes: the rule on `task_id` is the core's, the card's own head is the `emit_card` description's, the link is the `related` parameter's, and the note rule is its refusal's; none is said twice.
The fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`): the retired `standalone` parameter and refusal pay for most of the new words.
The host adds no matcher: which tasks an answer relates to stays the first mate's judgment, and the host only resolves the ids it was given.
