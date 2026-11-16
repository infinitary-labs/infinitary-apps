# Moving the first mate

A home can move its whole record to a paired computer that runs work (docs/devices.md, "Moving the first mate").
The welcome carries `homeNumber`, which home of its record this is: 1 until the first move, then one more at each.
A device that heard a higher number refuses a home with a lower one, so a first mate left behind by a move is never reached again.
A home from before says no number, which a device reads as 1.
The home sends every device the live frame `inf:home:moved` as a move finishes, with the new home's addresses, its number and which device it is.
A device from before ignores the frame and finds the new home by its announcement, since the new home shows the same key.
The orders `inf:home:ready`, `inf:home:receive`, `inf:home:arrive` and `inf:home:abandon` are asked of the computer the home moves to.
A home asks them only of a computer whose hello lists this change, and a computer from before is never offered as a destination.
If the computer the home moves to stays out of reach after the home stopped, a view may ask `inf:home-move:start-here`, which starts the first mate on the old home again at a home number above the one the move gave, so every device follows the old home and refuses the other computer.
The move's list of files names the sign-ins the old home had, and the new home asks for each one again, since the move copies none.
