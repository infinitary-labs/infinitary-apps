A project's view optionally carries `queuePendingAt`, when batched pull requests was chosen while the project's reads found nothing to answer its queue: the choice waits, and the project keeps its delivery until a workflow that mentions the queue status merges.
Two new card host operations, `plan-queue` and `keep-delivery`, answer the app's card for such a choice: ask the first mate to plan the workflow, or stop waiting.
An older side ignores the field, and an older window shows the project's delivery without the waiting line.
