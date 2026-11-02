# Saving work before an update

An update status may carry `work`, what the crew's work is doing around this computer's own update: `saving` with the tasks whose running work it waits for, or `resuming` with the tasks whose work has not started again (`docs/alpha.md`, "Saving work before an update").
A failed install result may carry `later: true` when the person chose Update later while the work was saved, so nothing went wrong.
The local app accepts `inf:update:later`, which lets an update go while it saves the crew's work and answers the update status.
An older client never shows `work` or asks `inf:update:later`, and a controlling Mac answers it for its own installation rather than forwarding it to its home.
