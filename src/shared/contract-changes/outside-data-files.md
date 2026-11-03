# Files from outside in a task's hand-over folder

`inf:session:delete-outside` gains an optional `files` field: the kept names of files from outside, such as a saved Gmail attachment, that are due in the task's hand-over folder there.
A computer with the change removes each named file from that folder before it reads the conversation, whatever its conversation is doing.
An older computer would ignore the field, so the home saves no file from outside into a task's folder on a computer that does not list this change, and asks it to update first.
