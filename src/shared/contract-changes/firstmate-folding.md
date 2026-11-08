# First mate folding

Adds the optional `folding` to the `firstmate_state` event: true while the first mate shortens its conversation, false once it has, and absent when the event says nothing about it.
An older side never sends it, so a view treats its absence as not shortening, and an older view ignores the field and shows the turn as before.
