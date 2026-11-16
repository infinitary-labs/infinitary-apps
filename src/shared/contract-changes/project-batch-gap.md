# A batched project's batch gap

Adds an optional `batchGap` field to a project (`RepoView`): the least time in whole minutes from one of this person's batches starting to the next.
`inf:repos:configure` takes an optional `batchGap`: a whole number of minutes, or null to start a batch as soon as a change is approved.
A batch record (`BatchRecord`) takes an optional `formed`: when the project's last batch formed from the line.
A home without the change sends no `batchGap`, so a view shows the project starting a batch as soon as a change is approved, as that home does.
A home without the change reads the patch strictly, so it refuses a view's `batchGap` with its reason and changes nothing.
A view without the change ignores `batchGap` and `formed`.
