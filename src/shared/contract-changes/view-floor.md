# A view says the oldest home it can change things on

A view's hello admits an optional `viewFloor`: the oldest home major it can still change things on, its own build's `VIEW_FLOOR` (docs/contract.md, "The version rule").
A home that reads it answers every request of a newer view whose floor reaches the home's major; a computer that runs work never says it.
An older home ignores the field and answers a newer view its reads only, as before.
A view that does not say it changes things on its home's major, and on a newer home from that home's floor, and reads only on an older home.
The version rule publishes `viewFloor` and `openLists`, the closed sets a view reads that a newer home may add to, each with what a view reads for a member it does not know.
