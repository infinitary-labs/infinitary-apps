# The branch a working copy has checked out

`inf:working-copy:status` adds optional `checkedOut`: the branch the task's working copy has checked out, null when detached, and the commit it points at.
`inf:working-copy:bundle` adds optional `branch`: with ref `branch`, another branch of the working copy's repository to bundle in place of the task's own.
A crewmate on a computer that runs work can then prepare and open the story of an existing branch it checked out, as one on the home can.
The home sends `branch` only to a computer that lists `checked-out-branch`.
A computer without the change answers no `checkedOut`, so the home prepares and opens the task's own branch there, as before.
