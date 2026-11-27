# Run a held batch's checks with its declared fix before approval

The captain's approved plan for a held batch's fix: once the fix's story is confirmed on its own branch, the batch runs its own checks at the held version plus the fix; at the fix's approval a passed run at that same version merges that exact commit, otherwise the batch combines with the line as before; and changes waiting in line then wait for the project's batch gap.
The Firstmate's prompt and tools are unchanged, and it hears nothing new: the batch stays held while the run runs, so its `batch-held` wake and the repair it starts are as before.
A crewmate hears more: the new crewmate `batch-trial-failed` wake goes once to the fix's own crewmate, and to the batch's repair where that is another task, when the run fails; it names the fix's version, the held version, the run's commit and the failed checks.
Its one home is that wake.
`check_change`'s answers to a `batch.fix` declaration (`BATCH_DECLARATION_WORDS.fix` and `fixAndSentBack`) now say the batch runs its checks with the fix once its story is confirmed, and that a passed run approved at that version merges as it is.
The `batch-repair` skill says the same and that the repair reads those checks on the batch's pull request, never running the full set on a pull request of the fix's own.
The fixed context does not grow.
