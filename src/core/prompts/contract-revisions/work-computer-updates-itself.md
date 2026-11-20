# A work computer updates itself

INF-2115, started from the captain's "Start it now" for automatic updates on INF-5142's card, has the app update a computer that runs work by itself when it connects on an older version than the home's, with no card to click.
The app raises its own update card only when it cannot do that alone: an update that asks a password there, one that did not go through, a computer too old to take the update order, a Windows PC, and a gap the captain answered Not now for.
The `device-update` catalog line, which the first mate reads through `app_state`, now says the app updates an older computer by itself as it connects and raises the same card when it cannot, in place of saying it raises the card for every older one.
The offer card that action writes no longer says "Only your click can update it.", since the app now updates a computer without one.
No tool description, parameter or served prompt changes, so the fixed context is unchanged: the line reaches the Firstmate only through `app_state`.
