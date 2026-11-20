# A project can be recorded as running no pull request checks

INF-2114, from the captain's "Approve and build" on its plan: a project with no checks becomes a recorded fact, so its changes are not watched for two hours and their merge cards go up at once.
`app_change project-settings` gains `requireChecks`: false records that the project runs no pull request checks, and true ends that record.
The project's current state reads as `requireChecks` in its settings value.
The captain makes the same change with Settings → Projects' Require pull request checks switch, and a crewmate's absence declaration for its own change can record it with its evidence.
The first check that runs on one of the project's changes ends the record, with one Activity line naming that check.
The words live in the project-settings action line, its one home; the fixed part grows by about 20 tokens by the app's count.

The ledger entry that comes with it:

INF-2114. app_change project-settings gains requireChecks: false records that the project runs no pull request checks, true ends the record; the first check that runs ends it too.
