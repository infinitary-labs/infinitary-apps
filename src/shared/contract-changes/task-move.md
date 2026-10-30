# Moving a started task

A home may move a started task between itself and a computer that runs work (docs/helper.md, "Moving a started task").
It adds two orders: `inf:working-copy:move-out`, which packs a task's work for the move, and `inf:working-copy:move-in`, which makes the working copy of a task that moves to that computer.
`inf:working-copy:read` reads the pack with the new ref `move`.
A move-out may name ignored files to carry (`keep`), and a move-in names its project by where it lives (`origin`) or, for a project the home keeps on itself or clones from a folder, by its id (`local`) with the home's branch and the commit the task's branch left it at (`base`).
The record's Move to a computer reads `inf:task:move-options` and writes `inf:task:move`, and a task view carries `movable` and `computerMove`.
A home sends none of these orders to a computer that does not list this change, and offers no move to or from it; an older view draws no Move to a computer.
