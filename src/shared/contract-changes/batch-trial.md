A project's open batch adds the optional `trial`: the early run of a held batch's checks with its declared fix before the fix is approved, with the fix's task and version, the run's commit and members, its failed checks and any generated commit taken on it.
The batches view adds `checkingFix` on the open batch: the declared fix its checks run with before approval, until they fail.
An older side does not read either and shows the batch as held, as before.
