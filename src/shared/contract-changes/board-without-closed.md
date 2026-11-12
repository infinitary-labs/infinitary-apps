`inf:tasks:board` takes an optional `{ closed: false }`, which reads the board without its closed rows, and such a board carries the optional `closedLeftOut`, the ids of the rows it left out that Tasks lists under Done.
It keeps every open, active and pinned row, the closed parts of live work, the task of each card on the stack, every closed row Tasks lists outside Done, and the parents of every row it keeps.
A view asks it as its first board read once the home lists this change, and reads the whole board when it needs the closed rows; pushes and deltas are unchanged.
An older home refuses the argument, so a view asks it only of a home that lists the change, and an older view never sends it and reads the whole board as before.
