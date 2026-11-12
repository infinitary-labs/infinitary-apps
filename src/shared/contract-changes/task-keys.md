A new request, `inf:tasks:keys` (the read `tasks.keys`), answers the recorded tasks with exactly the given keys, live or closed at any age, in one read of the key index.
The window looks up every task key it draws that the board does not list with it, all of a turn's keys at once.
An older home refuses the request, so a window there falls back to one `inf:tasks:search` per key, which finds earlier work but not work closed this week.
