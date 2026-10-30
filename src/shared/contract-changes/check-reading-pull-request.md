# Check readings name their pull request

A task's `checks` (`CheckSnapshot`, in the task's delivery view and the check-state pushes) gains an optional `prNumber`: the pull request the reading was of, as the reader named it.
The change record binds a reading to its change by that number rather than by its head alone.
An older side omits the field and reads the snapshot as before; a reading without it is bound as the record's compatibility rule says (`docs/saved-data-compatibility.md`, "The change record").
