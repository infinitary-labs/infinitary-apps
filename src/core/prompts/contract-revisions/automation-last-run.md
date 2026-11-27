# The first mate reads each automation's last run and failing mark

INF-6925's session audit, finding 1 (the captain's "Start a task now to build it"): asked whether an automation had run, the first mate said none had reached it, because the list it reads carried no last run, and the run had come before its conversation restarted.
`automation-edit`'s current value in `app_state` now carries each rule's `lastFired` and, when an event rule's every look has failed, `failing`, from the record Settings → Automation reads (`automation.list`).
Its line now says what those two fields mean and names `app_state read automation.history` with the rule's id for its recent runs.
The fixed part does not grow: the line and its value are served only when `app_state` is read.

The ledger entry that comes with it:

INF-6925 finding 1. automation-edit's current value gains lastFired and failing, as Settings reads them, and its line names the automation.history read.
