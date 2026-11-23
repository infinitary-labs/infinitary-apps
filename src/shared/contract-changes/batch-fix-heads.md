A project's batch record adds the optional `fixHeads`: the exact commit each declared fix's task had committed as it declared it, by task, kept as long as the declaration.
Another task's change approved at that commit carries the same declaration and joins the held batch as its fix.
An older side does not read it and shows the batch as before.
