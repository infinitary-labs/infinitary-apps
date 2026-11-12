A replay sends only the newest card list, and only the newest whole board with the board changes after it (`docs/connection.md`, "Catching up").
Each push a later whole list replaces goes as an empty push under its own number, on the new `inf:replaced` channel with a null payload.
A device on an older contract ignores that push, as it does any push on a channel it does not read, and its numbering stays whole.
The home also answers `reload` instead of `replay` when the replay would send more than a reload reads first; every device already reads its state again on a reload.
