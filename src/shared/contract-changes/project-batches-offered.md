Adds an optional `batchesOffered` field to a project (`RepoView`): whether a runbook that is on at the home offers batched pull requests, so the project may newly choose them.
A home without the change sends no `batchesOffered`, so a view offers batched pull requests by the project's host alone, as before.
A view without the change ignores `batchesOffered` and still lists batched pull requests by host; a home with the change refuses that choice with its reason while no runbook that is on offers it.
