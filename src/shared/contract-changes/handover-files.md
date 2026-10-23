# A task hands files to another task

A crewmate's report may name files it hands on (INF-992, direction B).
On a computer that runs work, the report tool keeps verified copies there and sends each one home in order, a piece at a time, over the new `inf:work:handover-file` order before the report; the `inf:work:report` order's `declared` admits an optional `files`, each with its kept name, size and sha256, and the home refuses a report whose files it does not hold whole.
The `inf:session:source-file` order admits an optional `into: "handover"`, which keeps the file in the task's temporary folder's hand-over folder instead of its source cards, so it goes when the task closes.
A file's content is never logged or printed on either side; only its kept name, size and sha256 are named.
A computer that does not list this change is never sent a handed file: the first mate's steer is refused, saying that computer needs an update.
A crewmate on such a computer has no `files` on its report, and one whose home does not list the change is refused in plain words when it names files.
