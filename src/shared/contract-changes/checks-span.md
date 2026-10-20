# When a task's checks started and finished

A task's delivery facts carry an optional `ciStartedAt` and `ciFinishedAt`: when the host says the first check on the read version started, and when the checks finished - the last check's finish when they passed, the first failure's when they failed.
The checks cell reads them to say how long the checks have been running or took (`docs/forge.md`, "The checks cell's time").
An older side leaves them out, and the checks cell then shows the state word alone, with the last reading's time on rest.
