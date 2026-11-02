# Personal panels in frames

The `inf:plugins:personal` snapshot names every panel's compiled version in `frame`, the captain's own panels and drafts included, and sends `panel` as null.
A window draws each of the captain's own panels in a frame of its own from that version, and reaches its `server.ts` through the frame's `server.invoke` action.
The shape is unchanged: an older window reading `panel` draws no body for the captain's own panels from a newer home, and a newer window draws none from an older home, which sends `frame` as null for them.
