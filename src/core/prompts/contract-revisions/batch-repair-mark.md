# Batch repair mark

The captain found the Batches panel confusing: a held batch showed only that it was held, then the by-hand answers, which read as a question for the captain even while a repair was already working on it.
The approved design has both views say who has the hold, which needs the app to know which task repairs a held batch.

- `spawn_crewmate`'s shape gains `repairs_batch` (one tool description): true only on the one task the first mate starts to repair a project's held batch. The host records that task as the batch's repair, and the spawn's answer says it was recorded, or why not.
- The `batch-held` wake (a wake) asks for `repairs_batch` on the repair it asks for. When a repair is already recorded and open, the wake names its key and says to steer it with the pull request and version, and to start no other task.
- The same wake now says the Batches panel and Settings show who is repairing the hold, and that Settings keeps Try again and Send back with a reason, so the first mate still puts up no card about the hold.

The fixed context grows by one shape field's rule, about forty tokens.
