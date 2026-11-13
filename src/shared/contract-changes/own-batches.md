A project's view optionally carries `batch`, the local record of the captain's own batches in that project: the approved changes in line, the one open batch with its pull request and any hold, each merged change's receipt, the changes the last combine left out and the merges the project allows.
A new request, `inf:repos:batch-answer`, answers a held batch from Settings: try it again, or send changes back, each with its reason.
The `check_change` order optionally carries `batch`, a repair's answer to a held batch: its own change declared the batch's fix, or the changes at fault sent back with their reasons.
An older side ignores the field and shows no batch, an older home refuses the request, and an older home ignores a repair's `batch` and reads the task's own checks instead.
