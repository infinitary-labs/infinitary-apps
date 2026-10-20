# A hand-started run's checks on a task

A task's delivery facts carry an optional `runChecks`: the newest workflow run the task started outside a pull request and the app watched, with its state, when the host says it started and finished, and when the app read it.
The checks cell reads it while the task has no change, to say how long the run has been going or took (`docs/forge.md`, "The checks cell's time").
An older side leaves it out, and a task with no change then shows no checks cell.
