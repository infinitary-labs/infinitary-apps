Adds an optional `noChecks` field to a project (`RepoView`): the record that the project runs no pull request checks, with when it was made and, when a crewmate made it, its task, version and evidence.
`inf:repos:configure` takes an optional `requireChecks`: false records that the project runs no checks, and true ends the record.
A `repo_configured` event takes an optional `said`: the saved words of a line about the record, made or ended.
A home without the change sends no `noChecks`, so a view shows the project as requiring checks, as that home treats it.
A home without the change reads the patch strictly, so it refuses a view's `requireChecks` with its reason and changes nothing.
A view without the change ignores `noChecks` and `said`, and shows the event's English description as before.
