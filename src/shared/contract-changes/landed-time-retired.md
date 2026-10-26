A task's delivery facts no longer carry `landedAt`, the time a close wrote and no client read; the close's `landedMode` and the task's `closedAt` stay.
An older home still sends it on a task it closed, and a newer view ignores it, as it ignores any field the file does not list.
An older view reads its absence as before, since the field was optional.
