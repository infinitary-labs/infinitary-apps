Adds an optional `started` field to each program in the `leftovers` answer of `inf:session:close`: the surviving program's birth as the system listed it at the close.
Adds an optional `keptInFile` field to that answer, true when the close kept what it could not finish in the task's folder there.
Adds the `inf:computer:left-behind` order, which a computer that runs work answers with what finished tasks left there: the stops their closes kept, without their commands, the programs that survived a close and still run with the same birth, their runs still in its heavy-run line, and every task whose close still keeps something there (`kept`).
A task whose close is still running its own cleanup is not yet finished there and appears in none of them but `kept`.
A home asks the order only of a computer that lists this change; a computer without it answers no list, and the home's notices name only what its own records hold.
A home without the change never asks the order and ignores the `started` field.
