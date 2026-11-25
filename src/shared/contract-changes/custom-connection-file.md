Adds `inf:accounts:custom:file` and `inf:accounts:custom:file:set`, which read and choose the connection file a computer reads custom connections from.
Adds the optional `file` and `compaction` fields to a custom connection's input and view, and the optional `input`, `statedReasoning` and `compaction` fields to its models.
An older side never asks for the file, sends none of these fields and shows every custom connection as typed in Settings.
A newer view against an older home finds no file to read, shows the Connection file row without one and still lists every custom connection.
