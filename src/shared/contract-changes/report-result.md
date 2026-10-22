# A report carries a typed result

The `inf:work:report` order's `declared` admits an optional `result`, a JSON object: the typed result a crewmate on a computer that runs work passes to the report tool (INF-799 piece 1).
The home checks it against the task's declared result shape and refuses a report whose result is missing or does not fit, naming the first failing field, as it does for a crewmate on the home itself.
An older home drops the field, so a crewmate there reports as before and its task's result shape, which that home never stored, checks nothing.
A computer that does not list this change never sends it, so the home does not start a task with a result shape there and says that computer must be updated (`CrewMachines.takesResults`).
