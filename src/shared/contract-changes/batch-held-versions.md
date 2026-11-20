A project's batch record adds the optional `held`: every version of its batch that held, newest first, kept while a declared fix is outstanding and otherwise until a batch merges or ends.
A change in line or in the open batch adds the optional `heldBase`: the held version a declared fix was verified to build on.
A project's batch record adds the optional `fixBases`: that verified version for each declared fix, by task, kept with the repair until a batch merges with the fix or its task closes.
The open batch adds the optional `awaits`: the repair task whose fix a held batch waits for after that repair sent changes back, or empty once that task closed first.
A held batch's declared fix built on one of those versions combines as its own difference from it.
An older side reads none of the three and shows the batch as before.
