# Copies that reach each other

Every computer that keeps a copy of a home's record reaches the other computers that keep one, home or no home (docs/devices.md, "Copies that reach each other").
The answer to `inf:standby:hello` adds `listens`, where the computer listens for the other copies, which the home keeps in the record beside each named computer.
A home asks `inf:standby:peers` of a computer that keeps a copy, to hear whether it reaches each other copy, and shows it on that computer's Ready to take over list.
Two copies keep one link on `/copies`, pinned to each side's own key, and either may ask the other `inf:copy:where`.
A computer from before sends no `listens` and answers no `inf:standby:peers`: Settings, Devices says it needs an update to reach the other copies, and a home from before keeps no `listens`, so its copies never reach each other.
