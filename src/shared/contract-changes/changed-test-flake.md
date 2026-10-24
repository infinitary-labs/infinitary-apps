# changed-test-flake

`check_change`'s diagnosis takes an optional `changedTest`: whether the change adds or edits the failed test's own code (INF-840).
A home with this change refuses a suspected-flake diagnosis unless `changedTest` is false.
An older computer that runs work sends no `changedTest`, so its crewmate's suspected-flake diagnosis is refused with words that name the field.
An older home ignores the field.
