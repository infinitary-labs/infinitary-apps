# Card seen snapshot

Card snapshots add an optional `seen` boolean, derived from the card owner's durable seen observations for the current lifecycle.
The desktop stack uses it on its initial snapshot to restore unread cards without treating them as new arrivals.
An older home omits it and the window keeps its prior initial-snapshot behavior; an older window ignores it.
