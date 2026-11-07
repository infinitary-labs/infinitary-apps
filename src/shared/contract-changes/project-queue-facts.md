A project's view optionally carries `queueWorkflows`, the workflow files on its default branch that mention its queue status, each with whether it is on, and `queueAnsweredAt`, when anything but the app last answered that status.
A new `repo_queue` event says a project's queue facts changed, so a view reads the project list again; it writes no feed line.
Settings shows a warning under "Where changes go" from these fields when a batched project's reads find nothing to answer its queue.
An older side ignores the fields and the event, and a newer window reading an older core shows no warning.
