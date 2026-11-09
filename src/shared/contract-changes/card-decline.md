A card action optionally carries `declines`, true on a choice that says no to every other one.
On every open decision by the first mate or a crewmate that is not a merge card and has no such choice, the core adds one more action, id `app-decline`, labeled "Decline", quiet, with `declines`, to the card it sends; the saved card never holds it.
A view presses it through the existing card choice request like any other action, and the core records it as the captain's answer "no to every choice".
The task record's `dismiss-question` keeps its id and now presses that way to say no, so the question closes as answered instead of dropped.
An older view draws Decline as one more ordinary button and ignores the new field.
A newer view with an older core draws no Decline, since the core never sends one.
