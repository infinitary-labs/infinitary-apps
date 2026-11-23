# App offer replies

INF-6265's approved plan, piece 2: the captain expected every card to take a reply, and the cards the app raises itself (offers such as adding to the app, project setup, automation, devices and credits) took none.
Each card the host raises through `raiseHostCard` now names the first mate as its answerer, so a reply under it is a captain turn about the card, as on the stuck alert.
Its one home is the reply turn's context block: the `about:` line that named "the host's stuck alert" now says "the app's own card", names its task only when it has one, and adds that its buttons stay the captain's.
Words left in such a card's field at a button press reach the first mate on the existing app-carried choice wake, whose words are unchanged.
The fixed context does not grow.
