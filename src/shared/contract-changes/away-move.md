# Moving a task off a computer out of reach

A started task can move off a computer that runs work while that computer is out of reach, from the commit of its branch the home holds (docs/helper.md, "Moving a task off a computer that is out of reach").
`inf:task:move-options` answers `leftBehind`, one line saying what stays behind, when the computer the task runs on is out of reach.
A task's `computerMove` carries `leftBehind` and `toId` while a waiting move's computer is out of reach, so a view can offer to move without it.
`inf:task:move` takes an optional third element, `{ leaveBehind: true }`, which makes that move; without it the home refuses and says what stays behind.
A home from before answers no `leftBehind`, so a view never sends the third element to it; a view from before never sees the choice and moves only between computers in reach.
