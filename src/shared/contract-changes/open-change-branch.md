# open_change from an existing branch

The open-change order's input adds an optional `branch`: an existing pushed branch the change opens from, instead of the task's own (INF-2184).
The home opens or updates that branch's pull request without moving its head, and the pull request becomes the task's current change (INF-2490).
A computer that runs work refuses `branch` in words until its home lists this change, because an older home would drop the field and open the task's own branch instead.
