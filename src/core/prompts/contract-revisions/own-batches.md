# Batches of your own

The first piece of the captain's approved plan for batches of their own: on a batched project that carries no team queue, the app combines the captain's approved changes into one batch pull request, one commit for each change, and merges it once its checks pass.
The new `batch-held` wake owns the hold rule: a batch of several changes failed its checks, so the first mate starts one repair task with the batch-repair skill and no card, unless a task already repairs that batch, and puts up no card about the hold; Settings shows it with Try again and Send back with a reason.
A batch of one that fails wakes its own crewmate like any failed check, so the first mate hears nothing of it.
The batch-repair skill owns the repair procedure: account for every failed test against every change in the batch, then send back the changes at fault, fix forward with a change declared the batch's fix, or run the failed checks again for a flake that still gets an owner.
The `queue-offered` wake no longer offers to replace a project's own queue workflow with the shipped queue, and choosing batched pull requests for a project with no queue workflow asks for no plan: the choice applies at once.
A project that still carries the team queue's files keeps the `queue-paused`, `queue-plan-asked` and `queue-stalled` wakes as they are.
The wake costs about 200 tokens when it fires.
The `app_change` catalog adds `project-batch-answer`, an own-words action that tries a project's held batch again or sends changes back from it with the captain's reason, the same answer Settings sends; its line costs about 50 tokens of fixed context.
